import { ethers } from "ethers";
import { LaunchAbi } from "./artifacts/Launch";
import { LaunchpadFactoryAbi } from "./artifacts/LaunchpadFactory";
import { EarnPoolAbi } from "./artifacts/EarnPool";
import { MockUSDGAbi } from "./artifacts/MockUSDG";
import { MockERC20Abi } from "./artifacts/MockERC20";
import { OracleSwapRouterAbi } from "./artifacts/OracleSwapRouter";
import { MockWETHAbi } from "./artifacts/MockWETH";
import { QuoteZapAbi } from "./artifacts/QuoteZap";
import { ANVIL_ACCOUNTS, DEPLOYER, DeployedAddresses } from "./chain";
import { signEip2612, tokenSupportsPermit } from "./lyc";
import { getManagedSigner, getProvider, withSignerLock } from "./signers";
import { readEthUsdWad } from "./oracle";
import { assertWalletSeesApp, withActiveSigner } from "./activeSigner";
import { computePnl, recordTrade, summarizePosition } from "./ledger";
import { EMPTY_STATS, LaunchStats, fetchCreationTimes, fetchLaunchStats, resetStatsCache } from "./launchStats";
import { sendReplacing, walletTxOverrides } from "./txFees";

export type { LaunchStats };

export const WAD = 10n ** 18n;
export const TOTAL_SUPPLY_WAD = 1_000_000_000n * WAD;
// Mirrors Launch.sol's TOTAL_FEE_BPS, used to preview a trade's fee client-side before it is
// signed. LYC took no trading-volume slice as of the fee-split change that dropped this from
// 125 to 100 (55:45 creator:protocol, no LYC holder slice) -- this constant drifted stale for
// the same reason the *FeeEth call sites did, and every buy/sell preview undercounted the actual
// fill by 25 bps until fixed.
export const TOTAL_FEE_BPS = 100n;
export const BPS_DENOMINATOR = 10_000n;

export { getProvider };

export function getFactory(address: string, runner: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, LaunchpadFactoryAbi as ethers.InterfaceAbi, runner);
}

export function getLyc(address: string, runner?: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, EarnPoolAbi as ethers.InterfaceAbi, runner ?? getProvider());
}

export function getLaunch(address: string, runner: ethers.Signer | ethers.Provider) {
  return new ethers.Contract(address, LaunchAbi as ethers.InterfaceAbi, runner);
}

/// Display name for the pair/quote asset on listing surfaces (home table + cards). Collateral
/// enters and leaves as native ETH and cbBTC, so a wrapped-native quote (mWETH on testnet,
/// WETH elsewhere) reads as plain "ETH" -- same wording the coin page already uses via its
/// wrapsNative check. The raw on-chain symbol still rules anything that touches the ERC-20.
export function displayQuoteSymbol(quoteSymbol: string): string {
  const s = quoteSymbol.toUpperCase();
  return s === "WETH" || s === "MWETH" ? "ETH" : quoteSymbol;
}

export type LaunchSummary = {
  address: string;
  name: string;
  symbol: string;
  creator: string;
  graduated: boolean;
  paired: boolean;
  leverageEnabled: boolean;
  raisedCollateral: bigint;
  targetCollateral: bigint;
  raisedUsd: bigint;
  targetUsd: bigint;
  pctToGraduation: number;
  priceUsd: bigint;
  marketCapUsd: bigint;
  circulating: bigint;
  collateralPriceUsd: bigint;
  /// The quote asset this coin trades in, read off the launch. `quoteScale` is 10**(18-decimals)
  /// -- 1 for WETH, 1e10 for cbBTC -- and MUST multiply every quote amount before it meets a USD
  /// figure or an 18-decimal formatter; the trades table and the bonding-curve card both showed
  /// 0.0000 for cbBTC trades without it.
  quoteToken: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteScale: bigint;
  stats: LaunchStats;
  creatorFeesUsd?: number;
  tvlUsd: bigint;
  reserveEth: bigint;
  vaultEth: bigint;
  seniorUsd: bigint;
  occupancyPaidUsd: bigint;
  pairingFeesPaidUsd: bigint;
  reserveToken: bigint;
  /// The AMM pair, once graduated -- zero address before that. Holds the token's own reserve, so
  /// it must be excluded from a holder count the same way the launch contract itself is.
  amm: string;
};

export async function fetchCollateralPriceUsd(oracleAddress: string): Promise<bigint> {
  return readEthUsdWad(oracleAddress);
}

/// The USD price of a launch's OWN quote asset, read off the launch rather than the deployment's
/// global oracle. Both oracles speak IPriceOracle.price(), but a cbBTC-quoted launch carries the
/// cbBTC feed while the global one carries ETH -- using the global figure for a cbBTC coin marked
/// every one of its USD numbers off by the ETH/BTC ratio.
export async function fetchLaunchCollateralPriceUsd(launchAddress: string): Promise<bigint> {
  const launch = getLaunch(launchAddress, getProvider());
  const oracle: string = await launch.priceOracle();
  return readEthUsdWad(oracle);
}

export async function fetchLaunchAddresses(factoryAddress: string): Promise<string[]> {
  const factory = getFactory(factoryAddress, getProvider());
  const count: bigint = await factory.launchCount();
  // One wave, not a chain. `allLaunches(i)` calls are independent, but awaiting each one inside
  // the loop serialized them: N coins cost N round trips back to back, and against a ~0.4s
  // testnet RPC that alone was seconds before a single coin's state had been read.
  const indices = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  return Promise.all(indices.map((i) => factory.allLaunches(i) as Promise<string>));
}

/// The parts of a launch that are fixed at construction: its oracle, its quote asset, that
/// asset's scale and symbol. None of them can change for a given launch address.
type LaunchMeta = {
  oracle: string;
  quoteToken: string;
  quoteScale: bigint;
  quoteSymbol: string;
  quoteDecimals: number;
};

/// Immutable launch facts, read once per address per session.
///
/// `fetchLaunchSummary` used to open with five SEQUENTIAL awaits -- priceOracle, the oracle price,
/// quote, quoteScale, then the quote token's symbol -- before it reached its parallel block. Four
/// of those five are constants of the launch, and the poll re-read them every 15 seconds forever.
/// Five serialized round trips at ~0.4s is ~2s per coin of pure latency, paid on every refresh.
const launchMetaCache = new Map<string, LaunchMeta>();

