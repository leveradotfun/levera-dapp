"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getLaunch, getProvider } from "@/lib/launchpad";

/// Trending ticker below the top bar: the last 24h's most-traded coins, each with its 24h price
/// change, ranked by USD volume. Data comes from `/api/trending` (the `trades` table every swap
/// already feeds); symbols are read on-chain for the top rows only. Scrolls like a tape, pauses
/// on hover, and hides itself entirely when there is nothing to show.
type Row = {
  launch: string;
  volume24h: number;
  priceUsd: number;
  change24h: number;
  imageUrl: string | null;
};

type Enriched = Row & { symbol: string };

// Deterministic badge hue per launch, so a coin with no uploaded art still gets a stable,
// distinct color instead of every row showing the same gray circle.
function hueFor(address: string): number {
  let h = 0;
  for (let i = 2; i < 10; i++) h = (h * 31 + address.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function Change({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span className={`font-mono text-xs font-semibold ${up ? "text-emerald-400" : "text-red-400"}`}>
      {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

export default function TrendingMarquee() {
  const [rows, setRows] = useState<Enriched[] | null>(null);

  useEffect(() => {
    let alive = true;
    const provider = getProvider();

    async function load() {
      try {
        const res = await fetch("/api/trending", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { rows: Row[] };
        const top = (data.rows ?? []).slice(0, 16);
        if (top.length === 0) {
          if (alive) setRows([]);
          return;
        }
        // Symbols are plain ERC-20 reads; one staticcall per trending row per refresh. The shared
        // testnet RPC drops request bursts (see lib/signers.ts), so a failed read retries once
        // and then falls back to a truncated-address label — a flaky read must never hide the
        // whole bar.
        const enriched = await Promise.all(
          top.map(async (r) => {
            let symbol = "";
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                symbol = await getLaunch(r.launch, provider).symbol();
                break;
              } catch {
                if (attempt === 1) symbol = `${r.launch.slice(0, 6)}…${r.launch.slice(-4)}`;
                else await new Promise((res) => setTimeout(res, 700));
              }
            }
            return { ...r, symbol };
          }),
        );
        if (alive) setRows(enriched);
      } catch {
        // endpoint unreachable — bar simply stays hidden
      }
    }

    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!rows || rows.length === 0) return null; // nothing trending — bar stays hidden

  // Two copies of the strip back to back: the animation slides the track by exactly one copy
  // (-50%), so the loop is seamless no matter how wide the content is.
  const strip = (ariaHidden: boolean) => (
    <div className="flex w-max shrink-0 items-center gap-6 pr-6" aria-hidden={ariaHidden}>
      {rows.map((r, i) => {
        const up = r.change24h >= 0;
        return (
          <Link
            key={r.launch}
            href={`/coin/${r.launch}`}
            className="group/item flex shrink-0 items-center gap-2"
            tabIndex={ariaHidden ? -1 : 0}
          >
            <span className="font-mono text-[10px] text-muted">{i + 1}</span>
            {r.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
            ) : (
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
                style={{ background: `hsl(${hueFor(r.launch)}, 55%, 42%)` }}
              >
                {r.symbol.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="max-w-28 truncate text-xs font-semibold text-foreground">{r.symbol}</span>
            <Change pct={r.change24h} />
          </Link>
        );
      })}
    </div>
  );

  return (
    <div className="marquee group overflow-hidden border-b border-border bg-bg/80 py-1.5" title="Top tokens by 24h volume">
      <div className="flex w-max animate-marquee group-hover:[animation-play-state:paused]">
        {strip(false)}
        {strip(true)}
      </div>
    </div>
  );
}
