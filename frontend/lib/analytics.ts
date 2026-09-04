import { ethers } from "ethers";
import { DeployedAddresses } from "./chain";
import { LaunchSummary, WAD, fetchAllLaunches, getLaunch, getProvider, getLyc } from "./launchpad";
import { TradePoint, isTrade, tradesFor } from "./launchStats";

// Mirrors Launch.sol's fee schedule. Creator's 50 bps is flat; the rest (50 bps) splits between
// protocol and LYC, LYC earning up to 5 of it, scaled per-trade by seniorUsd/memeNAV on that
// specific pool (see Launch._accrueFeeQuote) -- not a static ratio, so these constants describe
// only the creator/floor-protocol shape, not LYC's variable slice.
const CREATOR_FEE_BPS = 50n;
const PROTOCOL_FEE_BPS = 45n; // floor -- rises toward 50 as LYC's slice shrinks toward 0
const TOTAL_FEE_BPS = 100n;

export type TopPnl = {
  address: string;
  realizedUsd: number;
  volumeUsd: number;
  trades: number;
};

export type DailyStat = {
  date: string; // "Aug 29" format
  value: number;
};

/// One day's buy-vs-sell volume split, for the market-pressure chart.
export type DailyPressure = {
  date: string;
  buyUsd: number;
  sellUsd: number;
};

/// Platform-wide rebalance activity, aggregated from the same event scan that feeds the coin
/// pages' trade history (Protected / Relevered / SeniorReleased / Paired / SeniorNetted /
/// RebalancedToReserve).
export type RebalanceStats = {
  /// Executed rebalance operations, all time.
  total: number;
  /// USD value of collateral the operations moved (the events' USD legs, summed).
  usdMoved: number;
  /// Operations in the last 24h.
  last24h: number;
  /// Timestamp (ms) of the most recent operation, null if none recorded.
  lastTs: number | null;
  counts: { protect: number; relever: number; release: number; paired: number; netted: number; reserve: number };
};

export type PlatformAnalytics = {
  /// USD value of every WETH the protocol holds, across every coin. See fetchPlatformAnalytics for
  /// exactly which balances that covers.
  tvlUsd: number;
  /// The senior claim on that collateral, i.e. what LYC holders are owed. Nothing is borrowed in
  /// this model -- leverage comes from pairing against senior capital, not from a lending market --
  /// so the meaningful split is senior versus junior, not gross versus debt.
  seniorUsd: number;
  /// The residual: what memecoin holders own once the senior is subtracted. This is the number
  /// that takes 100% of the collateral's price movement, in both directions.
  juniorUsd: number;
  totalVolumeUsd: number;
  volume24hUsd: number;
  /// Trading-fee protocol slice only: booked-but-unharvested ETH across every coin, plus the
  /// treasury's current liquid LYC balance once harvested. See lycMintFeesUsd/lycRedeemFeesUsd
  /// below for the OTHER protocol fee -- LYC's own mint/redeem fee is a separate, lifetime-total
  /// figure and deliberately not folded into this one to avoid double-counting when the same
  /// address holds both (the common case, but not guaranteed -- `EarnPool.owner` and
  /// `LaunchpadFactory.protocolFeeRecipient` are independently settable).
  protocolFeesUsd: number;
  creatorFeesUsd: number;
  claimedCreatorFeesUsd: number;
  /// Lifetime USD value of LYC's mint fee (0.10% of every deposit) and redeem fee (0.25% of every
  /// covered exit). Both mint as liquid LYC directly to `EarnPool.owner` -- a protocol fee, not a
  /// NAV lift shared with every holder -- so unlike protocolFeesUsd above, these read straight off
  /// EarnPool's own cumulative counters rather than inferring anything from a wallet balance.
  lycMintFeesUsd: number;
  lycRedeemFeesUsd: number;
  totalLaunches: number;
  totalGraduated: number;
  activeTraders24h: number;
  totalTrades: number;
  /// The senior side. `borrowedUsd` above describes the junior's leverage; these describe who is
  /// lending it and what they are being paid.
  lycNav: number;
  lycLiability: number;
  lycIdleUsdc: number;
  lycGlobalCr: number;
  /// Share of the senior book at work, and the APR pools pay to rent it. The two move together by
  /// construction -- a starved book pays more, which is what refills it.
  seniorUtilization: number;
  fundingApr: number;
  topPnl: TopPnl[];
  launches: LaunchSummary[];
  dailyVolume: DailyStat[];
  dailyLaunches: DailyStat[];
  /// Per-day buy vs sell volume, for the market-pressure chart.
  dailyPressure: DailyPressure[];
  /// Unique wallets that traded each day.
  dailyTraders: DailyStat[];
  /// Protocol rebalance activity across all coins.
  rebalances: RebalanceStats;
  /// Individual trades (not volume) in the last 24h.
  trades24h: number;
  /// Median hours from a coin's first trade to its graduation pairing, across coins where both
  /// timestamps are known. Null when no coin has graduated with a readable timeline.
  medianGraduationHours: number | null;
};

