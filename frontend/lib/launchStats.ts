import { ethers } from "ethers";
import { getProvider } from "./signers";
import { getLaunch } from "./launchpad";

const WAD = 10n ** 18n;

/// One executed trade, normalized across both venues (bonding curve and post-graduation market)
/// into the same units so they can be charted and summed as one continuous series.
export type TradePoint = {
  ts: number; // ms epoch
  priceUsd: number; // USD per token, as actually executed
  volumeUsd: number; // USD value of the trade
  collateral: number; // the same trade in ETH, for anywhere that quotes the native leg
  tokenAmount: number;
  trader: string;
  isBuy: boolean;
  /// "trade" is a real user buy/sell; "rebalance" is a protocol operation with no trader, no
  /// tokens, and no price. They share this log because the coin page shows one combined feed, but
  /// every TRADING statistic (volume, txn count, unique traders, ATH, price change, sparkline,
  /// P&L) must count only the former -- see isTrade.
  type: "buy" | "sell" | "rebalance";
  tx: string;
  /// Rebalance-specific fields
  /// Rebalance only. USD, because that is the unit Launch.sol's Rebalanced event emits for its
  /// first argument (skimUsd -- the contract divides it BY the price to get a quantity). It was
  /// previously stored as if it were collateral and then multiplied by the ETH price again, which
  /// inflated a $1k skim into ~$2.5M of phantom volume.
  skimmedUsd?: number;
  /// Rebalance only. The loop leverage the rebalance targeted (Rebalanced.newLoopLev, WAD).
  newLoopLev?: number;
  /// Rebalance sub-type: "protect" (deleverage), "relever" (re-lever), "release" (senior reallocation), or "paired" (first senior attach after graduation)
  rebalanceType?: "protect" | "relever" | "release" | "paired";
};

/// A real user trade, as opposed to a protocol rebalance. Every aggregate below filters on this.
export function isTrade(p: TradePoint): boolean {
  return p.type !== "rebalance";
}

export type LaunchStats = {
  createdAt: number | null; // null = unknown (no trades seen and no creation block)
  athUsd: number;
  txnCount: number;
  volume24hUsd: number;
  traderCount: number;
  change1h: number | null; // null = no trades in that window, rendered as "—" not "0%"
  change6h: number | null;
  change24h: number | null;
  spark: number[]; // price series for the row sparkline
};

export const EMPTY_STATS: LaunchStats = {
  createdAt: null,
  athUsd: 0,
  txnCount: 0,
  volume24hUsd: 0,
  traderCount: 0,
  change1h: null,
  change6h: null,
  change24h: null,
  spark: [],
};

// Block timestamps never change once mined, so they're cached permanently. Without this, building
// the table meant one getBlock round-trip per event per launch per refresh -- hundreds of
// sequential RPC calls every few seconds, which is what made the table crawl.
const blockTimeCache = new Map<number, number>();

/// The first block worth scanning: the block the current deployment was created in.
///
/// Every `getLogs` below used to start at 0. On Anvil that is genuinely cheap -- the fork's own
/// history is a handful of local blocks. On the Robinhood testnet the chain is past block
/// 111,900,000, so each scan asked a rate-limited public RPC to walk the whole chain, and the
/// launch list re-issued 7 of them PER COIN on every page load plus 1 per factory on every 3s
/// refresh. Nothing this app cares about can predate its own deployment, so starting there costs
/// nothing and removes the largest query on the page.
///
/// Left at 0 when the deployment record carries no block (the local fork, and any deployment file
/// written before `deployBlock` existed) -- which is exactly the previous behaviour.
let scanStartBlock = 0;

export function setScanStartBlock(block: number | undefined | null): void {
  const next = typeof block === "number" && Number.isFinite(block) && block > 0 ? Math.floor(block) : 0;
  if (next === scanStartBlock) return;
  // A different deployment means a different history; anything already scanned belongs to the
  // old one.
  scanStartBlock = next;
  resetStatsCache();
}

