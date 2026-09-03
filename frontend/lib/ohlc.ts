import type { PricePoint } from "./priceHistory";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export const CHART_INTERVALS = [
  { id: "1s", label: "1s", ms: 1_000 },
  { id: "5s", label: "5s", ms: 5_000 },
  { id: "15s", label: "15s", ms: 15_000 },
  { id: "1m", label: "1m", ms: 60_000 },
  { id: "5m", label: "5m", ms: 300_000 },
  { id: "15m", label: "15m", ms: 900_000 },
  { id: "1h", label: "1h", ms: 3_600_000 },
] as const;

export type ChartIntervalId = (typeof CHART_INTERVALS)[number]["id"];

/// Bucket live ticks into OHLC bars. Sampling is ~400ms, so a 5s bar is a real candle, not a fake.
export function candlesFromPoints(points: PricePoint[], intervalMs: number): Candle[] {
  if (points.length === 0) return [];
  // Filter single-tick price spikes (low-liquidity bonding-curve trades with tiny amounts
  // that print 5-10x away from the surrounding ticks and stretch the y-axis so the
  // current action is unreadable — see screenshot at 09:45 where 1s bars hit $0.010 vs current $0.00128).
  // We keep the spike's close but clamp its wick to the surrounding median so the bar still
  // shows direction without dominating scale. Outlier = >4x or <0.25x the 20-point median.
  const filtered = (() => {
    if (points.length < 10) return points;
    const out: PricePoint[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!Number.isFinite(p.price) || p.price <= 0) continue;
      const windowStart = Math.max(0, i - 10);
      const windowEnd = Math.min(points.length, i + 11);
      const windowPrices = points.slice(windowStart, windowEnd).map((q) => q.price).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
      const median = windowPrices[Math.floor(windowPrices.length / 2)] ?? p.price;
      if (median > 0 && (p.price > median * 4 || p.price < median * 0.25)) {
        continue;
      }
      out.push(p);
    }
    // If filtering removed >80% (e.g. genuinely volatile launch), fall back to unfiltered
    return out.length >= points.length * 0.2 ? out : points;
  })();

  const buckets = new Map<number, Candle>();
  for (const p of filtered) {
    if (!Number.isFinite(p.price) || p.price < 0) continue;
    const bucketStart = Math.floor(p.t / intervalMs) * intervalMs;
    const time = Math.floor(bucketStart / 1000);
    const existing = buckets.get(time);
    if (!existing) {
      buckets.set(time, { time, open: p.price, high: p.price, low: p.price, close: p.price });
    } else {
      existing.high = Math.max(existing.high, p.price);
      existing.low = Math.min(existing.low, p.price);
      existing.close = p.price;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

const SUBSCRIPT = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"] as const;
function toSubscript(n: number | string): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)] ?? d)
    .join("");
}

export function formatChartPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 0.001) return `${sign}$${abs.toPrecision(4)}`;
  const s = abs.toFixed(20);
  const m = s.match(/^0\.(0+)(\d{1,4})/);
  if (!m) return `${sign}$${n.toExponential(2)}`;
  return `${sign}$0.0${toSubscript(m[1].length)}${m[2]}`;
}