async function loadLaunchMeta(launchAddress: string): Promise<LaunchMeta> {
  const key = launchAddress.toLowerCase();
  const hit = launchMetaCache.get(key);
  if (hit) return hit;

  const launch = getLaunch(launchAddress, getProvider());
  // Independent reads, so one wave rather than a chain.
  const [oracle, quoteToken, quoteScale] = await Promise.all([
    launch.priceOracle() as Promise<string>,
    launch.quote() as Promise<string>,
    launch.quoteScale() as Promise<bigint>,
  ]);
  const quoteSymbol = (await new ethers.Contract(
    quoteToken,
    ["function symbol() view returns (string)"],
    getProvider()
  ).symbol()) as string;

  // scale = 10**(18 - decimals), so decimals = 18 - log10(scale): 1e10 lifts to 8, not 10.
  const meta: LaunchMeta = {
    oracle,
    quoteToken,
    quoteScale,
    quoteSymbol,
    quoteDecimals: 18 - Math.round(Math.log10(Number(quoteScale))),
  };
  launchMetaCache.set(key, meta);
  return meta;
}

/// Drops every per-address cache this module and launchStats hold. Addresses are reused across
/// deployments (a re-forked Anvil replays the same CREATE sequence), so a new deployment must not
/// inherit the previous one's quote asset, symbol or trade history.
export function resetLaunchCaches() {
  launchMetaCache.clear();
  lastGoodSummaries.clear();
  resetStatsCache();
}

export async function fetchLaunchSummary(
  launchAddress: string,
  collateralPriceUsd?: bigint,
  creationTime: number | null = null
): Promise<LaunchSummary> {
  const launch = getLaunch(launchAddress, getProvider());

  // The quote asset, its scale and its oracle. All fixed at construction, so this is a cache read
  // after the first refresh. quoteScale is 10**(18-decimals) -- the factor that lifts an 8-decimal
  // cbBTC amount to WAD before it meets a USD price.
  const { oracle, quoteToken, quoteScale: quoteScaleBigint, quoteSymbol, quoteDecimals } =
    await loadLaunchMeta(launchAddress);

  // No price supplied means resolve the launch's own: a cbBTC-quoted coin carries the cbBTC feed
  // and must not inherit the global ETH mark. Callers that already hold the right price (the
  // Earn Pool's ETH oracle for its own UI, and fetchAllLaunches, which resolves one price per
  // distinct oracle for the whole batch) still pass it in.
  const collateralPrice = collateralPriceUsd ?? (await readEthUsdWad(oracle));

  const toUsdWad = (quoteAmount: bigint) => (quoteAmount * quoteScaleBigint * collateralPrice) / WAD;

  const [name, symbol, creator, graduated, paired, leverageEnabled, raisedCollateral, targetRaiseEth, circulating, priceUsd, tvlUsd, reserveEth, vaultEth, seniorUsd, occupancyPaidUsd, pairingFeesPaidUsd, reserveToken, amm] =
    await Promise.all([
      launch.name(),
      launch.symbol(),
      launch.creator(),
      launch.graduated(),
      launch.paired(),
      launch.leverageEnabled(),
      launch.realEthRaised(),
      launch.targetRaiseEth(),
      launch.circulating() as Promise<bigint>,
      launch.priceUsd() as Promise<bigint>,
      launch.tvlUsd() as Promise<bigint>,
      launch.reserveEth() as Promise<bigint>,
      launch.vaultEth() as Promise<bigint>,
      launch.seniorUsd() as Promise<bigint>,
      launch.occupancyPaidUsd() as Promise<bigint>,
      launch.pairingFeesPaidUsd() as Promise<bigint>,
      launch.reserveToken() as Promise<bigint>,
      launch.amm() as Promise<string>,
    ]);

  const stats = await fetchLaunchStats(launchAddress, collateralPrice, creationTime, quoteScaleBigint).catch(
    () => EMPTY_STATS
  );

  const targetUsd: bigint = toUsdWad(targetRaiseEth);
  const raisedUsd = toUsdWad(raisedCollateral);
  const pct = targetUsd > 0n ? Number((raisedUsd * 10000n) / targetUsd) / 100 : 0;

  // Market cap is priced on the FULL supply, the way every launchpad quotes it -- price x 1e9.
  //
  // This used to multiply by `circulating`, which on a bonding curve is not a market cap at all:
  // circulating is only what has been bought so far, and on a constant-product curve
  // price x circulating collapses to (net deposited) x (1 + deposit/Vu0). For the first buyer that
  // is their own deposit back, to the cent -- a $76.23 buy printed a $77.36 "market cap". The coin
  // read as though it were worth exactly what one person had put in, and no coin could ever show a
  // mcap larger than the money raised.
  //
  // Supply is fixed: Launch.sol mints TOTAL_SUPPLY once in initialize() and never mints or burns
  // again, so 1e9 is correct in both phases, not a "frozen" approximation.
  const marketCapUsd = (priceUsd * TOTAL_SUPPLY_WAD) / WAD;

  return {
    address: launchAddress,
    name,
    symbol,
    quoteToken,
    quoteSymbol,
    quoteDecimals,
    quoteScale: quoteScaleBigint,
    creator,
    graduated,
    paired,
    leverageEnabled,
    raisedCollateral: raisedCollateral,
    targetCollateral: targetRaiseEth,
    raisedUsd,
    targetUsd,
    pctToGraduation: Math.min(pct, 100),
    priceUsd,
    marketCapUsd,
    circulating,
    collateralPriceUsd: collateralPrice,
    stats,
    tvlUsd,
    reserveEth,
    vaultEth,
    seniorUsd,
    occupancyPaidUsd,
    pairingFeesPaidUsd,
    reserveToken,
    amm,
  };
}

/// Every launchpad this deployment has. Coins live on the factory that minted them, so anything
/// that enumerates "all launches" has to ask both pads: listing only the WETH factory made every
/// cbBTC coin invisible to the explore grid, the keeper, and the Earn Pool metrics.
export function allFactories(addresses: DeployedAddresses): string[] {
  return [addresses.factory, addresses.cbbtcFactory].filter(Boolean) as string[];
}

export async function fetchAllLaunches(addresses: DeployedAddresses): Promise<LaunchSummary[]> {
  const factories = allFactories(addresses);
  const [addressLists, timeMaps] = await Promise.all([
    Promise.all(factories.map((f) => fetchLaunchAddresses(f))),
    Promise.all(factories.map((f) => fetchCreationTimes(f, LaunchpadFactoryAbi as ethers.InterfaceAbi))),
  ]);
  const launchAddresses = addressLists.flat();
  const creationTimes = new Map<string, number>();
  for (const m of timeMaps) m.forEach((v, k) => creationTimes.set(k, v));

  // Resolve each collateral price ONCE for the batch, not once per coin. There are two oracles in
  // a deployment (ETH and cbBTC) and any number of coins; letting every summary read its own
  // meant N identical round trips for 2 distinct values, and the price is a single mark shared by
  // every coin quoted in that asset anyway.
  const metas = await Promise.all(
    launchAddresses.map((a) => loadLaunchMeta(a).catch(() => null))
  );
  const oracles = [...new Set(metas.filter((m) => m !== null).map((m) => m!.oracle.toLowerCase()))];
  const priceByOracle = new Map<string, bigint>(
    await Promise.all(
      oracles.map(async (o) => [o, await readEthUsdWad(o).catch(() => 0n)] as [string, bigint])
    )
  );

  const summaries = await Promise.all(
    launchAddresses.map((a, i) =>
      fetchLaunchSummary(
        a,
        priceByOracle.get(metas[i]?.oracle.toLowerCase() ?? ""),
        creationTimes.get(a.toLowerCase()) ?? null
      )
        .then((s) => {
          lastGoodSummaries.set(a.toLowerCase(), s);
          return s;
        })
        .catch(() => lastGoodSummaries.get(a.toLowerCase()) ?? null)
    )
  );
  return summaries.filter((s): s is LaunchSummary => s !== null).reverse();
}