// Per-launch trade log plus the block we've already scanned up to, so each refresh queries only
// the new blocks instead of re-fetching the coin's entire history every time.
type LaunchCache = {
  nextFromBlock: number;
  trades: TradePoint[];
  traders: Set<string>;
  /// "tx:logIndex" of every event already recorded. The in-flight guard below prevents the overlap
  /// that caused duplicates, but this makes a double-append structurally impossible rather than
  /// merely unlikely -- any future re-scan of an already-seen range is now idempotent.
  seen: Set<string>;
  /// 10**(18 - quoteDecimals): lifts the launch's quote amounts to WAD before they meet a USD
  /// price. Resolved once per launch; 1 for WETH, 1e10 for cbBTC.
  quoteScale: bigint;
};
const launchCache = new Map<string, LaunchCache>();

/// One scan per launch at a time. Two pollers read this log -- the launch list (every 2s, via
/// fetchLaunchSummary) and the coin page's activity feed (every 5s) -- and they interleaved: both
/// read the same nextFromBlock, both queried the same range, and both appended the same events, so
/// every trade and rebalance appeared twice in the feed. Concurrent callers now await the same
/// scan instead of racing it.
const inFlight = new Map<string, Promise<LaunchStats>>();

/// Chain state is wiped when Anvil restarts and addresses are reused across deployments, so a
/// stale cache would otherwise report a previous deployment's trades against a brand-new coin at
/// the same address.
export function resetStatsCache() {
  blockTimeCache.clear();
  launchCache.clear();
  creationCache.clear();
}

/// The trade log already scanned for a launch. Lets the analytics page aggregate across every coin
/// without re-reading the chain -- the coin table's polling has already paid for this.
export function tradesFor(launchAddress: string): TradePoint[] {
  return launchCache.get(launchAddress.toLowerCase())?.trades ?? [];
}

async function blockTimes(blockNumbers: number[]): Promise<Map<number, number>> {
  const provider = getProvider();
  const missing = [...new Set(blockNumbers)].filter((b) => !blockTimeCache.has(b));
  // Batched, not sequential: these are independent reads and the provider pipelines them.
  const fetched = await Promise.all(
    missing.map(async (b) => {
      try {
        const block = await provider.getBlock(b);
        return [b, block ? block.timestamp * 1000 : null] as const;
      } catch {
        return [b, null] as const;
      }
    })
  );
  for (const [b, t] of fetched) if (t !== null) blockTimeCache.set(b, t);
  return blockTimeCache;
}

/// Price a single trade actually executed at, in USD per token: collateral paid or received
/// divided by tokens moved. Both venues settle in collateral, so one formula covers both -- and
/// deriving it per trade is what makes ATH and the change columns mean anything. The previous
/// version stamped every historical event with the CURRENT price, which made ATH identical to the
/// live price by construction and every percentage change exactly 0.00%.
function tradePrice(collateral: bigint, tokens: bigint, collateralPriceUsd: bigint, quoteScale: bigint): number | null {
  if (tokens === 0n) return null;
  const usd = (collateral * quoteScale * collateralPriceUsd) / WAD;
  return Number((usd * WAD) / tokens) / 1e18;
}

function collateralUsd(collateral: bigint, collateralPriceUsd: bigint, quoteScale: bigint): number {
  return Number((collateral * quoteScale * collateralPriceUsd) / WAD) / 1e18;
}

/// Quote amounts to whole quote tokens. 10**decimals == 1e18/scale, so whole = amount * scale /
/// 1e18: WETH is amount/1e18 (scale 1, unchanged) and a cbBTC base-unit amount divides by its
/// 1e8 -- via the same formula, since its scale is 1e10. DIVIDING by the scale here (rather than
/// multiplying) shrank every cbBTC trade to 1e-23 and the table kept reading 0.0000.
function toQuoteAmount(amount: bigint, quoteScale: bigint): number {
  return (Number(amount) * Number(quoteScale)) / 1e18;
}

