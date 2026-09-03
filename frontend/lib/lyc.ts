import { ethers } from "ethers";
import { DeployedAddresses } from "./chain";
import { allFactories, fetchCollateralPriceUsd, fetchLaunchAddresses, getLyc, getLaunch, protectLaunch, WAD } from "./launchpad";
import { assertWalletSeesApp, getProvider, withActiveSigner } from "./activeSigner";
import { sendReplacing, walletTxOverrides } from "./txFees";

/// The senior book as a whole. These are the figures LEVERA.md §14 says the LYC page must show, so
/// that "price up" is never mistaken for yield when it is really a fee mint bringing its own
/// assets along.
export type LycGlobal = {
  nav: bigint;
  liability: bigint;
  idleUsdg: bigint;
  totalAssetsUsd: bigint;
  /// Collateral backing the book, in USD across every listed asset.
  totalCollateralUsd: bigint;
  globalCr: bigint;
  supply: bigint;
  depositMinted: bigint;
  feeMinted: bigint;
  utilization: bigint;
  fundingRate: bigint;
  ethDropToImpairment: bigint;
  /// Occupancy rent 2x memes have paid (no cash in — junior NAV down, LYC NAV up).
  /// Settled on-chain only. Pending rent is `occupancyPendingUsd` and is NOT in `nav`.
  occupancyUsd: bigint;
  /// Timestamp-index rent not yet written. Informational; redeem settles it on-chain first.
  occupancyPendingUsd: bigint;
  /// Pairing bps + harvested holder-fee slice (cash in, LYC NAV up).
  cashYieldUsd: bigint;
  /// Read live off the contract rather than hardcoded -- REDEEM_FEE_BPS and COVERED_CR_WAD are
  /// both `public constant`s on EarnPool.sol, and this quote preview drifting silently out of
  /// sync with an on-chain constant is exactly the bug class this pair used to be: the fee here
  /// was hardcoded at 10 bps after the contract moved to 25, and the "covered" cutoff was a bare
  /// `> WAD` after the contract added a 50 bps tolerance band. Both drifted wrong, silently.
  redeemFeeBps: bigint;
  coveredCrWad: bigint;
};

/// One holder's position. Issuance is instant: what you hold is what you own and can exit.
export type LycPosition = {
  /// Whose position this is -- the connected wallet.
  address: string;
  balance: bigint;
  locked: bigint;
  unlocked: bigint;
  maxRedeemable: bigint;
};

export async function fetchLycGlobal(addresses: DeployedAddresses): Promise<LycGlobal> {
  const h = getLyc(addresses.lyc);
  const [
    nav,
    liability,
    idleUsdg,
    totalAssetsUsd,
    totalCollateralUsd,
    globalCr,
    supply,
    depositMinted,
    feeMinted,
    utilization,
    fundingRate,
    ethDropToImpairment,
    occupancyUsd,
    cashYieldUsd,
    redeemFeeBps,
    coveredCrWad,
  ] = await Promise.all([
    h.nav() as Promise<bigint>,
    h.liability() as Promise<bigint>,
    h.idleUsdg() as Promise<bigint>,
    h.totalAssetsUsd() as Promise<bigint>,
    h.totalCollateralUsd() as Promise<bigint>,
    h.globalCr() as Promise<bigint>,
    h.totalSupply() as Promise<bigint>,
    h.totalDepositMinted() as Promise<bigint>,
    h.totalFeeMinted() as Promise<bigint>,
    h.utilizationWad() as Promise<bigint>,
    h.fundingRateWad() as Promise<bigint>,
    h.ethDropToImpairmentWad() as Promise<bigint>,
    h.totalOccupancyUsd() as Promise<bigint>,
    h.totalCashYieldUsd() as Promise<bigint>,
    h.REDEEM_FEE_BPS() as Promise<bigint>,
    h.COVERED_CR_WAD() as Promise<bigint>,
  ]);
  const pending = await pendingOccupancyUsd(allFactories(addresses), fundingRate);
  // NAV / liability / CR are the on-chain figures redeem pays. Folding pending occupancy into
  // them made the page print a higher price than `nav()`, and that extra vanished if junior
  // dumped before a keeper settle (76 occupancy-display drops in data/financial.csv).
  return {
    nav,
    liability,
    idleUsdg,
    totalAssetsUsd,
    totalCollateralUsd,
    globalCr,
    supply,
    depositMinted,
    feeMinted,
    utilization,
    fundingRate,
    ethDropToImpairment,
    occupancyUsd,
    occupancyPendingUsd: pending,
    cashYieldUsd,
    redeemFeeBps,
    coveredCrWad,
  };
}