/// Last read that succeeded, per launch. Against a rate-limited public RPC a coin whose refresh
/// 429s must not VANISH from the explore grid -- one bad cycle earlier turned "4 coins" into
/// "No coins launched yet" with the contracts untouched. Serving the previous read is exactly
/// what a stale price ticker does; the next good refresh overwrites it.
const lastGoodSummaries = new Map<string, LaunchSummary>();

export const LAUNCH_DEFAULTS = {
  targetRaiseEth: "6.9",
} as const;

/// The launchpad to mint from. Choosing a quote asset is choosing a launchpad, and the coin is
/// bound to it afterwards. Omitted means the default (WETH) one.
export type QuoteChoice = { factory: string; targetRaise: bigint; token: string };

export type CreateLaunchParams = {
  name: string;
  symbol: string;
  buyInCollateral?: bigint;
  /// Pair against LYC at 2x on graduation. False = a normal 1x market that never pulls senior.
  leverageEnabled?: boolean;
  /// Creator's 0.30% in LYC (true) or claimable in the coin's QUOTE asset (false). A cbBTC-quoted
  /// coin pays its creator cbBTC; a WETH-quoted one pays WETH. Frozen at creation.
  creatorFeeInHfyc?: boolean;
  /// Which launchpad, and therefore which quote asset. Defaults to the WETH launchpad.
  quote?: QuoteChoice;
};

let createInFlight: Promise<string> | null = null;

export async function createLaunch(
  addresses: DeployedAddresses,
  params: CreateLaunchParams
): Promise<string> {
  if (createInFlight) {
    throw new Error(
      "A coin is already being created. Wait for that MetaMask transaction to finish before starting another.",
    );
  }
  createInFlight = doCreateLaunch(addresses, params).finally(() => {
    createInFlight = null;
  });
  return createInFlight;
}

// Mirrors Launch._initCurve exactly: CURVE_SELLABLE (800M, WAD) and CURVE_SHAPE_M, the two
// constants that make the curve's INITIAL virtual reserves a pure function of targetRaiseEth --
// before any coin (and therefore any Launch contract to read the real reserves off) exists.
const CURVE_SELLABLE_WAD = 800_000_000n * WAD;
const CURVE_SHAPE_M_WAD = 1333333333333333333n;

/// What a dev buy of `buyInWad` (quote-asset units) would receive on a FRESH curve for a coin
/// with this `targetRaiseEth`, and the cap it would be checked against. Exported so the create
/// page can validate BEFORE submitting -- rather than let the factory's own "creator cap" revert
/// be the first the user hears of it -- using the exact same math `doCreateLaunch` uses to log the
/// executed price, rather than a second, driftable copy of the curve formula.
export function previewCreatorBuy(
  targetRaiseEth: bigint,
  buyInWad: bigint,
  creatorBuyCapBps: bigint
): { tokensOut: bigint; capTokens: bigint; exceedsCap: boolean } {
  const capTokens = (TOTAL_SUPPLY_WAD * creatorBuyCapBps) / BPS_DENOMINATOR;
  if (buyInWad <= 0n) return { tokensOut: 0n, capTokens, exceedsCap: false };

  const virtualTokens0 = (CURVE_SELLABLE_WAD * CURVE_SHAPE_M_WAD) / WAD;
  const virtualEth0 = (targetRaiseEth * (CURVE_SHAPE_M_WAD - WAD)) / WAD;
  const netIn = buyInWad - (buyInWad * TOTAL_FEE_BPS) / BPS_DENOMINATOR;
  const newVt = (virtualTokens0 * virtualEth0) / (virtualEth0 + netIn);
  const tokensOut = virtualTokens0 > newVt ? virtualTokens0 - newVt : 0n;
  return { tokensOut, capTokens, exceedsCap: tokensOut > capTokens };
}

async function doCreateLaunch(addresses: DeployedAddresses, params: CreateLaunchParams): Promise<string> {
  await assertWalletSeesApp(addresses.factory);
  const factoryAddress = params.quote?.factory ?? addresses.factory;
  const targetRaiseEth = params.quote?.targetRaise ?? ethers.parseUnits(LAUNCH_DEFAULTS.targetRaiseEth, 18);
  const buyIn = params.buyInCollateral && params.buyInCollateral > 0n ? params.buyInCollateral : 0n;

  const { launchAddress } = await withActiveSigner(async ({ signer, address }) => {
    const factory = getFactory(factoryAddress, signer);

    // The dev buy is pulled by the FACTORY (Launch.sol's own createLaunch doc explains why: doing
    // it inside createLaunch is what makes the 20% cap unconditional rather than a race the
    // creator could win by front-running their own second transaction), so the approval target is
    // the factory, not the not-yet-existing launch.
    if (buyIn > 0n) {
      const quoteToken = params.quote?.token ?? addresses.weth;
      const quote = new ethers.Contract(
        quoteToken,
        ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"],
        signer,
      );
      if ((await quote.allowance(address, factoryAddress)) < buyIn) {
        await (await quote.approve(factoryAddress, ethers.MaxUint256)).wait();
      }
    }

    // creatorMinTokensOut = 0: this is the creator's own transaction against a curve that was
    // just initialized inside the SAME call, so there is no other trade that can land between
    // init and this buy to move the price against them -- the 20% cap is what actually bounds
    // this, not a slippage floor.
    const tx = await sendReplacing(
      address,
      (overrides) =>
        factory.createLaunch(
          params.name,
          params.symbol,
          targetRaiseEth,
          params.leverageEnabled !== false && params.creatorFeeInHfyc === true,
          params.leverageEnabled !== false,
          buyIn,
          0n,
          { ...overrides, value: factory.LAUNCH_FEE() },
        ),
      8_000_000n,
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error("createLaunch mined but returned no receipt");

    const iface = new ethers.Interface(LaunchpadFactoryAbi as ethers.InterfaceAbi);
    let launch: string | null = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "LaunchCreated") launch = parsed.args.launch as string;
      } catch {
        // not a factory log
      }
    }
    if (!launch) throw new Error("launch created but no LaunchCreated event was found in the receipt");
    return { launchAddress: launch };
  });

  const launch = getLaunch(launchAddress, getProvider());
  const target: bigint = await launch.targetRaiseEth();
  const virtualTokens0 = (CURVE_SELLABLE_WAD * CURVE_SHAPE_M_WAD) / WAD;
  const virtualEth0 = (target * (CURVE_SHAPE_M_WAD - WAD)) / WAD;
  const startSpot = virtualTokens0 > 0n ? (virtualEth0 * WAD) / virtualTokens0 : 0n;
  const listingSpot = (target * WAD) / (200_000_000n * WAD);

  const [vt1, vu1]: bigint[] = await Promise.all([launch.virtualTokens(), launch.virtualEth()]);
  const afterSpot = vt1 > 0n ? (vu1 * WAD) / vt1 : startSpot;
  const buyEth = buyIn;
  const impact = startSpot > 0n ? Number(((afterSpot - startSpot) * 10000n) / startSpot) / 100 : 0;
  const { logLaunch } = await import("./sessionLog");
  logLaunch({
    launchAddress,
    launchSpotEth: ethers.formatUnits(startSpot, 18),
    launchSpotEthWei: startSpot.toString(),
    listingSpotEth: ethers.formatUnits(listingSpot, 18),
    listingSpotEthWei: listingSpot.toString(),
    priceAfterCreatorBuyEth: ethers.formatUnits(afterSpot, 18),
    priceAfterCreatorBuyEthWei: afterSpot.toString(),
    creatorBuyEth: ethers.formatUnits(buyEth, 18),
    creatorBuyImpactPct: impact.toFixed(4),
  }).catch(() => {});

  return launchAddress;
}