export const EMPTY_ANALYTICS: PlatformAnalytics = {
  tvlUsd: 0,
  seniorUsd: 0,
  juniorUsd: 0,
  totalVolumeUsd: 0,
  volume24hUsd: 0,
  protocolFeesUsd: 0,
  creatorFeesUsd: 0,
  claimedCreatorFeesUsd: 0,
  lycMintFeesUsd: 0,
  lycRedeemFeesUsd: 0,
  lycNav: 1,
  lycLiability: 0,
  lycIdleUsdc: 0,
  lycGlobalCr: 0,
  seniorUtilization: 0,
  fundingApr: 0,
  totalLaunches: 0,
  totalGraduated: 0,
  activeTraders24h: 0,
  totalTrades: 0,
  topPnl: [],
  launches: [],
  dailyVolume: [],
  dailyLaunches: [],
  dailyPressure: [],
  dailyTraders: [],
  rebalances: { total: 0, usdMoved: 0, last24h: 0, lastTs: null, counts: { protect: 0, relever: 0, release: 0, paired: 0, netted: 0, reserve: 0 } },
  trades24h: 0,
  medianGraduationHours: null,
};

/// Realized P&L per trader, across every coin, derived purely from their own trades.
///
/// Deliberately REALIZED only (cash out minus cash in), not marked-to-market: a trader's current
/// holdings are visible on-chain, but what they paid for them is not, and the app's own cost-basis
/// ledger only covers trades made through this app with this wallet. Ranking on a number that is
/// exact for some wallets and guessed for others would make the leaderboard meaningless, so this
/// ranks on the part that is exactly knowable from events alone.
function computeTopPnl(allTrades: TradePoint[], limit: number): TopPnl[] {
  const byTrader = new Map<string, { spent: number; received: number; volume: number; trades: number }>();
  for (const t of allTrades) {
    const row = byTrader.get(t.trader) ?? { spent: 0, received: 0, volume: 0, trades: 0 };
    if (t.isBuy) row.spent += t.volumeUsd;
    else row.received += t.volumeUsd;
    row.volume += t.volumeUsd;
    row.trades += 1;
    byTrader.set(t.trader, row);
  }
  return Array.from(byTrader.entries())
    .map(([address, r]) => ({
      address,
      realizedUsd: r.received - r.spent,
      volumeUsd: r.volume,
      trades: r.trades,
    }))
    // Only wallets that have actually sold something have a realized result to rank; a wallet that
    // has only bought shows a large negative that just means "still holding", not "losing".
    .filter((r) => r.realizedUsd !== 0)
    .sort((a, b) => b.realizedUsd - a.realizedUsd)
    .slice(0, limit);
}