const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const UPPER_L = 25n * 10n ** 17n;

/// Occupancy is a timestamp index. Storage omits rent until a pool is touched. Reported
/// separately from NAV so a pending figure cannot print a price redeem will not pay.
export async function pendingOccupancyUsd(factories: string[], fundingRate: bigint): Promise<bigint> {
  if (fundingRate === 0n) return 0n;
  const addrs = (await Promise.all(factories.map((f) => fetchLaunchAddresses(f)))).flat();
  const block = await getProvider().getBlock("latest");
  const now = BigInt(block?.timestamp ?? 0);
  let sum = 0n;
  for (const a of addrs) {
    const l = getLaunch(a, getProvider());
    try {
      const [paired, lastAccrued, senior, lev, nav] = await Promise.all([
        l.paired() as Promise<boolean>,
        l.lastAccrued() as Promise<bigint>,
        l.seniorUsd() as Promise<bigint>,
        l.leverageWad() as Promise<bigint>,
        l.memeNAV() as Promise<bigint>,
      ]);
      if (!paired || lev >= UPPER_L || senior === 0n) continue;
      const dt = now > lastAccrued ? now - lastAccrued : 0n;
      if (dt === 0n) continue;
      let owed = (senior * fundingRate * dt) / (WAD * SECONDS_PER_YEAR);
      if (owed > nav) owed = nav;
      sum += owed;
    } catch {
      // skip a broken clone
    }
  }
  return sum;
}

export async function fetchLycPosition(
  addresses: DeployedAddresses,
  holder: string
): Promise<LycPosition> {
  const who = holder;
  const h = getLyc(addresses.lyc);
  const [balance, locked, unlocked, maxRedeemable] = await Promise.all([
    h.balanceOf(who) as Promise<bigint>,
    h.lockedBalanceOf(who) as Promise<bigint>,
    h.unlockedBalanceOf(who) as Promise<bigint>,
    h.maxRedeemableShares(who) as Promise<bigint>,
  ]);
  return { address: who, balance, locked, unlocked, maxRedeemable };
}

const ERC20_ABI = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

/// Mint LYC with USDG. Instant and 1:1-backed: a dollar of claim against a dollar of cash.
async function ensureUsdgAllowance(addresses: DeployedAddresses, owner: string, amount: bigint, signer: ethers.Signer) {
  const cash = new ethers.Contract(addresses.usdg, ERC20_ABI, getProvider());
  const allowance: bigint = await cash.allowance(owner, addresses.lyc);
  if (allowance >= amount) return;
  const provider = getProvider();
  try {
    await provider.send("anvil_impersonateAccount", [owner]);
    const imp = new ethers.JsonRpcSigner(provider, owner);
    const tx = await new ethers.Contract(addresses.usdg, ERC20_ABI, imp).approve(
      addresses.lyc,
      ethers.MaxUint256,
      { gasLimit: 200_000n },
    );
    await tx.wait();
    await provider.send("anvil_stopImpersonatingAccount", [owner]);
  } catch {
    const cashSigner = new ethers.Contract(addresses.usdg, ERC20_ABI, signer);
    await (await cashSigner.approve(addresses.lyc, ethers.MaxUint256, await walletTxOverrides(owner, 200_000n))).wait();
  }
}

export async function mintWithUsdg(addresses: DeployedAddresses, usdAmount: bigint) {
  await assertWalletSeesApp(addresses.factory);
  return withActiveSigner(async ({ signer, address }) => {
    await ensureUsdgAllowance(addresses, address, usdAmount, signer);
    const h = getLyc(addresses.lyc, signer);
    const g = await fetchLycGlobal(addresses);
    const sharesMinted = quoteMint(g, usdAmount);
    const receipt = await (await sendReplacing(address, (o) => h.mintWithUsdg(usdAmount, o), 2_000_000n)).wait();
    const { logLycMint } = await import("./sessionLog");
    logLycMint({
      shares: sharesMinted.toString(),
      usdValue: usdAmount.toString(),
      paidInEth: false,
    }).catch(() => {});
    return receipt;
  });
}