// ---- trading ----

export async function quoteBuy(launchAddress: string, ethIn: bigint): Promise<bigint> {
  if (ethIn <= 0n) return 0n;
  const launch = getLaunch(launchAddress, getProvider());
  const graduated: boolean = await launch.graduated();
  const netIn = ethIn - (ethIn * TOTAL_FEE_BPS) / BPS_DENOMINATOR;

  if (!graduated) {
    // Live virtual reserves, read straight from the contract.
    const [vt, vu, k, sellable]: bigint[] = await Promise.all([
      launch.virtualTokens(),
      launch.virtualEth(),
      launch.curveK(),
      launch.curveSellable(),
    ]);
    const newVt = k / (vu + netIn);
    const out = vt > newVt ? vt - newVt : 0n;
    // The contract caps the fill at what is left and refunds the rest, so quoting more than that
    // would promise tokens the trade cannot deliver.
    return out > sellable ? sellable : out;
  }

  return quotePoolBuy(launch, ethIn);
}

export async function quoteSell(launchAddress: string, tokensIn: bigint): Promise<bigint> {
  if (tokensIn <= 0n) return 0n;
  const launch = getLaunch(launchAddress, getProvider());
  const graduated: boolean = await launch.graduated();

  if (!graduated) {
    const [vt, vu, k]: bigint[] = await Promise.all([
      launch.virtualTokens(),
      launch.virtualEth(),
      launch.curveK(),
    ]);
    const newVu = k / (vt + tokensIn);
    const grossOut = vu > newVu ? vu - newVu : 0n;
    return grossOut - (grossOut * TOTAL_FEE_BPS) / BPS_DENOMINATOR;
  }

  return quotePoolSell(launch, tokensIn);
}

const MAX_SELL_BPS = 1500n;

async function quotePoolBuy(launch: ethers.Contract, ethIn: bigint): Promise<bigint> {
  const [reserveToken, reserveEth, leverageEnabled, juniorEth] = await Promise.all([
    launch.reserveToken() as Promise<bigint>,
    launch.reserveEth() as Promise<bigint>,
    launch.leverageEnabled() as Promise<boolean>,
    launch.juniorEth() as Promise<bigint>,
  ]);
  const pricingEth = leverageEnabled && juniorEth > 0n ? juniorEth : reserveEth;
  if (ethIn <= 0n || reserveToken === 0n || pricingEth === 0n) return 0n;
  const netIn = ethIn - (ethIn * TOTAL_FEE_BPS) / BPS_DENOMINATOR;
  const k = reserveToken * pricingEth;
  const newRt = k / (pricingEth + netIn);
  const tokensOut = reserveToken > newRt ? reserveToken - newRt : 0n;
  if (tokensOut >= reserveToken) return 0n;
  return tokensOut;
}

async function quotePoolSell(launch: ethers.Contract, tokensIn: bigint): Promise<bigint> {
  const [reserveToken, reserveEth, leverageEnabled, juniorEth] = await Promise.all([
    launch.reserveToken() as Promise<bigint>,
    launch.reserveEth() as Promise<bigint>,
    launch.leverageEnabled() as Promise<boolean>,
    launch.juniorEth() as Promise<bigint>,
  ]);
  const pricingEth = leverageEnabled && juniorEth > 0n ? juniorEth : reserveEth;
  if (tokensIn <= 0n || reserveToken === 0n || pricingEth === 0n) return 0n;
  const k = reserveToken * pricingEth;
  const newY = k / (reserveToken + tokensIn);
  let gross = pricingEth > newY ? pricingEth - newY : 0n;
  const maxOut = (reserveEth * MAX_SELL_BPS) / BPS_DENOMINATOR;
  if (gross > maxOut) gross = maxOut;
  if (gross > reserveEth) gross = reserveEth;
  return gross - (gross * TOTAL_FEE_BPS) / BPS_DENOMINATOR;
}

function extractTradeAmounts(
  receipt: ethers.ContractTransactionReceipt,
  eventName: "CurveBuy" | "CurveSell" | "JuniorMinted" | "JuniorRedeemed" | "PoolBuy" | "PoolSell"
): { amount: bigint; tokenAmount: bigint } | null {
  const iface = new ethers.Interface(LaunchAbi as ethers.InterfaceAbi);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name !== eventName) continue;
      if (eventName === "CurveBuy" || eventName === "JuniorMinted" || eventName === "PoolBuy") {
        return { amount: parsed.args.ethIn as bigint, tokenAmount: parsed.args.tokensOut as bigint };
      }
      return { amount: parsed.args.ethOut as bigint, tokenAmount: parsed.args.tokensIn as bigint };
    } catch {
      // not this contract's log
    }
  }
  return null;
}

