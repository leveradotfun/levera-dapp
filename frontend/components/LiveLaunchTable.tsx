"use client";

import { useMemo, useState } from "react";
import { LaunchSummary, TOTAL_SUPPLY_WAD, displayQuoteSymbol } from "@/lib/launchpad";

/// Whole tokens, for the plain-number math in this file. Supply is fixed at mint.
const TOTAL_SUPPLY = Number(TOTAL_SUPPLY_WAD / 10n ** 18n);
import PriceLabel from "@/components/PriceLabel";
import TokenIcon from "@/components/TokenIcon";
import { timeAgo } from "@/lib/utils";

const PALETTE = ["#ECE3D1", "#22c55e", "#38bdf8", "#f472b6", "#fbbf24", "#a78bfa", "#fb7185", "#34d399"];
const EMOJI = ["🐕", "🚀", "🌙", "🐸", "💎", "🔥", "⚡", "🦍", "🍌", "👽"];

/// NOTE: every consumer of this MUST use the unsigned shift (>>>), never >>. `>>` converts to a
/// SIGNED int32 first, so any hash above 2^31 -- roughly half of them -- comes out negative, `%`
/// keeps the sign in JavaScript, and the array lookup returns undefined. That surfaced as a hard
/// crash where the result was used ("Cannot read properties of undefined (reading 'slice')") and,
/// everywhere else, as a silently blank emoji or a NaN colour.
function hashOf(address: string): number {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return h;
}

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/// One USD formatter for every money column in this table. MCAP previously used launchpad's
/// usdCompact (1 decimal) while ATH used this one (2 decimals), so a coin at its peak rendered as
/// "$6.6K mcap / $6.58K ATH" -- reading as a contradiction created purely by rounding.
function compactUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/// Tiny price series for the row. Area + line, coloured by whether the window closed up or down --
/// same read as the change columns beside it, so the two can never disagree.
function Sparkline({ prices }: { prices: number[] }) {
  const W = 68;
  const H = 26;
  if (prices.length < 2) {
    return <div style={{ width: W, height: H }} className="flex items-center text-[10px] text-muted">—</div>;
  }
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || Math.abs(max) || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * W;
    // Inset by 2px top and bottom so a flat-ish series doesn't sit flush against the row edges.
    const y = 2 + (H - 4) - ((p - min) / range) * (H - 4);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const up = prices[prices.length - 1] >= prices[0];
  const color = up ? "#22c55e" : "#ef4444";
  const gradId = `spark-${up ? "u" : "d"}`;
  return (
    <svg width={W} height={H} className="block overflow-visible">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/// A null change means "not enough trades in this window to compare" -- rendered as a dash, never
/// as 0.0%, which would claim the price was flat when we simply don't know.
function ChangeChip({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">-</span>;
  const up = value > 0;
  const flat = value === 0;
  if (flat) return <span className="font-mono text-xs text-muted">0.0%</span>;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-xs font-medium ${
        up ? "bg-green/10 text-green" : "bg-red/10 text-red"
      }`}
    >
      {up ? "↑" : "↓"} {Math.abs(value).toFixed(1)}%
    </span>
  );
}

/// How far below its all-time high the coin currently sits. Gives the ATH number context at a
/// glance: a full bar is at/near its peak, a stub is well off it.
function AthBar({ marketCapUsd, athMcapUsd }: { marketCapUsd: number; athMcapUsd: number }) {
  const pct = athMcapUsd > 0 ? Math.min(100, Math.max(0, (marketCapUsd / athMcapUsd) * 100)) : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface" title={`${pct.toFixed(0)}% of ATH`}>
        <div className="h-full rounded-full bg-green transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-sm text-foreground">{athMcapUsd > 0 ? compactUsd(athMcapUsd) : "—"}</span>
    </div>
  );
}

type SortKey = "mcap" | "ath" | "age" | "txns" | "vol" | "traders" | "h1" | "h6" | "h24";
type SortDir = "asc" | "desc";

export default function LiveLaunchTable({
  launches,
  onSelect,
}: {
  launches: LaunchSummary[];
  onSelect: (launch: LaunchSummary) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      // Third click clears the sort and restores the natural (newest-first) order, so there's a
      // way back without reloading.
      if (sortDir === "asc") setSortKey(null);
      else setSortDir("asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const rows = useMemo(() => {
    const withDerived = launches.map((l) => {
      const mcap = Number(l.marketCapUsd) / 1e18;
      // The stats ATH is the highest price any trade EXECUTED at, while mcap is the current spot
      // price -- two different series. On a rising curve the live spot sits above the last executed
      // price, so a pure trade-history ATH renders as "current value exceeds its own all-time
      // high", which is a contradiction on its face. The current price is part of the price history
      // by definition, so it belongs in the max.
      // Same basis as mcap above (full supply), or the bar compares two different quantities and
      // a coin sits at a permanent 100% of its own ATH.
      const athMcap = Math.max(l.stats.athUsd * TOTAL_SUPPLY, mcap);
      return { launch: l, mcap, athMcap };
    });
    if (!sortKey) return withDerived;

    const value = (r: (typeof withDerived)[number]): number => {
      switch (sortKey) {
        case "mcap":
          return r.mcap;
        case "ath":
          return r.athMcap;
        // Age sorts by actual age, not raw timestamp, so "descending" reads as oldest-first the way
        // the column label implies rather than being inverted.
        case "age":
          return r.launch.stats.createdAt === null ? -Infinity : Date.now() - r.launch.stats.createdAt;
        case "txns":
          return r.launch.stats.txnCount;
        case "vol":
          return r.launch.stats.volume24hUsd;
        case "traders":
          return r.launch.stats.traderCount;
        // Unknown changes sort to the bottom in either direction rather than being treated as 0%,
        // which would rank them among genuinely flat coins.
        case "h1":
          return r.launch.stats.change1h ?? -Infinity;
        case "h6":
          return r.launch.stats.change6h ?? -Infinity;
        case "h24":
          return r.launch.stats.change24h ?? -Infinity;
      }
    };
    return [...withDerived].sort((a, b) => (sortDir === "desc" ? value(b) - value(a) : value(a) - value(b))).slice(0, 10);
  }, [launches, sortKey, sortDir]);

  if (launches.length === 0) {
    // Same copy as the grid's empty state (LiveLaunchGrid) so both view modes read identically.
    return (
      <div className="rounded-xl border border-dashed border-border p-12 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-2xl">🚀</div>
        <p className="text-sm font-medium text-foreground">No coins here yet.</p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">
          Launch the first one, or grab test tokens from the faucet to trade the ones that exist.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <a href="/create" className="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-accent-ink hover:opacity-90">Launch a coin</a>
          <a href="/faucet" className="rounded-lg border border-border px-3.5 py-2 text-xs font-medium text-muted hover:text-foreground hover:border-accent/40">Faucet</a>
        </div>
      </div>
    );
  }

  const Th = ({ label, sort, align = "right" }: { label: string; sort?: SortKey; align?: "left" | "right" }) => {
    const active = sortKey === sort;
    return (
      <th
        className={`whitespace-nowrap px-3 py-2.5 text-xs font-medium uppercase tracking-wide ${
          align === "left" ? "text-left" : "text-right"
        } ${sort ? "cursor-pointer select-none hover:text-foreground" : ""} ${active ? "text-foreground" : "text-muted"}`}
        onClick={sort ? () => toggleSort(sort) : undefined}
        aria-sort={active ? (sortDir === "desc" ? "descending" : "ascending") : undefined}
      >
        <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
          {label}
          {sort ? (
            <span className={`text-[9px] leading-none ${active ? "text-accent" : "text-muted/50"}`}>
              {active ? (sortDir === "desc" ? "▼" : "▲") : "⇅"}
            </span>
          ) : null}
        </span>
      </th>
    );
  };

  return (
    // Horizontal scroll lives on this wrapper so a narrow viewport scrolls the table rather than
    // the whole page.
    //
    // table-fixed + an explicit colgroup: with auto layout, every cell's content re-measures the
    // columns on every poll — "$5.29K" becoming "$1.23M" or an ATH bar growing reshuffles all
    // the columns, so the green ATH bars and sparklines never line up between rows. Fixed widths
    // pin every column; long values truncate instead of pushing the row around. COIN is the only
    // width-less column, so it swallows the spare width — every other column carries a generous
    // fixed width of its own so the numbers never look cramped next to a wide name column.
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[1200px] table-fixed text-sm">
        <colgroup>
          <col className="w-12" />
          <col />
          <col className="w-16" />
          <col className="w-28" />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-16" />
          <col className="w-16" />
          <col className="w-24" />
          <col className="w-16" />
          <col className="w-20" />
          <col className="w-20" />
          <col className="w-20" />
        </colgroup>
        <thead className="bg-surface/50">
          <tr className="border-b border-border">
            <Th label="#" align="left" />
            <Th label="Coin" align="left" />
            <Th label="Pair" align="left" />
            <Th label="Graph" align="left" />
            <Th label="Mcap" sort="mcap" />
            <Th label="ATH" sort="ath" />
            <Th label="Age" sort="age" />
            <Th label="Txns" sort="txns" />
            <Th label="24h Vol" sort="vol" />
            <Th label="Traders" sort="traders" />
            <Th label="1h" sort="h1" />
            <Th label="6h" sort="h6" />
            <Th label="24h" sort="h24" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ launch: l, mcap, athMcap }, i) => {
            const h = hashOf(l.address);
            const color = PALETTE[h % PALETTE.length];
            const emoji = EMOJI[(h >>> 3) % EMOJI.length];
            const targetUsd = Number(l.targetUsd) / 1e18;
            const isHot = !l.graduated && (l.pctToGraduation > 50 || (targetUsd > 0 && l.stats.volume24hUsd > targetUsd * 0.5));
            return (
              <tr
                key={l.address}
                onClick={() => onSelect(l)}
                className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-hover"
              >
                <td className="px-3 py-3 text-xs text-muted">{i + 1}</td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base"
                      style={{ backgroundColor: `${color}22`, border: `1px solid ${color}55` }}
                    >
                      {emoji}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-foreground">{l.name}</span>
                        <span
                          title={
                            l.graduated
                              ? `Graduated — trading live on the AMM${l.paired ? " at 2x against LYC senior" : ""}`
                              : `On the bonding curve — ${l.pctToGraduation.toFixed(0)}% to graduation`
                          }
                          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                            l.graduated ? "bg-green/15 text-green" : "bg-surface text-muted"
                          }`}
                        >
                          {l.graduated ? (
                            <>
                              <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 111.4-1.4l2.8 2.79 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                              </svg>
                              LIVE
                            </>
                          ) : (
                            "bonding"
                          )}
                        </span>
                        {isHot && (
                          <span className="shrink-0 rounded-full bg-orange-500/15 text-orange-400 px-1.5 py-0.5 text-[9px] font-semibold animate-vibrate">
                            HOT
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted">${l.symbol}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3">
                  {/* Logo only — the tooltip carries the exact symbol for anyone unsure */}
                  <span
                    className="inline-flex items-center"
                    title={l.graduated ? `AMM pair quoted in ${l.quoteSymbol}` : `Bonding-curve raise quoted in ${l.quoteSymbol}`}
                  >
                    <TokenIcon symbol={displayQuoteSymbol(l.quoteSymbol)} size={18} />
                  </span>
                </td>
                <td className="px-3 py-3">
                  <Sparkline prices={l.stats.spark} />
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap overflow-hidden">
                  <div className="font-mono text-sm text-foreground truncate">{compactUsd(mcap)}</div>
                  <div className="font-mono text-[10px] text-muted"><PriceLabel value={l.priceUsd} /></div>
                </td>
                <td className="px-3 py-3 text-right">
                  <AthBar marketCapUsd={mcap} athMcapUsd={athMcap} />
                </td>
                <td className="px-3 py-3 text-right text-sm text-muted whitespace-nowrap overflow-hidden">{timeAgo(l.stats.createdAt)}</td>
                <td className="px-3 py-3 text-right font-mono text-sm text-foreground whitespace-nowrap overflow-hidden">
                  {compactNum(l.stats.txnCount)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm text-foreground whitespace-nowrap overflow-hidden">
                  {compactUsd(l.stats.volume24hUsd)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm text-foreground whitespace-nowrap overflow-hidden">
                  {compactNum(l.stats.traderCount)}
                </td>
                <td className="px-3 py-3 text-right">
                  <ChangeChip value={l.stats.change1h} />
                </td>
                <td className="px-3 py-3 text-right">
                  <ChangeChip value={l.stats.change6h} />
                </td>
                <td className="px-3 py-3 text-right">
                  <ChangeChip value={l.stats.change24h} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