/// Mint LYC with ETH. The protocol sells it for cash in the same transaction, so what backs the
/// shares is dollars from the moment they exist -- there is no window where a dollar claim is
/// sitting on collateral that can move against it.
export async function mintWithEth(addresses: DeployedAddresses, ethAmount: bigint) {
  await assertWalletSeesApp(addresses.factory);
  return withActiveSigner(async ({ signer, address }) => {
    const h = getLyc(addresses.lyc, signer);
    const g = await fetchLycGlobal(addresses);
    const ethPrice = await fetchCollateralPriceUsd(addresses.oracle);
    const usdValue = (ethAmount * ethPrice) / WAD;
    const sharesMinted = quoteMint(g, usdValue);
    const receipt = await (await sendReplacing(address, (o) => h.mintWithEth({ value: ethAmount, ...o }), 2_000_000n)).wait();
    const { logLycMint } = await import("./sessionLog");
    logLycMint({
      shares: sharesMinted.toString(),
      usdValue: usdValue.toString(),
      paidInEth: true,
    }).catch(() => {});
    return receipt;
  });
}

/// Mint LYC with a listed collateral ERC-20 directly -- cbBTC today, whatever the pool lists
/// tomorrow. `tokenUsdPriceWad` is that collateral's own oracle mark: the pool values the deposit
/// off the collateral's registry entry on-chain, and the caller prices it with the same feed for
/// the share estimate and the ledger. The sell-for-cash happens inside the same transaction, so
/// shares are dollar-backed on arrival exactly as with ETH.
export async function mintWithCollateral(
  addresses: DeployedAddresses,
  token: string,
  amount: bigint,
  tokenUsdPriceWad: bigint
) {
  await assertWalletSeesApp(addresses.factory);
  return withActiveSigner(async ({ signer, address }) => {
    const q = new ethers.Contract(token, ERC20_ABI, signer);
    const allowance: bigint = await q.allowance(address, addresses.lyc);
    if (allowance < amount) {
      await (await q.approve(addresses.lyc, ethers.MaxUint256, await walletTxOverrides(address, 200_000n))).wait();
    }
    const h = getLyc(addresses.lyc, signer);
    const g = await fetchLycGlobal(addresses);
    const usdValue = (amount * tokenUsdPriceWad) / WAD;
    const sharesMinted = quoteMint(g, usdValue);
    const receipt = await (await sendReplacing(address, (o) => h.mintWithCollateral(token, amount, o), 2_000_000n)).wait();
    const { logLycMint } = await import("./sessionLog");
    logLycMint({
      shares: sharesMinted.toString(),
      usdValue: usdValue.toString(),
      paidInEth: false,
    }).catch(() => {});
    return receipt;
  });
}

/// Quietest 2x pools first. That is the on-chain peel order redeemTo enforces.
export async function fetchPeelOrder(addresses: DeployedAddresses): Promise<string[]> {
  const addrs = (await Promise.all(allFactories(addresses).map((f) => fetchLaunchAddresses(f)))).flat();
  const rows: { addr: string; vol: bigint }[] = [];
  for (const a of addrs) {
    const launch = getLaunch(a, getProvider());
    const [enabled, senior, vol] = await Promise.all([
      launch.leverageEnabled() as Promise<boolean>,
      launch.seniorUsd() as Promise<bigint>,
      launch.recentVolumeUsd() as Promise<bigint>,
    ]);
    if (enabled && senior > 0n) rows.push({ addr: a, vol });
  }
  rows.sort((x, y) => (x.vol < y.vol ? -1 : x.vol > y.vol ? 1 : 0));
  return rows.map((r) => r.addr);
}

export async function estimatePeelCapacityUsd(addresses: DeployedAddresses): Promise<bigint> {
  const peelFrom = await fetchPeelOrder(addresses);
  const price = await fetchCollateralPriceUsd(addresses.oracle);
  let cap = 0n;
  for (const a of peelFrom) {
    const vault: bigint = await getLaunch(a, getProvider()).vaultEth();
    cap += (vault * 1500n * price) / (10_000n * WAD);
  }
  return cap;
}

