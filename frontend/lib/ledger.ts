import { loadDeployedAddresses } from "./chain";
import { apiGet, apiPost } from "./remote";

const WAD = 10n ** 18n;

export type Trade = {
  side: "buy" | "sell";
  usdValueWad: string;
  tokenAmountWad: string;
  timestamp: number;
};

export type PositionSummary = {
  totalSpentUsd: bigint;
  totalReceivedUsd: bigint;
  totalBought: bigint;
  totalSold: bigint;
};

type Aggregate = { spent: string; received: string; bought: string; sold: string; count: number };

const LEGACY_PREFIX = "launchpad-frontend:ledger:";
const cache = new Map<string, Aggregate>();
const hydrating = new Set<string>();
const EMPTY: Aggregate = { spent: "0", received: "0", bought: "0", sold: "0", count: 0 };

function cacheKey(launch: string, holder: string) {
  return `${launch.toLowerCase()}:${holder.toLowerCase()}`;
}

function legacyKey(launchAddress: string, holder: string) {
  return `${LEGACY_PREFIX}${holder.toLowerCase()}:${launchAddress.toLowerCase()}`;
}

function loadLegacyTrades(launchAddress: string, holder: string): Trade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(legacyKey(launchAddress, holder));
    if (!raw) return [];
    return JSON.parse(raw) as Trade[];
  } catch {
    return [];
  }
}

function fold(trades: Trade[]): Aggregate {
  const agg = { ...EMPTY };
  for (const t of trades) {
    if (t.side === "buy") {
      agg.spent = (BigInt(agg.spent) + BigInt(t.usdValueWad)).toString();
      agg.bought = (BigInt(agg.bought) + BigInt(t.tokenAmountWad)).toString();
    } else {
      agg.received = (BigInt(agg.received) + BigInt(t.usdValueWad)).toString();
      agg.sold = (BigInt(agg.sold) + BigInt(t.tokenAmountWad)).toString();
    }
    agg.count += 1;
  }
  return agg;
}

async function hydrate(launchAddress: string, holder: string) {
  const k = cacheKey(launchAddress, holder);
  if (hydrating.has(k)) return;
  hydrating.add(k);
  const r = await apiGet<{
    rows: { trader: string; spent: string; received: string; bought: string; sold: string; count: number }[];
  }>(`/api/ledger?launch=${encodeURIComponent(launchAddress)}`);
  const row = r?.rows?.find((x) => x.trader.toLowerCase() === holder.toLowerCase());
  if (row) {
    cache.set(k, {
      spent: row.spent,
      received: row.received,
      bought: row.bought,
      sold: row.sold,
      count: row.count,
    });
  }
  const leftover = loadLegacyTrades(launchAddress, holder);
  if (leftover.length > 0 && !row) {
    const factory = loadDeployedAddresses()?.factory ?? "";
    for (const t of leftover) {
      void apiPost("/api/ledger", {
        factory,
        launch: launchAddress,
        trader: holder,
        side: t.side,
        usdWad: t.usdValueWad,
        tokenWad: t.tokenAmountWad,
        t: t.timestamp,
      });
    }
    cache.set(k, fold(leftover));
  }
  try {
    window.localStorage.removeItem(legacyKey(launchAddress, holder));
  } catch {
    // private mode
  }
}

function loadAgg(launchAddress: string, holder: string): Aggregate {
  const k = cacheKey(launchAddress, holder);
  if (cache.has(k)) return cache.get(k)!;
  const leftover = fold(loadLegacyTrades(launchAddress, holder));
  cache.set(k, leftover);
  void hydrate(launchAddress, holder);
  return leftover;
}

export function recordTrade(launchAddress: string, holder: string, trade: Trade) {
  if (typeof window === "undefined") return;
  const k = cacheKey(launchAddress, holder);
  const cur = cache.get(k) ?? { ...EMPTY };
  if (trade.side === "buy") {
    cur.spent = (BigInt(cur.spent) + BigInt(trade.usdValueWad)).toString();
    cur.bought = (BigInt(cur.bought) + BigInt(trade.tokenAmountWad)).toString();
  } else {
    cur.received = (BigInt(cur.received) + BigInt(trade.usdValueWad)).toString();
    cur.sold = (BigInt(cur.sold) + BigInt(trade.tokenAmountWad)).toString();
  }
  cur.count += 1;
  cache.set(k, cur);
  const factory = loadDeployedAddresses()?.factory ?? "";
  void apiPost("/api/ledger", {
    factory,
    launch: launchAddress,
    trader: holder,
    side: trade.side,
    usdWad: trade.usdValueWad,
    tokenWad: trade.tokenAmountWad,
    t: trade.timestamp,
  });
}

export function getTrades(_launchAddress: string, _holder: string): Trade[] {
  // Individual trades live in Postgres. Callers that only need P&L should use summarizePosition.
  return [];
}

export function summarizePosition(launchAddress: string, holder: string): PositionSummary {
  const agg = loadAgg(launchAddress, holder);
  return {
    totalSpentUsd: BigInt(agg.spent),
    totalReceivedUsd: BigInt(agg.received),
    totalBought: BigInt(agg.bought),
    totalSold: BigInt(agg.sold),
  };
}

export function computePnl(summary: PositionSummary, currentTokenBalance: bigint, currentPriceUsdWad: bigint): bigint {
  const currentValue = (currentTokenBalance * currentPriceUsdWad) / WAD;
  return currentValue + summary.totalReceivedUsd - summary.totalSpentUsd;
}