/// Swap USDG for a launch's quote asset, whatever it is.
///
/// Two things here are easy to get wrong and were both wrong before. The router's swap is a
/// STATE-CHANGING call, so awaiting it yields a TransactionResponse rather than the uint256 it
/// returns -- passing that straight into a later call is what produced "invalid BigNumberish
/// value". And the venue is the LAUNCH's own router, not the global one: every launchpad carries
/// a router bound to its quote asset (WETH for one, cbBTC for the other), so a cbBTC-quoted coin
/// must be zapped through the cbBTC router or the user ends up holding WETH they cannot spend on
/// it. The proceeds stay as the ERC-20 -- Launch.buy pulls the quote token, so for WETH there is
/// nothing to unwrap either.
async function zapUsdgToQuote(
  addresses: DeployedAddresses,
  launchAddress: string,
  signer: ethers.Signer,
  usdgAmount: bigint
): Promise<bigint> {
  const owner = await signer.getAddress();
  const launch = getLaunch(launchAddress, signer);
  const routerAddress: string = await launch.swapRouter();

  const usdg = new ethers.Contract(addresses.usdg, MockUSDGAbi as ethers.InterfaceAbi, getProvider());
  const allowance: bigint = await usdg.allowance(owner, routerAddress);
  if (allowance < usdgAmount) {
    const usdgSigner = new ethers.Contract(addresses.usdg, MockUSDGAbi as ethers.InterfaceAbi, signer);
    await (await usdgSigner.approve(routerAddress, ethers.MaxUint256, await walletTxOverrides(owner, 200_000n))).wait();
  }

  const router = new ethers.Contract(routerAddress, OracleSwapRouterAbi as ethers.InterfaceAbi, signer);
  const receipt = await (await router.swapUsdgForCollateral(usdgAmount, 0, await walletTxOverrides(owner, 500_000n))).wait();

  // The amount out is only available from the event -- there is no return value to read off a
  // mined transaction.
  const iface = new ethers.Interface(OracleSwapRouterAbi as ethers.InterfaceAbi);
  let quoteOut: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Swap") {
        quoteOut = parsed.args.amountOut as bigint;
        break;
      }
    } catch {
      // not this contract's log
    }
  }
  if (quoteOut === null || quoteOut === 0n) throw new Error("USDG swap returned no collateral.");
  return quoteOut;
}

export async function buy(
  addresses: DeployedAddresses,
  launchAddress: string,
  payToken: "ETH" | "WETH" | "USDG",
  amountWad: bigint,
  minTokensOut: bigint
) {
  await assertWalletSeesApp(addresses.factory);
  return withActiveSigner(async ({ signer, address }) => {
    const launch = getLaunch(launchAddress, signer);
    const graduated: boolean = await launch.graduated();

    // Paying in USDG means swapping to the launch's quote asset first. The quote is a plain
    // ERC-20 now -- WETH for an ETH-quoted coin, cbBTC for a cbBTC-quoted one -- so a buy is
    // approve-then-pull, and there is nothing to unwrap. The "ETH" pay label means "the launch's
    // quote asset, wrapped from native at the edge for a WETH coin"; "WETH" means the user's own
    // WETH ERC-20 balance, spent directly with no wrap.
    const spendQuote = payToken === "USDG" ? await zapUsdgToQuote(addresses, launchAddress, signer, amountWad) : amountWad;

    const quoteAddress: string = await launch.quote();
    const nativeWrap = addresses.quoteZap && quoteAddress.toLowerCase() === addresses.weth.toLowerCase();
    const quote = new ethers.Contract(
      quoteAddress,
      ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"],
      signer,
    );

    const overrides = await walletTxOverrides(address, 2_000_000n);
    let tx;
    let usedPool = graduated;
    if (payToken === "ETH" && nativeWrap) {
      // "Pay in ETH" made literal: the QuoteZap wraps the native value, forwards to the launch,
      // and refunds anything unspent as native ETH -- no WETH balance or approval involved. The
      // previous path approved and pulled the user's WETH balance while the UI said ETH. The zap
      // itself re-reads `graduated()` atomically in the same transaction, so it can't race.
      const zap = new ethers.Contract(addresses.quoteZap!, QuoteZapAbi as ethers.InterfaceAbi, signer);
      tx = await zap.buyWithEth(launchAddress, minTokensOut, { ...overrides, value: spendQuote });
    } else {
      // Permit path: when the quote token speaks EIP-2612 and the allowance is short, ONE
      // typed-data signature authorizes this exact purchase inside the swap transaction — no
      // approve tx, no standing max allowance. Approve+buy remains the fallback for tokens
      // without permit support.
      const allowance = await quote.allowance(address, launchAddress);
      const canPermit =
        allowance < spendQuote && (await tokenSupportsPermit(quoteAddress, await signer.provider!));
      if (canPermit) {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
        const sig = await signEip2612(signer, quoteAddress, launchAddress, spendQuote, deadline);
        const { v, r, s } = ethers.Signature.from(sig);
        tx = await launch.buyWithPermit(spendQuote, minTokensOut, deadline, v, r, s, overrides);
        usedPool = graduated;
      } else {
        if (allowance < spendQuote) {
          await (await quote.approve(launchAddress, ethers.MaxUint256)).wait();
        }
        if (!graduated) {
          try {
            tx = await launch.buy(spendQuote, minTokensOut, overrides);
          } catch (e) {
            // The coin can graduate in the gap between the `graduated` read above and this call
            // landing -- someone else's buy filled the curve first. The quote asset is already in
            // this wallet (pulled by the USDG zap above, or the caller's own WETH/cbBTC), so retry
            // against the pool instead of leaving it stranded and the buyer with neither the coin
            // nor their original asset.
            const msg = `${(e as { reason?: string })?.reason ?? ""} ${(e as Error)?.message ?? ""}`;
            if (!/curveclosed|already graduated/i.test(msg)) throw e;
            tx = await launch.buyOnPool(spendQuote, minTokensOut, overrides);
            usedPool = true;
          }
        } else {
          tx = await launch.buyOnPool(spendQuote, minTokensOut, overrides);
        }
      }
    }
    const receipt = await tx.wait();

    const amounts = extractTradeAmounts(receipt, usedPool ? "PoolBuy" : "CurveBuy");
    if (amounts) {
      // The launch's OWN oracle and ITS scale: a cbBTC amount is 8 decimals, so both the cbBTC
      // price and the 1e10 lift to WAD are needed -- one without the other is off by orders of
      // magnitude, which is what printed $0.00 trades for cbBTC coins.
      const [collateralPriceUsd, quoteScale] = await Promise.all([
        fetchLaunchCollateralPriceUsd(launchAddress),
        launch.quoteScale() as Promise<bigint>,
      ]);
      recordTrade(launchAddress, address, {
        side: "buy",
        usdValueWad: ((amounts.amount * quoteScale * collateralPriceUsd) / WAD).toString(),
        tokenAmountWad: amounts.tokenAmount.toString(),
        timestamp: Date.now(),
      });
    }
    return receipt;
  });
}