/// Platform-wide numbers for the analytics page, aggregated across every coin on the factory.
export async function fetchPlatformAnalytics(addresses: DeployedAddresses): Promise<PlatformAnalytics> {
  const launches = await fetchAllLaunches(addresses);
  // No early return on zero launches: LYC can hold real deposits, mint fees, and a protocol
  // treasury balance before a single coin has ever been created (a plain mintWithUsdg needs no
  // launch to exist), and this function's own LYC-reading block below is unconditional. Bailing
  // out here used to zero the entire page -- NAV, liability, mint/redeem fees, all of it -- the
  // moment there were no coins yet, regardless of what had actually happened on the senior side.
  // Every loop and block below already handles an empty `launches` safely (see the explicit
  // `launches.length > 0` guard further down for the one place that needed it).
  const now = Date.now();
  const dayAgo = now - 86_400_000;

  let totalVolumeUsd = 0;
  let volume24hUsd = 0;
  let totalTrades = 0;
  let trades24h = 0;
  const traders24h = new Set<string>();
  const allTrades: TradePoint[] = [];
  // Unfiltered: rebalance points are excluded from every trading figure but feed the rebalance
  // section. TradePoint carries no launch address, so graduation pairing is attributed per launch
  // here rather than recovered from the flat list.
  const allPoints: TradePoint[] = [];
  const pairedFirstTs = new Map<string, number>();

  for (const l of launches) {
    // Reuses the per-launch trade log the coin table already built and cached, so the analytics
    // page costs no extra chain reads beyond what the app was polling anyway.
    //
    // Filtered to real trades: the log also carries protocol rebalances, which have no trader and
    // no traded volume. Counting them put a synthetic "protocol" wallet at the top of the P&L
    // leaderboard with +$3.7B and inflated total volume by ~200x, which in turn broke the one
    // cross-check that makes this page trustworthy -- fees landing at 1.25% of volume.
    const points = tradesFor(l.address);
    const trades = points.filter(isTrade);
    for (const t of trades) {
      totalVolumeUsd += t.volumeUsd;
      totalTrades += 1;
      if (t.ts >= dayAgo) {
        volume24hUsd += t.volumeUsd;
        trades24h += 1;
        traders24h.add(t.trader);
      }
    }
    allTrades.push(...trades);
    allPoints.push(...points);
    // Points are appended in block order, so the first find is the earliest pairing.
    const firstPaired = points.find((p) => p.type === "rebalance" && p.rebalanceType === "paired");
    if (firstPaired) pairedFirstTs.set(l.address.toLowerCase(), firstPaired.ts);
  }

  // Collateral lives in exactly two places per coin, and TVL is their sum:
  //   1. the Launch contract's own WETH balance -- which covers the bonding-curve raise before
  //      graduation, and afterwards the AMM pool's reserve, the unlevered bucket, and fees accrued
  //      but not yet claimed (Launch.liveAt decomposes this same balance); and
  //   2. collateral supplied into the lending pool to back the loop.
  // Nothing else holds protocol collateral and the two never overlap, so summing them can't
  // double-count.
  // TVL is accumulated in USD-WAD per launch, not summed in raw collateral: a mixed deployment
  // holds WETH on one coin and cbBTC on another, and adding those balances together is a sum of
  // two different units. Each launch is converted at its OWN oracle mark.
  let tvlUsdWei = 0n;
  let borrowedUsdWei = 0n;

  // Every balance below is read at ONE pinned block. Without this each call lands at whatever
  // block is current when it resolves, so with trading in flight the four coins are sampled at
  // four different moments and the total is a blend of states that never simultaneously existed --
  // it visibly oscillated by several percent between refreshes, above and below the true figure.
  // A single blockTag makes TVL a consistent snapshot.
  let blockTag: number | undefined;
  try {
    blockTag = await getProvider().getBlockNumber();
  } catch {
    // no pinned block available -- fall back to latest, which is still better than failing
  }

  // Fees are read from the contracts rather than inferred from volume: they're the authoritative
  // record of what was actually charged, including anything already claimed.
  let protocolFeesUsd = 0;
  let creatorFeesUsd = 0;
  let claimedCreatorFeesUsd = 0;
  await Promise.all(
    launches.map(async (l) => {
      try {
        const launch = getLaunch(l.address, getProvider());
        // The launch's OWN quote asset -- WETH for one launchpad, cbBTC for the other. Reading
        // the WETH contract's balanceOf for every launch silently zeroed the cbBTC coins.
        const quoteToken: string = await launch.quote();
        const [heldOnLaunch, poolEth] = (await Promise.all([
          new ethers.Contract(quoteToken, ["function balanceOf(address) view returns (uint256)"], getProvider()).balanceOf(l.address, { blockTag }),
          launch.poolEth({ blockTag }),
        ])) as [bigint, bigint];
        // quoteScale lifts an 8-decimal cbBTC balance to WAD before the USD price applies --
        // without it every cbBTC coin contributed ~1e10th of its real TVL.
        tvlUsdWei += ((heldOnLaunch + poolEth) * l.quoteScale * l.collateralPriceUsd) / WAD;
        const toUsd = (v: bigint) => Number((v * l.quoteScale * l.collateralPriceUsd) / WAD) / 1e18;

        // Creator and protocol fees are separate fields on the launch, so each is read once for
        // what it is. The previous contract credited both into one address-keyed mapping, which
        // meant a coin whose creator WAS the treasury had a single entry holding both cuts --
        // read once per role, that counted the whole thing twice and reported total fees at 1.67%
        // of volume against a 1.25% schedule. There is nothing to split apart any more.
        // Renamed from *FeeEth to *FeeQuote when multi-collateral landed. This call site kept the
        // old name, so every one of these calls threw (caught below, contributing 0) and the
        // Protocol/Creator fee tiles on this page have read $0 regardless of actual volume.
        const [creatorPending, creatorClaimed, protocolPending] = await Promise.all([
          launch.creatorFeeQuote() as Promise<bigint>,
          launch.lifetimeCreatorFeeQuote() as Promise<bigint>,
          launch.protocolFeeQuote() as Promise<bigint>,
        ]);

        const creatorLifetime = creatorPending + creatorClaimed;
        creatorFeesUsd += toUsd(creatorLifetime);
        l.creatorFeesUsd = toUsd(creatorLifetime);
        claimedCreatorFeesUsd += toUsd(creatorClaimed);

        // Only the ETH still awaiting harvest. Once harvested the protocol's slice exists as
        // liquid LYC in the treasury, which is a single global position -- added once after this
        // loop rather than per launch, or it would be multiplied by the launch count.
        protocolFeesUsd += toUsd(protocolPending);
      } catch {
        // a launch that can't be read just contributes nothing rather than failing the page
      }
    })
  );

  // The protocol's harvested fees live as liquid LYC in the treasury -- one global position, so
  // it is added exactly once here rather than inside the per-launch loop above, where it would
  // have been multiplied by the number of launches.
  if (launches.length > 0) {
    try {
      const lyc = getLyc(addresses.lyc);
      const treasury: string = await getLaunch(launches[0].address, getProvider()).feeRecipient();
      const [held, nav] = await Promise.all([
        lyc.balanceOf(treasury) as Promise<bigint>,
        lyc.nav() as Promise<bigint>,
      ]);
      protocolFeesUsd += Number((held * nav) / WAD) / 1e18;
    } catch {
      // nothing harvested yet, or LYC unreachable -- the pending ETH legs still stand
    }
  }

  // The senior book, read in one pass. Reported even with no launches yet: the queue and the
  // funding rate exist from the moment LYC does, and the rate is what tells a would-be depositor
  // whether now is a good time.
  let lycNav = 1;
  let lycLiability = 0;
  let lycIdleUsdc = 0;
  let lycGlobalCr = 0;
  let seniorUtilization = 0;
  let fundingApr = 0;
  let lycMintFeesUsd = 0;
  let lycRedeemFeesUsd = 0;
  try {
    const lyc = getLyc(addresses.lyc);
    const [navW, liabW, idleW, crW, utilW, rateW, mintFeeW, redeemFeeW] = await Promise.all([
      lyc.nav() as Promise<bigint>,
      lyc.liability() as Promise<bigint>,
      lyc.idleUsdg() as Promise<bigint>,
      lyc.globalCr() as Promise<bigint>,
      lyc.utilizationWad() as Promise<bigint>,
      lyc.fundingRateWad() as Promise<bigint>,
      lyc.totalMintFeeUsd() as Promise<bigint>,
      lyc.totalRedeemFeeUsd() as Promise<bigint>,
    ]);
    lycNav = Number(navW) / 1e18;
    lycLiability = Number(liabW) / 1e18;
    lycIdleUsdc = Number(idleW) / 1e18;
    lycMintFeesUsd = Number(mintFeeW) / 1e18;
    lycRedeemFeesUsd = Number(redeemFeeW) / 1e18;
    // Uninitialised books report max uint; showing that as a cover ratio would be nonsense.
    lycGlobalCr = liabW === 0n ? 0 : Number(crW) / 1e18;
    seniorUtilization = Number(utilW) / 1e18;
    fundingApr = Number(rateW) / 1e18;
  } catch {
    // no LYC reachable -- the rest of the page still stands
  }

  const tvlUsd = Number(tvlUsdWei) / 1e18;
  // liability + SUM memeNAV == SUM TVL + idle, so the junior side follows from the identity
  // rather than needing its own per-launch pass.
  const juniorUsd = Math.max(0, tvlUsd + lycIdleUsdc - lycLiability);
  void borrowedUsdWei;

  // Compute daily volume and daily launches for the last 14 days
  const dailyVolumeMap = new Map<string, number>();
  const dailyLaunchesMap = new Map<string, number>();
  const dailyBuyMap = new Map<string, number>();
  const dailySellMap = new Map<string, number>();
  const dailyTraderSets = new Map<string, Set<string>>();
  const DAY_MS = 86_400_000;
  const daysToShow = 14;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Initialize all days with 0
  for (let i = 0; i < daysToShow; i++) {
    const d = new Date(today.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    dailyVolumeMap.set(key, 0);
    dailyLaunchesMap.set(key, 0);
    dailyBuyMap.set(key, 0);
    dailySellMap.set(key, 0);
    dailyTraderSets.set(key, new Set());
  }

  const dayKey = (ts: number): string => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  };

  // Aggregate volume, buy/sell pressure and unique traders by day
  for (const t of allTrades) {
    const key = dayKey(t.ts);
    if (dailyVolumeMap.has(key)) {
      dailyVolumeMap.set(key, (dailyVolumeMap.get(key) ?? 0) + t.volumeUsd);
    }
    if (dailyBuyMap.has(key)) {
      if (t.isBuy) dailyBuyMap.set(key, (dailyBuyMap.get(key) ?? 0) + t.volumeUsd);
      else dailySellMap.set(key, (dailySellMap.get(key) ?? 0) + t.volumeUsd);
    }
    dailyTraderSets.get(key)?.add(t.trader);
  }

  // Aggregate launches by day (using stats.createdAt if available)
  for (const l of launches) {
    if (l.stats.createdAt) {
      const key = dayKey(l.stats.createdAt);
      if (dailyLaunchesMap.has(key)) {
        dailyLaunchesMap.set(key, (dailyLaunchesMap.get(key) ?? 0) + 1);
      }
    }
  }

  // Protocol rebalance activity: every point the coin-page scan already decoded, aggregated.
  // skimmedUsd is populated for every rebalance sub-type (see launchStats.ts) -- the event's own
  // USD leg, not fabricated from price.
  const counts = { protect: 0, relever: 0, release: 0, paired: 0, netted: 0, reserve: 0 };
  let rebalanceUsdMoved = 0;
  let rebalancesLast24h = 0;
  let rebalanceLastTs: number | null = null;
  for (const p of allPoints) {
    if (p.type !== "rebalance" || !p.rebalanceType) continue;
    counts[p.rebalanceType] += 1;
    rebalanceUsdMoved += p.skimmedUsd ?? 0;
    if (p.ts >= dayAgo) rebalancesLast24h += 1;
    if (rebalanceLastTs === null || p.ts > rebalanceLastTs) rebalanceLastTs = p.ts;
  }

  // Graduation velocity: first trade -> first Paired, per graduated coin. Coins missing either
  // timestamp are skipped rather than counted as instant.
  const gradHours: number[] = [];
  for (const l of launches) {
    if (!l.graduated || !l.stats.createdAt) continue;
    const pairedTs = pairedFirstTs.get(l.address.toLowerCase());
    if (!pairedTs || pairedTs < l.stats.createdAt) continue;
    gradHours.push((pairedTs - l.stats.createdAt) / 3_600_000);
  }
  gradHours.sort((a, b) => a - b);
  const medianGraduationHours = gradHours.length > 0 ? gradHours[Math.floor(gradHours.length / 2)] : null;

  // Convert to arrays, oldest first, with short date labels
  const formatShortDate = (dateStr: string): string => {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const dailyVolume: DailyStat[] = Array.from(dailyVolumeMap.entries())
    .map(([date, value]) => ({ date: formatShortDate(date), value }))
    .reverse();

  const dailyLaunches: DailyStat[] = Array.from(dailyLaunchesMap.entries())
    .map(([date, value]) => ({ date: formatShortDate(date), value }))
    .reverse();

  const dailyPressure: DailyPressure[] = Array.from(dailyBuyMap.entries())
    .map(([date, buyUsd]) => ({ date: formatShortDate(date), buyUsd, sellUsd: dailySellMap.get(date) ?? 0 }))
    .reverse();

  const dailyTraders: DailyStat[] = Array.from(dailyTraderSets.entries())
    .map(([date, set]) => ({ date: formatShortDate(date), value: set.size }))
    .reverse();

  return {
    tvlUsd,
    seniorUsd: lycLiability,
    juniorUsd,
    totalVolumeUsd,
    volume24hUsd,
    protocolFeesUsd,
    creatorFeesUsd,
    claimedCreatorFeesUsd,
    lycMintFeesUsd,
    lycRedeemFeesUsd,
    lycNav,
    lycLiability,
    lycIdleUsdc,
    lycGlobalCr,
    seniorUtilization,
    fundingApr,
    totalLaunches: launches.length,
    totalGraduated: launches.filter((l) => l.graduated).length,
    activeTraders24h: traders24h.size,
    totalTrades,
    topPnl: computeTopPnl(allTrades, 8),
    launches,
    dailyVolume,
    dailyLaunches,
    dailyPressure,
    dailyTraders,
    rebalances: {
      total: counts.protect + counts.relever + counts.release + counts.paired + counts.netted + counts.reserve,
      usdMoved: rebalanceUsdMoved,
      last24h: rebalancesLast24h,
      lastTs: rebalanceLastTs,
      counts,
    },
    trades24h,
    medianGraduationHours,
  };
}


