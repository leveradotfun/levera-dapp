"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { LaunchSummary, WAD } from "@/lib/launchpad";
import { LycGlobal, fetchLycGlobal } from "@/lib/lyc";
import { DeployedAddresses } from "@/lib/chain";

/// Explore header stats, computed from the launch list the page already holds plus one LYC read.
/// Kept cheap on purpose: the launches arrive on the page's own poll, and the Earn Pool figure is
/// a single read refreshed on the same cadence.
export default function ExploreStats({
  launches,
  addresses,
}: {
  launches: LaunchSummary[];
  addresses: DeployedAddresses | null;
}) {
  const [lyc, setLyc] = useState<LycGlobal | null>(null);

  useEffect(() => {
    if (!addresses) return;
    let stopped = false;
    const load = () =>
      fetchLycGlobal(addresses)
        .then((g) => !stopped && setLyc(g))
        .catch(() => {});
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [addresses]);

  const totalRaisedUsd = launches.reduce((sum, l) => sum + l.raisedUsd, 0n);
  const volume24h = launches.reduce((sum, l) => sum + l.stats.volume24hUsd, 0);
  const graduated = launches.filter((l) => l.graduated).length;

  const tiles: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Coins", value: launches.length.toLocaleString("en-US"), sub: `${graduated} graduated` },
    {
      label: "Total raised",
      value: `$${(
        Number(totalRaisedUsd / 10n ** 14n) / 10_000
      ).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    },
    {
      label: "24h volume",
      value: `$${volume24h.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    },
    {
      label: "LYC NAV",
      value: lyc ? `$${(Number(lyc.nav) / 1e18).toFixed(4)}` : "—",
      sub: lyc ? `${(Number(lyc.supply) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} shares` : undefined,
    },
  ];

  return (
    <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="min-w-0 bg-card px-4 py-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">{t.label}</div>
          <div className="truncate font-mono text-base font-bold text-foreground lg:text-lg">{t.value}</div>
          {t.sub ? <div className="truncate text-[10px] text-muted">{t.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
