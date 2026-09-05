import { ethers } from "ethers";
import { DeployedAddresses } from "./chain";
import { allFactories, fetchCollateralPriceUsd, fetchLaunchAddresses, getLyc, getLaunch, protectLaunch, WAD } from "./launchpad";
import { assertWalletSeesApp, getProvider, withActiveSigner } from "./activeSigner";
import { sendReplacing, walletTxOverrides } from "./txFees";
import { readEthUsdWad } from "./oracle";
import { EarnPoolAbi } from "./artifacts/EarnPool";
import { OracleSwapRouterAbi } from "./artifacts/OracleSwapRouter";
import { MockWETHAbi } from "./artifacts/MockWETH";

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
  /// Entry fee for mints (public constant on EarnPool, read live — same drift-guard as the
  /// redeem fee above).
  mintFeeBps: bigint;
  /// Idle cash + pool vaults, EXCLUDING the meme AMM reserves. This — not totalAssetsUsd — is
  /// the base an impaired (uncovered) mint prices at, mirroring `_issue` exactly.
  seniorBackedAssetsUsd: bigint;
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
    mintFeeBps,
    seniorBackedAssetsUsd,
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
    h.MINT_FEE_BPS() as Promise<bigint>,
    h.seniorBackedAssetsUsd() as Promise<bigint>,
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
    mintFeeBps,
    seniorBackedAssetsUsd,
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
    const h = getLyc(addresses.lyc, signer);
    const allowance: bigint = await new ethers.Contract(addresses.usdg, ERC20_ABI, signer).allowance(address, addresses.lyc);
    const g = await fetchLycGlobal(addresses);
    const sharesMinted = quoteMint(g, usdAmount);

    // Permit path: USDG speaks EIP-2612 and the pool has a permit-consuming mint, so a short
    // allowance costs ONE typed-data signature inside the mint tx — no approve tx first.
    if (allowance < usdAmount && (await tokenSupportsPermit(addresses.usdg, signer.provider!))) {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      const sig = await signEip2612(signer, addresses.usdg, addresses.lyc, usdAmount, deadline);
      const { v, r, s } = ethers.Signature.from(sig);
      const receipt = await (
        await sendReplacing(
          address,
          (o) =>
            h
              .getFunction("mintWithUsdgPermit(uint256,uint256,uint8,bytes32,bytes32)")(
                usdAmount, deadline, v, r, s, o,
              ),
          2_000_000n,
        )
      ).wait();
      const { logLycMint } = await import("./sessionLog");
      logLycMint({ shares: sharesMinted.toString(), usdValue: usdAmount.toString(), paidInEth: false }).catch(() => {});
      return receipt;
    }

    await ensureUsdgAllowance(addresses, address, usdAmount, signer);
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
    // Explicit overload pin for the same reason as mintWithCollateral above: mintWithEth has a
    // () and an (address) shape, and the explicit () form keeps the overrides-only call
    // unambiguous no matter how the resolver weighs the object.
    const receipt = await (await sendReplacing(address, (o) => h.getFunction("mintWithEth()")({ value: ethAmount, ...o }), 2_000_000n)).wait();
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
///
/// `decimals` defaults to 18 (WETH). Pass the token's own decimals for anything else -- 8 for
/// cbBTC -- so a raw non-18-decimal `amount` gets lifted to WAD terms before it meets a WAD price;
/// skipping this is what made cbBTC mint estimates round to zero.
export async function mintWithCollateral(
  addresses: DeployedAddresses,
  token: string,
  amount: bigint,
  tokenUsdPriceWad: bigint,
  decimals: number = 18
) {
  await assertWalletSeesApp(addresses.factory);
  return withActiveSigner(async ({ signer, address }) => {
    const h = getLyc(addresses.lyc, signer);
    const q = new ethers.Contract(token, ERC20_ABI, signer);
    const allowance: bigint = await q.allowance(address, addresses.lyc);
    const usdValue = (amount * 10n ** BigInt(18 - decimals) * tokenUsdPriceWad) / WAD;
    const g = await fetchLycGlobal(addresses);
    const sharesMinted = quoteMint(g, usdValue);

    // Permit path when the token speaks EIP-2612 and the allowance is short: ONE typed-data
    // signature authorizes EXACTLY this deposit inside the mint transaction — no approve tx,
    // and nothing left open for the app to pull later (a deposit is a one-off, not a standing
    // spending relationship, so the permit covers the amount and nothing more).
    if (allowance < amount && (await tokenSupportsPermit(token, signer.provider!))) {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      const sig = await signEip2612(signer, token, addresses.lyc, amount, deadline);
      const { v, r, s } = ethers.Signature.from(sig);
      const receipt = await (
        await sendReplacing(
          address,
          (o) =>
            h
              // Signature MUST match the contract's parameter list exactly — (token, amount,
              // pairPool, deadline, v, r, s). An extra address here resolved against nothing and
              // ethers threw "no matching function" before the tx was ever built.
              .getFunction("mintWithCollateralPermit(address,uint256,address,uint256,uint8,bytes32,bytes32)")(
                token, amount, ethers.ZeroAddress, deadline, v, r, s, o,
              ),
          2_500_000n,
        )
      ).wait();
      const { logLycMint } = await import("./sessionLog");
      logLycMint({ shares: sharesMinted.toString(), usdValue: usdValue.toString(), paidInEth: false }).catch(() => {});
      return receipt;
    }

    // Fallback path: token has no EIP-2612 — approve (max, the standing-allowance tradeoff the
    // permit path avoids) then the ordinary mint. The approve is not optional here: the mint
    // pulls the collateral with safeTransferFrom, and without it the tx just reverts on-chain
    // (this is what made cbBTC mints fail after a fresh faucet claim). Pin the explicit
    // overload: the full EarnPool ABI carries BOTH mintWithCollateral shapes —
    // (address,uint256) and (address,uint256,address pairPool) — and ethers v6's resolver throws
    // "ambiguous function description" when an overrides object rides along with an overloaded
    // call unless the signature is spelled out. The earn page means a PLAIN deposit (no
    // eager-pair pool), which is the 2-arg shape: on-chain that passes pairPool = address(0),
    // and the contract skips the eager-pair path on its own.
    if (allowance < amount) {
      const approve = await (await q.approve(addresses.lyc, ethers.MaxUint256, await walletTxOverrides(address, 200_000n))).wait();
      void approve;
    }
    const receipt = await (
      await sendReplacing(
        address,
        (o) => h.getFunction("mintWithCollateral(address,uint256)")(token, amount, o),
        2_000_000n,
      )
    ).wait();
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

export type RedeemTarget = "USDG" | "WETH" | "ETH" | "CBBTC";

/// Redeem LYC, then -- for anything other than USDG -- swap the cash proceeds into the requested
/// asset in the same call. The pool itself only ever pays out idle USDG (or, if cash is short,
/// whatever it peels in kind; see `redeemLyc` above) -- converting to a specific token afterwards
/// is deliberately left to the holder's own follow-up transaction, on-chain. This just automates
/// that follow-up so "withdraw as ETH" is one click instead of two.
///
/// Any in-kind portion of the redeem (only reached when idle cash is short) is left as whatever
/// raw collateral the pool peeled -- it is not further converted here.
export async function redeemLycTo(addresses: DeployedAddresses, shares: bigint, target: RedeemTarget) {
  if (target === "USDG") return redeemLyc(addresses, shares);

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

      // usdgOut is only available from the event -- redeemInKind's return value isn't readable
      // off a mined transaction.
      const earnIface = new ethers.Interface(EarnPoolAbi as ethers.InterfaceAbi);
      let usdgOut = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = earnIface.parseLog(log);
          if (parsed?.name === "Redeemed") {
            usdgOut = parsed.args.usdgOut as bigint;
            break;
          }
        } catch {
          // not this contract's log
        }
      }

      if (usdgOut > 0n) {
        const routerAddress = target === "CBBTC" ? addresses.cbbtcRouter : addresses.router;
        if (!routerAddress) throw new Error(`No router configured to convert USDG to ${target}.`);

        const usdg = new ethers.Contract(
          addresses.usdg,
          ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"],
          signer,
        );
        const allowance: bigint = await usdg.allowance(address, routerAddress);
        if (allowance < usdgOut) {
          await (await usdg.approve(routerAddress, ethers.MaxUint256, await walletTxOverrides(address, 200_000n))).wait();
        }
        const router = new ethers.Contract(routerAddress, OracleSwapRouterAbi as ethers.InterfaceAbi, signer);
        const swapReceipt = await (
          await router.swapUsdgForCollateral(usdgOut, 0, await walletTxOverrides(address, 500_000n))
        ).wait();

        // "ETH" means native: swap lands as WETH, then unwrap it in the same click.
        if (target === "ETH") {
          const swapIface = new ethers.Interface(OracleSwapRouterAbi as ethers.InterfaceAbi);
          let wethOut = 0n;
          for (const log of swapReceipt.logs) {
            try {
              const parsed = swapIface.parseLog(log);
              if (parsed?.name === "Swap") {
                wethOut = parsed.args.amountOut as bigint;
                break;
              }
            } catch {
              // not this contract's log
            }
          }
          if (wethOut > 0n) {
            const weth = new ethers.Contract(addresses.weth, MockWETHAbi as ethers.InterfaceAbi, signer);
            await (await weth.withdraw(wethOut, await walletTxOverrides(address, 100_000n))).wait();
          }
        }
      }

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

/// What a deposit mints right now. Mirrors `EarnPool._issue` line for line:
///   navNow  = nav() while the book is covered (or empty), else seniorBackedAssetsUsd/supply
///   shares  = (usd − usd·mintFeeBps/10000) · WAD / navNow
/// The fee is read live off the contract, and the impaired branch prices at the junior-
/// excluding base — quoting full TVL here would promise shares backed by the meme AMM's
/// reserves, the exact F1 accounting this app should not advertise either.
export function quoteMint(g: LycGlobal, usdIn: bigint): bigint {
  if (usdIn <= 0n) return 0n;
  const covered = g.supply === 0n || g.globalCr > g.coveredCrWad;
  const navNow = covered ? g.nav : g.supply > 0n ? (g.seniorBackedAssetsUsd * WAD) / g.supply : 0n;
  if (navNow === 0n) return 0n;
  const netUsd = usdIn - (usdIn * g.mintFeeBps) / 10_000n;
  return (netUsd * WAD) / navNow;
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
  /// Why this mint exists. The Transfer log alone can't tell a fee payout from a deposit -- both
  /// are a mint from the zero address -- so the event the same transaction emitted decides it:
  /// `FeeMint` is a Launch harvest paying creator/protocol fees in LYC, `Minted` is an Earn page
  /// deposit. Redeems leave this unset.
  source?: "deposit" | "fees";
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

  // The accounting events, joined to the Transfer skeleton by transaction hash:
  //   Minted(user, usdValue, hfycOut, paidInEth)  -> a deposit's ACTUAL cost in USD
  //   FeeMint(recipient, hfycAmount, usdValue, …) -> a fee payout's USD value AT MINT TIME
  //   Redeemed(user, shares, usdgOut, wethOut, covered) -> a redeem's ACTUAL proceeds
  // These are what realized PnL must be built from. The previous version assumed every mint was
  // a $1 deposit and valued every redeem at TODAY's NAV, so realized LYC PnL was wrong for any
  // deposit above/below $1 -- and doubly wrong once fee mints (minted at NAV, costed at $1) and
  // NAV-moving redeems entered the book.
  const mintCostByTx = new Map<string, bigint>();   // tx -> USD paid for the minted shares
  const feeMintTxs = new Set<string>();             // tx -> mint came from a harvest fee payout
  const redeemOutByTx = new Map<string, { usdg: bigint; weth: bigint }>();
  try {
    for (const e of (await h.queryFilter(h.filters.Minted(holder), 0)) as ethers.EventLog[]) {
      const usd = e.args?.usdValue as bigint | undefined;
      const txh = e.transactionHash.toLowerCase();
      if (usd) mintCostByTx.set(txh, (mintCostByTx.get(txh) ?? 0n) + usd);
    }
    for (const e of (await h.queryFilter(h.filters.FeeMint(holder), 0)) as ethers.EventLog[]) {
      const usd = e.args?.usdValue as bigint | undefined;
      const txh = e.transactionHash.toLowerCase();
      feeMintTxs.add(txh);
      if (usd) mintCostByTx.set(txh, (mintCostByTx.get(txh) ?? 0n) + usd);
    }
    for (const e of (await h.queryFilter(h.filters.Redeemed(holder), 0)) as ethers.EventLog[]) {
      const txh = e.transactionHash.toLowerCase();
      const prev = redeemOutByTx.get(txh);
      redeemOutByTx.set(txh, {
        usdg: (prev?.usdg ?? 0n) + ((e.args?.usdgOut as bigint) ?? 0n),
        weth: (prev?.weth ?? 0n) + ((e.args?.wethOut as bigint) ?? 0n),
      });
    }
  } catch {
    // event scan failed -- cost/proceeds fall back to the $1/current-NAV approximations below
  }

  // WETH redeem proceeds are valued at the current oracle mark. Historical per-block marks are
  // not available from the mock oracle, and in-kind WETH slices are typically the minority leg;
  // the USDG leg (the majority) is the actual event value.
  let ethUsdWad = 0n;
  try {
    ethUsdWad = await readEthUsdWad(addresses.oracle);
  } catch {
    // oracle unreadable -- WETH legs value at 0 rather than failing the whole PnL
  }

  // Combine and sort by block number
  const txs: LycTx[] = [];

  // The testnet RPC occasionally answers getBlock with null; without a second try half the
  // history renders with a 1970 timestamp. Converted to ms here -- the rest of the app's
  // timestamps (timeAgo on the profile's LYC tab) are epoch milliseconds, and a raw seconds
  // value is small enough to read as 1970 anyway, rendering every mint as "57y ago".
  const blockTime = async (blockNumber: number): Promise<number> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const block = await provider.getBlock(blockNumber);
      if (block?.timestamp) return block.timestamp * 1000;
    }
    return 0;
  };

  for (const e of mintEvents) {
    const ts = await blockTime(e.blockNumber);
    const shares = e.args[2] as bigint;
    const isFeeMint = feeMintTxs.has(e.transactionHash.toLowerCase());
    const costUsd = mintCostByTx.get(e.transactionHash.toLowerCase()) ?? shares; // fallback: $1/share
    txs.push({
      type: "mint",
      source: isFeeMint ? "fees" : "deposit",
      shares,
      valueUsd: costUsd,
      // What the mint was actually worth per share when it happened: ~$1 for deposits, the
      // harvest-time NAV for fee payouts.
      navAtTime: shares > 0n ? (costUsd * WAD) / shares : WAD,
      timestamp: ts,
      txHash: e.transactionHash,
    });
  }

  for (const e of redeemEvents) {
    const ts = await blockTime(e.blockNumber);
    const shares = e.args[2] as bigint;
    // Actual proceeds from the Redeemed event: USDG cash plus the WETH in-kind slice, the WETH
    // leg valued at the current oracle mark. Without the event (scan failure) fall back to
    // shares at today's NAV -- the old approximation.
    const out = redeemOutByTx.get(e.transactionHash.toLowerCase());
    const proceeds = out ? out.usdg + (out.weth * ethUsdWad) / WAD : (shares * currentNav) / WAD;
    txs.push({
      type: "redeem",
      shares,
      valueUsd: proceeds,
      navAtTime: shares > 0n ? (proceeds * WAD) / shares : currentNav,
      timestamp: ts,
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
      const redeemValue = tx.valueUsd; // actual event proceeds (cash + in-kind), not a re-mark

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

// ---------------------------------------------------------------
//                     EIP-2612 PERMIT SIGNING
// ---------------------------------------------------------------

const PERMIT_SUPPORT_CACHE = new Map<string, boolean>();

/// Whether `token` implements EIP-2612. Probed once via `nonces()` (a permit-gated flow cannot
/// work without it) and cached per chain — the answer is a property of the token contract.
export async function tokenSupportsPermit(token: string, provider: ethers.Provider): Promise<boolean> {
  const net = await provider.getNetwork();
  const key = `${net.chainId.toString()}:${token.toLowerCase()}`;
  const cached = PERMIT_SUPPORT_CACHE.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const c = new ethers.Contract(token, ["function nonces(address) view returns (uint256)"], provider);
    await c.nonces.staticCall(token);
    ok = true;
  } catch {
    ok = false;
  }
  PERMIT_SUPPORT_CACHE.set(key, ok);
  return ok;
}

/// Signs an EIP-2612 permit for `value` with the connected wallet, matching the quote token's
/// on-chain domain (OZ ERC20Permit: EIP712(name, "1") with chainId + verifyingContract).
export async function signEip2612(
  signer: ethers.Signer,
  token: string,
  spender: string,
  value: bigint,
  deadline: bigint,
): Promise<string> {
  const [name, nonce, network] = await Promise.all([
    new ethers.Contract(token, ["function name() view returns (string)"], signer).name(),
    new ethers.Contract(token, ["function nonces(address) view returns (uint256)"], signer).nonces(
      await signer.getAddress(),
    ),
    signer.provider!.getNetwork(),
  ]);
  const domain = {
    name: name as string,
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: ethers.getAddress(token),
  };
  return signer.signTypedData(
    domain,
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { owner: await signer.getAddress(), spender, value, nonce, deadline },
  );
}