/// What a seller walks away with. "ETH" is native ether via the QuoteZap (WETH-quoted coins only);
/// "QUOTE" is the launch's quote ERC-20 as-is (WETH or cbBTC); "USDG" converts the quote proceeds
/// through the launch's own router after the sell fills.
export type SellReceive = "ETH" | "QUOTE" | "USDG";

export async function sell(
  addresses: DeployedAddresses,
  launchAddress: string,
  tokensIn: bigint,
  minOut: bigint,
  receive: SellReceive = "QUOTE",
  // Minimum USDG out for the router leg when receive === "USDG", in USDG's 18 decimals. Ignored
  // otherwise; 0 skips the check entirely.
  minUsdgOut: bigint = 0n
) {
  await assertWalletSeesApp(addresses.factory);
  return withActiveSigner(async ({ signer, address }) => {
    const launch = getLaunch(launchAddress, signer);
    const graduated: boolean = await launch.graduated();
    const overrides = await walletTxOverrides(address, 2_000_000n);
    // WETH-quoted coins settle native-ETH sells via the QuoteZap, matching the buy side and the
    // "Sold for X ETH" message. Every other receive needs the quote as an ERC-20 -- it is the
    // input the USDG leg below swaps, and WETH itself is a legitimate payout -- so those go
    // through the plain Launch path, which transfers the quote ERC-20 straight to the seller.
    let tx;
    let usedPool = graduated;
    if (receive === "ETH" && addresses.quoteZap && (await launch.quote()).toLowerCase() === addresses.weth.toLowerCase()) {
      const zapAddress = addresses.quoteZap!;
      const meme = new ethers.Contract(
        launchAddress,
        ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"],
        signer,
      );
      if ((await meme.allowance(address, zapAddress)) < tokensIn) {
        await (await meme.approve(zapAddress, ethers.MaxUint256)).wait();
      }
      const zap = new ethers.Contract(zapAddress, QuoteZapAbi as ethers.InterfaceAbi, signer);
      tx = await zap.sellForEth(launchAddress, tokensIn, minOut, overrides);
    } else if (graduated) {
      tx = await launch.sellOnPool(tokensIn, minOut, overrides);
    } else {
      try {
        tx = await launch.sell(tokensIn, minOut, overrides);
      } catch (e) {
        // Same graduation race as buy() -- the coin can graduate between the `graduated` read
        // above and this call landing. The tokens being sold are untouched by a revert, but retry
        // against the pool anyway so the trade still fills instead of just failing.
        const msg = `${(e as { reason?: string })?.reason ?? ""} ${(e as Error)?.message ?? ""}`;
        if (!/curveclosed|already graduated/i.test(msg)) throw e;
        tx = await launch.sellOnPool(tokensIn, minOut, overrides);
        usedPool = true;
      }
    }
    const receipt = await tx.wait();

    const amounts = extractTradeAmounts(receipt, usedPool ? "PoolSell" : "CurveSell");

    // Receive in USDG: the sell leg paid out the quote ERC-20, so route it through the launch's
    // OWN router -- the same oracle-priced venue zapUsdgToQuote uses in reverse, and the only one
    // bound to this launch's collateral (a cbBTC router will not take WETH). The exact proceeds
    // come off the sell event, not the pre-trade quote, so a fill better than quoted converts in
    // full and minUsdgOut only has to cover oracle drift between the two transactions.
    if (receive === "USDG") {
      if (!amounts || amounts.amount === 0n) {
        throw new Error("Sell filled but the proceeds event was unreadable — the quote asset is in your wallet; swap to USDG from the trade page.");
      }
      const routerAddress: string = await launch.swapRouter();
      const quoteAddress: string = await launch.quote();
      const quote = new ethers.Contract(
        quoteAddress,
        ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"],
        signer,
      );
      if ((await quote.allowance(address, routerAddress)) < amounts.amount) {
        await (await quote.approve(routerAddress, ethers.MaxUint256, await walletTxOverrides(address, 200_000n))).wait();
      }
      const router = new ethers.Contract(routerAddress, OracleSwapRouterAbi as ethers.InterfaceAbi, signer);
      await (await router.swapCollateralForUsdg(amounts.amount, minUsdgOut, await walletTxOverrides(address, 500_000n))).wait();
    }

    if (amounts) {
      const [collateralPriceUsd, quoteScale] = await Promise.all([
        fetchLaunchCollateralPriceUsd(launchAddress),
        launch.quoteScale() as Promise<bigint>,
      ]);
      recordTrade(launchAddress, address, {
        side: "sell",
        usdValueWad: ((amounts.amount * quoteScale * collateralPriceUsd) / WAD).toString(),
        tokenAmountWad: amounts.tokenAmount.toString(),
        timestamp: Date.now(),
      });
    }
    return receipt;
  });
}

// ---- faucet ----

/// Send native ETH from the deployer.
///
/// The two mints below hand out ERC-20s, which is not the same thing: `mintWithEth` and every
/// bonding-curve buy are PAYABLE and spend `msg.value`, so they need the gas token itself. On a
/// fresh fork a connected wallet holds none of it, and the app reported "you have no balance" for
/// an account the faucet had just topped up -- because what it topped up was WETH, an ERC-20 that
/// a payable call cannot touch.
function toAnvilHex(amountWad: bigint): string {
  return ethers.toBeHex(amountWad, 32);
}

/// Robinhood-fork Anvil rejects setBalance on never-seen EOAs (`metadata is not found`).
/// Touch with 1 wei so the trie has the account, then set the real balance. 32-byte hex so
/// large amounts (10k ETH) are even length.
async function setNativeBalance(address: string, amountWad: bigint) {
  const provider = getProvider();
  const hex = toAnvilHex(amountWad);
  try {
    await provider.send("anvil_setBalance", [address, hex]);
    return;
  } catch {
    // new EOA
  }
  const funder = ANVIL_ACCOUNTS[2] ?? DEPLOYER;
  await withSignerLock(funder.privateKey, async () => {
    const signer = getManagedSigner(funder.privateKey);
    const tx = await signer.sendTransaction({ to: address, value: 1n, gasLimit: 21_000n });
    await tx.wait();
  });
  await provider.send("anvil_setBalance", [address, hex]);
}

export async function fundEth(to: string, amountWad: bigint) {
  try {
    const current = await getProvider().getBalance(to);
    await setNativeBalance(to, current + amountWad);
    return null;
  } catch {
    // not Anvil, or setBalance rejected after touch
  }
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const signer = getManagedSigner(DEPLOYER.privateKey);
    const tx = await signer.sendTransaction({ to, value: amountWad, gasLimit: 21_000n });
    return tx.wait();
  });
}