/// Reads this launch's trade history and derives the table's market stats from it. Incremental:
/// only blocks newer than the last call are queried, so steady-state refreshes are cheap.
export function fetchLaunchStats(
  launchAddress: string,
  collateralPriceUsd: bigint,
  creationTime: number | null,
  quoteScale?: bigint
): Promise<LaunchStats> {
  const inFlightKey = launchAddress.toLowerCase();
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing;
  const run = fetchLaunchStatsUncoordinated(launchAddress, collateralPriceUsd, creationTime, quoteScale).finally(() => {
    inFlight.delete(inFlightKey);
  });
  inFlight.set(inFlightKey, run);
  return run;
}

async function fetchLaunchStatsUncoordinated(
  launchAddress: string,
  collateralPriceUsd: bigint,
  creationTime: number | null,
  quoteScale?: bigint
): Promise<LaunchStats> {
  const provider = getProvider();
  const launch = getLaunch(launchAddress, provider);
  const key = launchAddress.toLowerCase();
  const cached = launchCache.get(key) ?? {
    nextFromBlock: scanStartBlock,
    trades: [],
    traders: new Set<string>(),
    seen: new Set<string>(),
    // Supplied by fetchAllLaunches, which has already read it for the summary -- one call per
    // launch per session rather than a second identical read here.
    quoteScale: quoteScale ?? ((await launch.quoteScale()) as bigint),
  };

  let head: number;
  try {
    head = await provider.getBlockNumber();
  } catch {
    return EMPTY_STATS;
  }
  if (cached.nextFromBlock > head) {
    // The chain went backwards -- Anvil restarted underneath us. Rescan from the deployment block
    // rather than reporting a previous chain's trades.
    cached.nextFromBlock = scanStartBlock;
    cached.trades = [];
    cached.traders = new Set();
    cached.seen = new Set();
  }

  if (cached.nextFromBlock <= head) {
    try {
      const from = cached.nextFromBlock;
      const [curveBuys, curveSells, poolBuys, poolSells, protecteds, relevereds, seniorReleaseds, paireds] = await Promise.all([
        launch.queryFilter(launch.filters.CurveBuy(), from, head),
        launch.queryFilter(launch.filters.CurveSell(), from, head),
        launch.queryFilter(launch.filters.PoolBuy(), from, head),
        launch.queryFilter(launch.filters.PoolSell(), from, head),
        launch.queryFilter(launch.filters.Protected(), from, head),
        launch.queryFilter(launch.filters.Relevered(), from, head),
        launch.queryFilter(launch.filters.SeniorReleased(), from, head),
        launch.queryFilter(launch.filters.Paired(), from, head),
      ]);

      const all = [...curveBuys, ...curveSells, ...poolBuys, ...poolSells, ...protecteds, ...relevereds, ...seniorReleaseds, ...paireds].filter(
        (e): e is ethers.EventLog => "args" in e
      );
      // Chronological within the batch: "first vs last price in a window" is only meaningful in
      // execution order, and queryFilter results arrive grouped by event type, not by time.
      all.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

      const times = await blockTimes(all.map((e) => e.blockNumber));

      for (const e of all) {
        const ts = times.get(e.blockNumber);
        if (ts === undefined) continue;
        const eventKey = `${e.transactionHash}:${e.index}`;
        if (cached.seen.has(eventKey)) continue;
        // ethers v6 exposes the matched event through `fragment`, not the v5 `.event` string --
        // reading `.event` here silently yielded undefined for every log.
        const name = e.fragment?.name;
        let collateral: bigint;
        let tokens: bigint;
        let isBuy: boolean;
        let type: "buy" | "sell" | "rebalance";
        let skimmedUsd: number | undefined;
        let newLoopLev: number | undefined;
        let rebalanceType: "protect" | "relever" | "release" | "paired" | undefined;
        switch (name) {
          case "CurveBuy":
            collateral = e.args.ethIn as bigint;
            tokens = e.args.tokensOut as bigint;
            isBuy = true;
            type = "buy";
            break;
          case "CurveSell":
            collateral = e.args.ethOut as bigint;
            tokens = e.args.tokensIn as bigint;
            isBuy = false;
            type = "sell";
            break;
          case "PoolBuy":
            collateral = e.args.ethIn as bigint;
            tokens = e.args.tokensOut as bigint;
            isBuy = true;
            type = "buy";
            break;
          case "PoolSell":
            collateral = e.args.ethOut as bigint;
            tokens = e.args.tokensIn as bigint;
            isBuy = false;
            type = "sell";
            break;
          case "Protected": {
            skimmedUsd = Number(e.args.usdReceived as bigint) / 1e18;
            newLoopLev = Number(e.args.leverageAfter as bigint) / 1e18;
            collateral = e.args.ethSold as bigint;
            tokens = 0n;
            isBuy = false;
            type = "rebalance";
            rebalanceType = "protect";
            break;
          }
          case "Relevered": {
            skimmedUsd = Number(e.args.usdSpent as bigint) / 1e18;
            newLoopLev = Number(e.args.leverageAfter as bigint) / 1e18;
            collateral = e.args.ethBought as bigint;
            tokens = 0n;
            isBuy = true;
            type = "rebalance";
            rebalanceType = "relever";
            break;
          }
          case "SeniorReleased": {
            skimmedUsd = Number(e.args.usdOut as bigint) / 1e18;
            newLoopLev = Number(e.args.leverageAfter as bigint) / 1e18;
            collateral = e.args.ethSold as bigint;
            tokens = 0n;
            isBuy = false;
            type = "rebalance";
            rebalanceType = "release";
            break;
          }
          case "Paired": {
            skimmedUsd = Number(e.args.seniorUsd as bigint) / 1e18;
            const junior = e.args.juniorUsd as bigint;
            const senior = e.args.seniorUsd as bigint;
            newLoopLev = junior > 0n ? Number(((senior + junior) * WAD) / junior) / 1e18 : 2;
            const totalEth = e.args.ethFromQueue as bigint;
            // totalEth is raise + HFyc (0.3989 = 0.1999+0.1999). HFyc-sourced is ~0.19999 — deduce via senior share
            const hfycEth = senior + junior > 0n ? (totalEth * senior) / (senior + junior) : totalEth / 2n;
            collateral = hfycEth;
            tokens = 0n;
            isBuy = false;
            type = "rebalance";
            rebalanceType = "paired";
            break;
          }
          default:
            continue;
        }
        // A rebalance has no price per token and no traded volume -- recording either would feed
        // fabricated numbers into every statistic downstream.
        let price: number | null;
        let volumeUsd: number;
        let tokenAmount: number;
        if (type === "rebalance") {
          price = 0;
          volumeUsd = 0;
          tokenAmount = 0;
        } else {
          price = tradePrice(collateral, tokens, collateralPriceUsd, cached.quoteScale);
          if (price === null) continue;
          volumeUsd = collateralUsd(collateral, collateralPriceUsd, cached.quoteScale);
          tokenAmount = Number(tokens) / 1e18;
        }
        // Rebalance events don't have a trader address (protocol operation)
        const trader = type === "rebalance" ? "protocol" : (e.args[0] as string).toLowerCase();
        if (type !== "rebalance") {
          cached.traders.add(trader);
        }
        cached.seen.add(eventKey);
        cached.trades.push({
          ts,
          priceUsd: price,
          volumeUsd,
          collateral: toQuoteAmount(collateral, cached.quoteScale),
          tokenAmount,
          trader,
          isBuy,
          type,
          tx: e.transactionHash,
          skimmedUsd,
          newLoopLev,
          rebalanceType,
        });
      }
      cached.nextFromBlock = head + 1;
      launchCache.set(key, cached);
    } catch {
      // A failed scan leaves the cache untouched so the next refresh retries the same range.
    }
  }

  // Every statistic below is about TRADING, so rebalances are excluded here once rather than
  // guarded at each use. Left in cached.trades so the coin page's activity feed can still show
  // them; see isTrade.
  const trades = cached.trades.filter(isTrade);
  if (trades.length === 0) {
    return { ...EMPTY_STATS, createdAt: creationTime };
  }

  const now = Date.now();
  const windows = { h1: now - 3_600_000, h6: now - 21_600_000, h24: now - 86_400_000 };

  let athUsd = 0;
  let volume24hUsd = 0;
  for (const t of trades) {
    if (t.priceUsd > athUsd) athUsd = t.priceUsd;
    if (t.ts >= windows.h24) volume24hUsd += t.volumeUsd;
  }

  const changeOver = (since: number): number | null => {
    const inWindow = trades.filter((t) => t.ts >= since);
    // A single trade in the window has nothing to compare against -- report "no data" rather than
    // a fabricated 0%, which reads as "flat" when it actually means "unknown".
    if (inWindow.length < 2) return null;
    const first = inWindow[0].priceUsd;
    const last = inWindow[inWindow.length - 1].priceUsd;
    if (first === 0) return null;
    return ((last - first) / first) * 100;
  };

  // Sparkline from real executed prices -- no extra RPC, since the trade log is already here.
  const SPARK_POINTS = 40;
  const recent = trades.slice(-SPARK_POINTS);
  const spark = recent.map((t) => t.priceUsd);

  return {
    createdAt: creationTime ?? trades[0].ts,
    athUsd,
    txnCount: trades.length,
    volume24hUsd,
    traderCount: cached.traders.size,
    change1h: changeOver(windows.h1),
    change6h: changeOver(windows.h6),
    change24h: changeOver(windows.h24),
    spark,
  };
}