/// Occupancy APR → APY, treating the per-second index as continuous.
export function fundingApyFromApr(aprWad: bigint): number {
  const r = Number(aprWad) / 1e18;
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.exp(r) - 1;
}

/// Redeem, in one call, with no swap anywhere in the path.
///
/// The exit pays idle cash first and then WETH peeled straight out of the quietest 2x pools. It
/// does not convert anything on the holder's behalf, and that is the whole point: the moment a
/// redemption has to route through a venue, a holder's access to their own money depends on a fill
/// they never asked for, at a size they did not choose, and a bad book leaves them with neither the
/// cash nor the collateral. There is nothing here that can fail on liquidity, so there is nothing
/// to chunk around either.
///
/// Anyone who wants a specific token converts it themselves afterwards -- their transaction, their
/// slippage tolerance, and a failed conversion costs a retry instead of trapping the withdrawal.
export async function redeemLyc(addresses: DeployedAddresses, shares: bigint) {
  await assertWalletSeesApp(addresses.factory);
  const peelFrom = await fetchPeelOrder(addresses);
  const { logError, logLycRedeem } = await import("./sessionLog");
  return withActiveSigner(async ({ signer, address }) => {
    const h = getLyc(addresses.lyc, signer);
    try {
      const tx = await sendReplacing(
        address,
        (overrides) => h.redeemInKind(shares, peelFrom, overrides),
        8_000_000n,
      );
      const receipt = await tx.wait();
      const q = quoteRedeem(await fetchLycGlobal(addresses), shares);
      logLycRedeem({
        kind: "in-kind",
        shares: shares.toString(),
        usdOut: q.usdOut.toString(),
        peeled: peelFrom,
      }).catch(() => {});
      return receipt;
    } catch (e) {
      logError("earn pool redeem", e).catch(() => {});
      throw e;
    }
  });
}

/// Sell ETH out of stretched paired pools (L ≥ 2.5x) back into idle USDG so redeem can pay.
export async function freeIdleCash(addresses: DeployedAddresses): Promise<number> {
  const addrs = (await Promise.all(allFactories(addresses).map((f) => fetchLaunchAddresses(f)))).flat();
  let n = 0;
  for (const addr of addrs) {
    try {
      const launch = getLaunch(addr, getProvider());
      const [paired, lev] = (await Promise.all([launch.paired(), launch.leverageWad()])) as [boolean, bigint];
      if (paired && lev >= 25n * 10n ** 17n) {
        await protectLaunch(addr);
        n++;
      }
    } catch {
      // in-band or swap failed — skip
    }
  }
  return n;
}

/// What a deposit mints right now, at the prevailing NAV.
export function quoteMint(g: LycGlobal, usdIn: bigint): bigint {
  if (usdIn <= 0n || g.nav === 0n) return 0n;
  return (usdIn * WAD) / g.nav;
}

/// What a redemption would pay right now. Mirrors the contract exactly, including the branch:
/// covered books pay nav less the redeem fee, impaired books pay pro-rata on all assets with no
/// fee at all. "Covered" itself has a tolerance band (coveredCrWad, not a bare > WAD) so routine
/// stablecoin noise -- USDG at $0.9998 on an ordinary day -- doesn't read as impairment; see
/// EarnPool.COVERED_CR_WAD's own doc comment.
export function quoteRedeem(g: LycGlobal, shares: bigint): { usdOut: bigint; covered: boolean } {
  if (shares <= 0n || g.supply === 0n) return { usdOut: 0n, covered: true };
  const covered = g.globalCr > g.coveredCrWad;
  if (covered) {
    const net = shares - (shares * g.redeemFeeBps) / 10_000n;
    return { usdOut: (net * g.nav) / WAD, covered };
  }
  return { usdOut: (shares * g.totalAssetsUsd) / g.supply, covered };
}

export function parseEthInput(value: string): bigint {
  try {
    return ethers.parseEther((value || "0").replace(/,/g, "").trim());
  } catch {
    return 0n;
  }
}

/// FIFO lot for tracking cost basis
export type LycLot = {
  shares: bigint;
  costPerShare: bigint; // in USD (WAD)
  timestamp: number;
};

