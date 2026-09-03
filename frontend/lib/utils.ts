export function fmtMcap(n: number): string {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n;
}

export function fmtPrice(p: number): string {
  if (p >= 1) return "$" + p.toFixed(2);
  if (p >= 0.01) return "$" + p.toFixed(4);
  const s = p.toFixed(8);
  const m = s.match(/^0\.(0+)(\d{4})/);
  if (m) return "0.0\u2080" + m[1].length + "\u2080" + m[2];
  return "$" + p.toFixed(6);
}

export function fmtPct(v: number): { cls: string; text: string } {
  if (v === 0) return { cls: "flat", text: "0.0%" };
  return {
    cls: v > 0 ? "up" : "down",
    text: `${v > 0 ? "\u25B2" : "\u25BC"} ${Math.abs(v).toFixed(1)}%`,
  };
}

export function generateSparkline(
  trend: number,
  pts = 20,
  w = 80,
  h = 28,
  seed = 42
): string {
  // Seeded PRNG (mulberry32) for deterministic sparklines across SSR/client
  let s = seed | 0;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const points: number[] = [];
  let v = 50;
  for (let j = 0; j < pts; j++) {
    v += (rand() - 0.45 + trend * 0.1) * 15;
    v = Math.max(5, Math.min(95, v));
    points.push(v);
  }
  return points
    .map(
      (p, j) =>
        `${j === 0 ? "M" : "L"}${(j / (pts - 1)) * w},${h - (p / 100) * (h - 4)}`
    )
    .join(" ");
}

/// Compact relative age ("3s", "42m", "2d", "1mo"). Accepts null for "we don't know when this
/// happened" -- a coin whose creation block can't be read shows a dash rather than claiming to be
/// zero seconds old, which is what a `Date.now()` fallback would do.
export function timeAgo(timestamp: number | null): string {
  if (timestamp === null) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