export async function mintUsdg(addresses: DeployedAddresses, to: string, amountWad: bigint) {
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const signer = getManagedSigner(DEPLOYER.privateKey);
    const usdg = new ethers.Contract(addresses.usdg, MockUSDGAbi as ethers.InterfaceAbi, signer);
    const tx = await usdg.mint(to, amountWad, { gasLimit: 200_000n });
    return tx.wait();
  });
}

export async function mintWeth(addresses: DeployedAddresses, to: string, amountWad: bigint) {
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const signer = getManagedSigner(DEPLOYER.privateKey);
    const weth = new ethers.Contract(addresses.weth, MockWETHAbi as ethers.InterfaceAbi, signer);
    const tx = await weth.mint(to, amountWad, { gasLimit: 200_000n });
    return tx.wait();
  });
}

/// The second quote asset's faucet. Same trust model as mintWeth: a mock ERC-20 whose mint is
/// public, signed from the shared deployer key, meaningless off a test chain. Skipped silently
/// when the deployment has no cbBTC launchpad.
export async function mintCbbtc(addresses: DeployedAddresses, to: string, amountBaseUnits: bigint) {
  if (!addresses.cbbtc) return;
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const signer = getManagedSigner(DEPLOYER.privateKey);
    const cbbtc = new ethers.Contract(addresses.cbbtc!, MockERC20Abi as ethers.InterfaceAbi, signer);
    const tx = await cbbtc.mint(to, amountBaseUnits, { gasLimit: 200_000n });
    return tx.wait();
  });
}

// ---- profile: balances, fees, holdings, launches ----

export async function fetchTokenBalance(tokenAddress: string, owner: string): Promise<bigint> {
  const token = new ethers.Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], getProvider());
  return token.balanceOf(owner);
}

export async function fetchEthBalance(owner: string): Promise<bigint> {
  return getProvider().getBalance(owner);
}

export type CreatorFees = {
  claimableCollateral: bigint;
  claimableUsd: bigint;
  lifetimeCollateral: bigint;
  lifetimeUsd: bigint;
  inHfyc: boolean;
};

export async function fetchCreatorFees(
  launchAddress: string,
  creator: string,
  collateralPriceUsd: bigint
): Promise<CreatorFees> {
  const launch = getLaunch(launchAddress, getProvider());
  void creator;
  // The creator's fees are their own field now, not an entry in a mapping shared with the
  // protocol's, so there is nothing to disentangle: a launch whose creator happens to also be the
  // fee recipient no longer double-counts.
  const [pending, claimed, inHfyc, quoteScale] = await Promise.all([
    // Renamed from *FeeEth to *FeeQuote when multi-collateral landed (fees are not always
    // literally ETH -- a cbBTC coin books cbBTC). This call site kept the old name and silently
    // read $0 pending / $0 lifetime for every creator, on every coin, since the rename.
    launch.creatorFeeQuote() as Promise<bigint>,
    launch.lifetimeCreatorFeeQuote() as Promise<bigint>,
    launch.creatorFeeInHfyc() as Promise<boolean>,
    // The fee amounts are in the coin's quote units; an 8-decimal quote needs the lift to WAD
    // before the USD price applies (1e10 for cbBTC, 1 for WETH).
    launch.quoteScale() as Promise<bigint>,
  ]);
  // With the LYC toggle set, `harvest()` converts the pending ETH and mints liquid shares
  // instead, so nothing is ever claimable here and the ETH figure only reflects what has not
  // been harvested yet.
  const claimableCollateral = inHfyc ? 0n : pending;
  const lifetimeCollateral = claimed + pending;
  return {
    claimableCollateral,
    claimableUsd: (claimableCollateral * quoteScale * collateralPriceUsd) / WAD,
    lifetimeCollateral,
    lifetimeUsd: (lifetimeCollateral * quoteScale * collateralPriceUsd) / WAD,
    inHfyc,
  };
}

export async function claimFees(launchAddress: string) {
  await assertWalletSeesApp(launchAddress);
  return withActiveSigner(async ({ signer, address }) => {
    const launch = getLaunch(launchAddress, signer);
    const tx = await launch.claimCreatorFees(await walletTxOverrides(address, 500_000n));
    return tx.wait();
  });
}

/// Permissionless. A launch that graduated while the LYC queue was short lists at 1x until
/// this succeeds. The public app had no caller for it, so coins stayed unlevered even after
/// idle cash arrived.
export async function tryPairLaunch(launchAddress: string) {
  await assertWalletSeesApp(launchAddress);
  return withActiveSigner(async ({ signer, address }) => {
    const launch = getLaunch(launchAddress, signer);
    const tx = await launch.tryPair(await walletTxOverrides(address, 2_000_000n));
    return tx.wait();
  });
}

export async function protectLaunch(launchAddress: string) {
  await assertWalletSeesApp(launchAddress);
  return withActiveSigner(async ({ signer, address }) => {
    const launch = getLaunch(launchAddress, signer);
    const tx = await launch.protect(await walletTxOverrides(address, 2_000_000n));
    return tx.wait();
  });
}

export async function graduateLaunch(launchAddress: string) {
  await assertWalletSeesApp(launchAddress);
  return withActiveSigner(async ({ signer, address }) => {
    const launch = getLaunch(launchAddress, signer);
    const tx = await launch.graduate(await walletTxOverrides(address, 8_000_000n));
    return tx.wait();
  });
}

/// Keeper-signed variants. tryPair/protect/graduate are permissionless; the deployer key is
/// used so pairing does not depend on a connected wallet being on the page.
async function keeperSend(launchAddress: string, method: "tryPair" | "protect" | "graduate") {
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const launch = getLaunch(launchAddress, getManagedSigner(DEPLOYER.privateKey));
    // Skip eth_estimateGas — the Robinhood fork returns `metadata is not found` for it.
    const gasLimit = method === "graduate" ? 8_000_000n : 2_000_000n;
    const tx = await launch[method]({ gasLimit });
    return tx.wait();
  });
}

export async function keeperTryPair(launchAddress: string) {
  return keeperSend(launchAddress, "tryPair");
}

export async function keeperTryPairUpTo(launchAddress: string, maxUsd: bigint) {
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const launch = getLaunch(launchAddress, getManagedSigner(DEPLOYER.privateKey));
    const tx = await launch.tryPairUpTo(maxUsd, { gasLimit: 2_000_000n });
    return tx.wait();
  });
}

export async function keeperProtect(launchAddress: string) {
  return keeperSend(launchAddress, "protect");
}

/// Settle booked meme-trade fees into LYC: holder 50 bps as unminted NAV yield, protocol
/// 45 bps as a fee-mint. Without this the ETH sits in the launch, excluded from TVL, and
/// LYC holders never see the trade-fee APY the spec assigns them.
export async function keeperHarvest(launchAddress: string) {
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const launch = getLaunch(launchAddress, getManagedSigner(DEPLOYER.privateKey));
    const tx = await launch.harvest({ gasLimit: 2_000_000n });
    return tx.wait();
  });
}

