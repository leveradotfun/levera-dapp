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

/// Hard cap on emitted bars. Gap-filling multiplies the point span out to the bucket grid; at a
/// 1s interval a multi-day span would be hundreds of thousands of flat bars nobody scrolls to.
/// When the grid would exceed this, the OLDEST bars are trimmed -- the default viewport shows the
/// most recent ~80 anyway.
const MAX_BARS = 20_000;

/// Bucket live ticks into OHLC bars as a CONTINUOUS series.
///
/// Two properties make this read like a real TradingView chart instead of floating shards:
///
/// 1. SPIKES ARE CLAMPED, NOT DROPPED. Low-liquidity bonding-curve trades with tiny amounts print
///    5-10x away from surrounding ticks (1s bars hitting $0.010 against a $0.00128 current price).
///    The tick stays -- the close moves, direction preserved -- but its extreme is clamped to the
///    local median so the wick cannot stretch the y-axis. The previous version DELETED these
///    ticks, which punched holes into exactly the sparse regions where continuity mattered most.
/// 2. EVERY BUCKET EXISTS. Points only land where something happened: a trade, or the sampler
///    while somebody had the page open. Between those, old code rendered nothing -- isolated
///    candles floating in whitespace. Here every bucket between the first and last occupied one
///    carries the previous close forward as a flat candle: no ticks means the price did not move,
///    and the chart now says that instead of going blank.
export function candlesFromPoints(points: PricePoint[], intervalMs: number): Candle[] {
  if (points.length === 0) return [];

  const clamped: PricePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.price) || p.price <= 0) continue;
    const windowStart = Math.max(0, i - 10);
    const windowEnd = Math.min(points.length, i + 11);
    const windowPrices = points
      .slice(windowStart, windowEnd)
      .map((q) => q.price)
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const median = windowPrices[Math.floor(windowPrices.length / 2)] ?? p.price;
    // >4x / <0.25x the 20-point local median is a low-liquidity print, not a market move.
    let price = p.price;
    if (median > 0 && (price > median * 4 || price < median * 0.25)) {
      price = median > price ? median * 0.25 : median * 4;
    }
    clamped.push({ t: p.t, price });
  }

  const stepSec = Math.max(1, Math.floor(intervalMs / 1000));
  const buckets = new Map<number, Candle>();
  for (const p of clamped) {
    const time = Math.floor(p.t / 1000 / stepSec) * stepSec;
    const existing = buckets.get(time);
    if (!existing) {
      buckets.set(time, { time, open: p.price, high: p.price, low: p.price, close: p.price });
    } else {
      existing.high = Math.max(existing.high, p.price);
      existing.low = Math.min(existing.low, p.price);
      existing.close = p.price;
    }
  }

  const occupied = [...buckets.values()].sort((a, b) => a.time - b.time);
  if (occupied.length === 0) return [];

  // Forward-fill: flat candles at the previous close across every unoccupied bucket, so the
  // series is gapless from the first to the last tick.
  const out: Candle[] = [occupied[0]];
  let prev = occupied[0];
  for (let i = 1; i < occupied.length; i++) {
    const next = occupied[i];
    for (let t = prev.time + stepSec; t < next.time; t += stepSec) {
      out.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close });
    }
    out.push(next);
    prev = next;
  }

  return out.length > MAX_BARS ? out.slice(out.length - MAX_BARS) : out;
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