/// Transaction record for LYC history
export type LycTx = {
  type: "mint" | "redeem";
  shares: bigint;
  valueUsd: bigint;
  navAtTime: bigint;
  timestamp: number;
  txHash: string;
};

/// PnL result from FIFO calculation
export type LycPnl = {
  realizedPnl: bigint;
  unrealizedPnl: bigint;
  totalInvested: bigint;
  avgCostBasis: bigint;
  lots: LycLot[];
  history: LycTx[];
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/// Fetch LYC Transfer events for a user and compute FIFO PnL
export async function fetchLycPnl(
  addresses: DeployedAddresses,
  holder: string,
  currentNav: bigint
): Promise<LycPnl> {
  const h = getLyc(addresses.lyc);
  const provider = getProvider();

  // Fetch Transfer events: mints (from zero address) and burns (to zero address)
  const filter = h.filters.Transfer(null, null, null);
  const fromFilter = h.filters.Transfer(ZERO_ADDRESS, holder, null);
  const toFilter = h.filters.Transfer(holder, ZERO_ADDRESS, null);

  const [mintEvents, redeemEvents] = await Promise.all([
    h.queryFilter(fromFilter, 0) as Promise<ethers.EventLog[]>,
    h.queryFilter(toFilter, 0) as Promise<ethers.EventLog[]>,
  ]);

  // Combine and sort by block number
  const txs: LycTx[] = [];

  for (const e of mintEvents) {
    const block = await provider.getBlock(e.blockNumber);
    const shares = e.args[2] as bigint;
    // NAV at mint time: we use the share value. For mints, the user paid NAV per share.
    // We can't know exact NAV at past time easily, so we approximate with $1 for deposits
    // and use the value for fee mints. For simplicity, track the shares and current NAV.
    txs.push({
      type: "mint",
      shares,
      valueUsd: shares, // 1:1 at mint (USDG or ETH converted)
      navAtTime: WAD, // minted at $1
      timestamp: block?.timestamp ?? 0,
      txHash: e.transactionHash,
    });
  }

  for (const e of redeemEvents) {
    const block = await provider.getBlock(e.blockNumber);
    const shares = e.args[2] as bigint;
    txs.push({
      type: "redeem",
      shares,
      valueUsd: 0n, // will be computed from FIFO
      navAtTime: currentNav,
      timestamp: block?.timestamp ?? 0,
      txHash: e.transactionHash,
    });
  }

  txs.sort((a, b) => a.timestamp - b.timestamp);

  // FIFO calculation
  const lots: LycLot[] = [];
  let realizedPnl = 0n;
  let totalInvested = 0n;
  let totalSharesRedeemed = 0n;
  let totalCostRedeemed = 0n;

  for (const tx of txs) {
    if (tx.type === "mint") {
      lots.push({
        shares: tx.shares,
        costPerShare: WAD, // $1 per share at mint
        timestamp: tx.timestamp,
      });
      totalInvested += tx.shares; // shares * $1
    } else {
      // Redeem: consume oldest lots first
      let remaining = tx.shares;
      const redeemValue = (tx.shares * currentNav) / WAD;

      while (remaining > 0n && lots.length > 0) {
        const lot = lots[0];
        const take = remaining > lot.shares ? lot.shares : remaining;
        const cost = (take * lot.costPerShare) / WAD;
        const proceeds = (take * currentNav) / WAD;
        realizedPnl += proceeds - cost;
        totalCostRedeemed += cost;
        totalSharesRedeemed += take;

        lot.shares -= take;
        remaining -= take;
        if (lot.shares === 0n) lots.shift();
      }
    }
  }

  // Unrealized PnL = current value - remaining cost basis
  const remainingShares = lots.reduce((sum, l) => sum + l.shares, 0n);
  const currentValue = (remainingShares * currentNav) / WAD;
  const remainingCost = lots.reduce((sum, l) => sum + (l.shares * l.costPerShare) / WAD, 0n);
  const unrealizedPnl = currentValue - remainingCost;

  const avgCostBasis = totalSharesRedeemed > 0n
    ? (totalCostRedeemed * WAD) / totalSharesRedeemed
    : WAD;

  return {
    realizedPnl,
    unrealizedPnl,
    totalInvested,
    avgCostBasis,
    lots,
    history: txs,
  };
}