/// Per-factory creation times plus the block already scanned, mirroring launchCache. A coin's
/// creation time never changes once mined, so a refresh only needs the blocks added since the
/// last one.
type CreationCache = { nextFromBlock: number; times: Map<string, number> };
const creationCache = new Map<string, CreationCache>();

/// Creation timestamps for every launch, from the factory's own LaunchCreated events -- one query
/// covering all coins, rather than each coin guessing its age from its first trade (which leaves a
/// coin that has never traded with no age at all).
///
/// Bounded and incremental. This previously called `queryFilter` with no range at all, which means
/// fromBlock 0, and did so on every 3s poll for every factory -- a full-chain `eth_getLogs` twice
/// per refresh against a public RPC that is 111M blocks deep. It now starts at the deployment
/// block and advances, so the steady-state query covers only the blocks since the last refresh.
export async function fetchCreationTimes(factoryAddress: string, factoryAbi: ethers.InterfaceAbi): Promise<Map<string, number>> {
  const provider = getProvider();
  const factory = new ethers.Contract(factoryAddress, factoryAbi, provider);
  const key = factoryAddress.toLowerCase();
  const cached = creationCache.get(key) ?? { nextFromBlock: scanStartBlock, times: new Map<string, number>() };
  try {
    const head = await provider.getBlockNumber();
    if (cached.nextFromBlock > head) {
      // Chain went backwards (Anvil restarted): the addresses in this map belong to a chain that
      // no longer exists.
      cached.nextFromBlock = scanStartBlock;
      cached.times = new Map();
    }
    if (cached.nextFromBlock <= head) {
      const events = (await factory.queryFilter(factory.filters.LaunchCreated(), cached.nextFromBlock, head)).filter(
        (e): e is ethers.EventLog => "args" in e
      );
      const times = await blockTimes(events.map((e) => e.blockNumber));
      for (const e of events) {
        const ts = times.get(e.blockNumber);
        const addr = e.args?.launch as string | undefined;
        if (ts !== undefined && addr) cached.times.set(addr.toLowerCase(), ts);
      }
      cached.nextFromBlock = head + 1;
      creationCache.set(key, cached);
    }
  } catch {
    // factory without the event / unreachable node -- ages fall back to first-trade time. The
    // cache is left untouched so the next refresh retries the same range.
  }
  return new Map(cached.times);
}
