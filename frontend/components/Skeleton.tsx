"use client";

/// Loading placeholders.
///
/// These exist because the honest alternative to "we don't know yet" is not zero. Before the first
/// chain read lands, the coin grid used to render "No coins launched yet" and the analytics page
/// rendered $0.00 volume with 0 traders -- both of which read as *facts about the protocol* rather
/// than "still loading", and both of which were wrong. A skeleton says nothing, which is exactly
/// what we know at that point.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface ${className}`} aria-hidden />;
}

/// A stat card placeholder matching the real card's box so the layout doesn't jump when data lands.
export function SkeletonStat() {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="mt-2 h-7 w-28" />
      <Skeleton className="mt-2 h-2.5 w-24" />
    </div>
  );
}

/// Coin card placeholder for the explore grid.
export function SkeletonCoinCard() {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <Skeleton className="h-11 w-11 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-3 w-16" />
        </div>
      </div>
      <Skeleton className="mt-4 h-3 w-20" />
      <Skeleton className="mt-2 h-3 w-28" />
      <Skeleton className="mt-4 h-1.5 w-full rounded-full" />
    </div>
  );
}

/// Generic table-body placeholder: `rows` × `cols` cells inside the caller's own table chrome.
export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-b border-border/50 last:border-0">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-4 py-3">
              <Skeleton className={`h-4 ${c === 0 ? "w-32" : "ml-auto w-16"}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/// Stand-in for a chart while its data (or its code chunk) is still arriving.
export function SkeletonChart({ height = 320 }: { height?: number }) {
  return (
    <div className="flex items-end gap-1.5 px-1" style={{ height }} aria-hidden>
      {/* A fixed, non-random set of heights: Math.random() here would differ between the server
          render and the client hydration and trip a hydration mismatch. */}
      {[38, 52, 44, 63, 57, 71, 66, 80, 74, 88, 82, 95, 90, 78, 84].map((h, i) => (
        <div
          key={i}
          className="flex-1 animate-pulse rounded-sm bg-surface"
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}
