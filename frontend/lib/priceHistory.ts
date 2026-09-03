import { useEffect, useRef, useState } from "react";
import { TARGETING_TESTNET } from "./chains";
import { fetchLaunchSummary, fetchCollateralPriceUsd } from "./launchpad";
import { fetchLaunchStats, isTrade, tradesFor } from "./launchStats";
import { apiGet, apiPost } from "./remote";
import { loadDeployedAddresses } from "./chain";

export type PricePoint = { t: number; price: number };

// The chart sampler. 400ms against the local fork is free; against the shared testnet RPC the
// same cadence is ~50 requests/second for one open tab (each sample re-reads the coin's state),
// which is both abusive to the endpoint and the thing that made the page feel broken under its
// own rate limit. Remote targets get a chart that updates every 5s instead of 2.5x/s.
const SAMPLE_MS = TARGETING_TESTNET ? 15_000 : 400;
/// Applies to LIVE samples only. Seeded on-chain history is bounded by the trade count, not this.
const MAX_POINTS = 4000;
const LEGACY_STORAGE_KEY = "launchpad-price-history";
/// Postgres writes used to be localStorage rewritten on every 400ms sample. Persist at 5s.
const PERSIST_MS = 5_000;
/// A coin with no trading has a flat price; appending an identical point 2.5x/sec only churned the
/// array and re-rendered the chart for an unchanged pixel. Keep a slow heartbeat so the time axis
/// stays alive.
const HEARTBEAT_MS = 10_000;

function legacyLoad(launchAddress: string): PricePoint[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, PricePoint[]>;
    const pts = all[launchAddress] ?? [];
    return Array.isArray(pts) ? pts : [];
  } catch {
    return [];
  }
}

function persistPoints(launchAddress: string, points: PricePoint[]) {
  const factory = loadDeployedAddresses()?.factory ?? "";
  void apiPost("/api/price-history", { launch: launchAddress, factory, points });
}

/// Merge two point sets into one chronological series. Chain trades carry exact executed prices;
/// live samples fill the gaps between them. Same-millisecond duplicates collapse to the first.
function mergePoints(a: PricePoint[], b: PricePoint[]): PricePoint[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const merged = [...a, ...b].sort((p, q) => p.t - q.t);
  const out: PricePoint[] = [merged[0]];
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].t !== out[out.length - 1].t) out.push(merged[i]);
  }
  return out;
}

/// Price history for a launch, seeded from the coin's ENTIRE on-chain trade log (every executed
/// trade carries its real price -- see launchStats.tradePrice) and then extended live while this
/// page has the coin open. Previously this started empty on every fresh visit and only accumulated
/// session-local samples, so the "TradingView" chart showed at most ~16 minutes of data no matter
/// how old the coin was.
export function usePriceHistory(launchAddress: string | null, oracleAddress: string | undefined) {
  const [points, setPoints] = useState<PricePoint[]>([]);
  const lastPersistRef = useRef(0);

  useEffect(() => {
    if (!launchAddress || !oracleAddress) return;
    let stopped = false;
    // Stale-coin guard: drop the previous coin's series immediately rather than charting it
    // under the new coin's header while the seed is in flight.
    setPoints([]);

    // Self-scheduling, not setInterval: on a slow remote round trip an interval fires the next
    // sample while the previous is still in flight, and the samples stack up in the RPC queue.
    // The next sample is queued only once the current one has finished (or failed).
    let tick: () => Promise<void> = async () => {};
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (stopped) return;
      try {
        await tick();
      } catch {
        // a failed sample is retried on the next tick; the chart keeps its existing points
      }
      if (!stopped) timer = setTimeout(loop, SAMPLE_MS);
    };
    void loop();

    async function sample() {
      try {
        // Per-launch price resolution -- the summary reads the coin's own oracle, so a cbBTC
        // coin charts against the cbBTC mark rather than the global ETH one.
        const summary = await fetchLaunchSummary(launchAddress!);
        if (stopped) return;
        const price = Number(summary.priceUsd) / 1e18;
        const t = Date.now();

        setPoints((prev) => {
          const last = prev[prev.length - 1];
          // Skip no-op samples: on a curve with no trades the price does not move.
          const unchanged = last !== undefined && last.price === price;
          const beating = last === undefined || t - last.t >= HEARTBEAT_MS;
          if (unchanged && !beating) return prev;

          const updated = [...prev, { t, price }].slice(-MAX_POINTS);

          const now = Date.now();
          if (now - lastPersistRef.current >= PERSIST_MS) {
            lastPersistRef.current = now;
            persistPoints(launchAddress!, updated);
          }
          return updated;
        });
      } catch {
        // transient RPC hiccup -- just skip this sample, the next tick tries again
      }
    }

    async function seed() {
      // The incremental scan is shared with the coin table and the trades feed, so on an already-
      // open app this costs at most the blocks since the last poll.
      try {
        const collateralPriceUsd = await fetchCollateralPriceUsd(oracleAddress!);
        await fetchLaunchStats(launchAddress!, collateralPriceUsd, null);
      } catch {
        // Unreachable node: fall through with whatever localStorage has rather than showing nothing.
      }
      if (stopped) return;

      // Rebalances carry priceUsd 0 by design -- they are protocol operations, not trades, and
      // charting them would stamp flat zero-price steps into the series.
      const fromChain: PricePoint[] = tradesFor(launchAddress!)
        .filter((p) => isTrade(p) && p.priceUsd > 0)
        .map((p) => ({ t: p.ts, price: p.priceUsd }));

      const fromDb =
        (await apiGet<{ points: PricePoint[] }>(
          `/api/price-history?launch=${encodeURIComponent(launchAddress!)}`,
        ))?.points ?? [];
      const leftover = legacyLoad(launchAddress!);
      if (leftover.length > 0) {
        persistPoints(launchAddress!, leftover);
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          // private mode
        }
      }
      setPoints(mergePoints(fromChain, mergePoints(fromDb, leftover)));

      tick = sample;
      void sample();
    }

    void seed();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [launchAddress, oracleAddress]);

  return points;
}

export type PeriodChange = { label: string; pct: number | null };

const PERIODS: { label: string; ms: number }[] = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "4h", ms: 4 * 60 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000 },
];

/// Compute percentage price changes for standard periods (5m, 1h, 4h, 24h) from a price history.
export function computePeriodChanges(points: PricePoint[]): PeriodChange[] {
  if (points.length < 2) return PERIODS.map((p) => ({ label: p.label, pct: null }));
  const now = points[points.length - 1].t;
  const currentPrice = points[points.length - 1].price;
  if (currentPrice <= 0) return PERIODS.map((p) => ({ label: p.label, pct: null }));

  return PERIODS.map(({ label, ms }) => {
    const target = now - ms;
    let best = points[0];
    for (const pt of points) {
      if (Math.abs(pt.t - target) < Math.abs(best.t - target)) best = pt;
    }
    if (best.price <= 0) return { label, pct: null };
    return { label, pct: ((currentPrice - best.price) / best.price) * 100 };
  });
}