/// Move vault ETH the senior claim no longer needs into the AMM reserve.
///
/// This replaces the old rally-side relever here: re-levering is now a priced route that an
/// arbitrageur fills, not something a keeper executes with the protocol's own cash. What a keeper
/// can still usefully do unilaterally is the bucket correction, which trades nothing and leaves
/// TVL, junior NAV and leverage all unchanged.
export async function keeperRebalanceToReserve(launchAddress: string) {
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const launch = getLaunch(launchAddress, getManagedSigner(DEPLOYER.privateKey));
    const tx = await launch.rebalanceToReserve({ gasLimit: 2_000_000n });
    return tx.wait();
  });
}

/// One tx settles occupancy on up to 32 pools so the NAV index does not depend on N keeper pokes.
export async function keeperAccruePools(lycAddress: string, pools: string[]) {
  if (pools.length === 0) return null;
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const h = getLyc(lycAddress, getManagedSigner(DEPLOYER.privateKey));
    const tx = await h.accruePools(pools.slice(0, 32), { gasLimit: 8_000_000n });
    return tx.wait();
  });
}

export async function keeperGraduate(launchAddress: string) {
  return keeperSend(launchAddress, "graduate");
}

export async function keeperReallocate(dst: string, src: string, usdAmount: bigint) {
  return withSignerLock(DEPLOYER.privateKey, async () => {
    const launch = getLaunch(dst, getManagedSigner(DEPLOYER.privateKey));
    const tx = await launch.reallocateFrom(src, usdAmount, { gasLimit: 2_000_000n });
    return tx.wait();
  });
}

/// OracleSwapRouter fills at the oracle with no AMM reserves. Kept as a no-op so older callers
/// that used to re-peg MockSwapRouter compile without sending a doomed addLiquidity.
export async function syncRouterToOracle(_addresses: DeployedAddresses) {
  return;
}

export type ClaimRecord = {
  token: string;
  amount: bigint;
  amountUsd: bigint;
  timestamp: number;
  tx: string;
};

export async function fetchClaimHistory(
  launches: LaunchSummary[],
  creator: string,
  // Unused: each launch's claim is converted at its OWN oracle mark (launch.collateralPriceUsd).
  // A single global price was the ETH oracle, which misstated cbBTC coins by the ETH/BTC ratio.
  // Kept in the signature so existing callers keep compiling.
  collateralPriceUsd?: bigint
): Promise<ClaimRecord[]> {
  void collateralPriceUsd;
  const provider = getProvider();
  const records: ClaimRecord[] = [];

  for (const launch of launches) {
    try {
      const contract = getLaunch(launch.address, provider);
      const filter = contract.filters.CreatorFeesClaimed();
      const events = await contract.queryFilter(filter);
      for (const e of events) {
        if (!("args" in e)) continue;
        const to = (e.args[0] as string).toLowerCase();
        if (to !== creator.toLowerCase()) continue;
        const amount = e.args[1] as bigint;
        const amountUsd = (amount * launch.collateralPriceUsd) / WAD;
        const block = await provider.getBlock(e.blockNumber);
        records.push({
          token: launch.address,
          amount,
          amountUsd,
          timestamp: block ? block.timestamp * 1000 : Date.now(),
          tx: e.transactionHash,
        });
      }
    } catch {
      // skip launches that fail
    }
  }

  return records.sort((a, b) => b.timestamp - a.timestamp);
}

export async function fetchLaunchesByCreator(addresses: DeployedAddresses, creator: string): Promise<LaunchSummary[]> {
  const all = await fetchAllLaunches(addresses);
  return all.filter((l) => l.creator.toLowerCase() === creator.toLowerCase());
}

export type HeldLaunch = LaunchSummary & { tokenBalance: bigint; valueUsd: bigint; pnlUsd: bigint };

export async function fetchHoldings(addresses: DeployedAddresses, holder: string): Promise<HeldLaunch[]> {
  const all = await fetchAllLaunches(addresses);
  const withBalances = await Promise.all(
    all.map(async (l) => ({ l, bal: await fetchTokenBalance(l.address, holder).catch(() => 0n) }))
  );
  return withBalances
    .filter(({ bal }) => bal > 0n)
    .map(({ l, bal }) => {
      const valueUsd = (bal * l.priceUsd) / WAD;
      const pnlUsd = computePnl(summarizePosition(l.address, holder), bal, l.priceUsd);
      return { ...l, tokenBalance: bal, valueUsd, pnlUsd };
    });
}

// ---- formatting ----

export function formatWad(value: bigint | number | string | null | undefined, decimals = 2): string {
  if (value == null) return "";
  let v: bigint;
  try {
    if (typeof value === "bigint") v = value;
    else if (typeof value === "number") v = BigInt(Math.trunc(value));
    else if (typeof value === "string") v = BigInt(value);
    else return "";
  } catch {
    return "";
  }
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / WAD;
  const frac = abs % WAD;
  const fracStr = frac.toString().padStart(18, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${decimals > 0 ? "." + fracStr : ""}`;
}

/// No thousands separators — safe for CSV cells.
export function formatWadPlain(value: bigint, decimals = 8): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / WAD;
  const frac = abs % WAD;
  const fracStr = frac.toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "") || "0";
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

export function usd(value: bigint, decimals = 2): string {
  return `$${formatWad(value, decimals)}`;
}

export function usdCompact(value: bigint): string {
  const n = Number(value) / 1e18;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

const PRICE_SUB = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"] as const;
function priceToSub(n: number | string): string {
  return String(n)
    .split("")
    .map((d) => PRICE_SUB[Number(d)] ?? d)
    .join("");
}

export function priceLabel(value: bigint): string {
  const n = Number(value) / 1e18;
  if (n === 0) return "$0";
  if (n >= 0.001) return `$${n.toPrecision(4)}`;
  const s = n.toFixed(20);
  const m = s.match(/^0\.(0+)(\d{1,4})/);
  if (!m) return `$${n.toExponential(2)}`;
  return `$0.0${priceToSub(m[1].length)}${m[2]}`;
}

export function priceLabelParts(value: bigint): { before: string; zeros: string; after: string } {
  const n = Number(value) / 1e18;
  if (n === 0) return { before: "$0", zeros: "", after: "" };
  if (n >= 0.001) return { before: `$${n.toPrecision(4)}`, zeros: "", after: "" };
  const s = n.toFixed(20);
  const m = s.match(/^0\.(0+)(\d{1,4})/);
  if (!m) return { before: `$${n.toExponential(2)}`, zeros: "", after: "" };
  return { before: "$0.0", zeros: String(m[1].length), after: String(m[2]) };
}
