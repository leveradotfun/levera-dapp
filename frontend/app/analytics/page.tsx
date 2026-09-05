"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppState } from "@/lib/appState";
import { useWallet } from "@/lib/wallet";
import { EMPTY_ANALYTICS, PlatformAnalytics, fetchPlatformAnalytics } from "@/lib/analytics";
import { usdCompact } from "@/lib/launchpad";
import { timeAgo } from "@/lib/utils";
import { useXHandles } from "@/lib/xHandles";
import PriceLabel from "@/components/PriceLabel";
import DailyBarChart from "@/components/DailyBarChart";
import TraderIdentity from "@/components/TraderIdentity";
import { SkeletonRows, SkeletonStat, Skeleton } from "@/components/Skeleton";
import ShimmerText from "@/components/ShimmerText";

function compactUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export default function AnalyticsPage() {
  const router = useRouter();
  const { addresses } = useAppState();
  const wallet = useWallet(addresses);
  const handles = useXHandles();
  const [data, setData] = useState<PlatformAnalytics>(EMPTY_ANALYTICS);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!addresses) return;
    try {
      setData(await fetchPlatformAnalytics(addresses));
    } catch {
      // anvil down / stale deployment -- keep the last good numbers rather than blanking the page
    } finally {
      setLoaded(true);
    }
  }, [addresses]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!addresses) {
    return <div className="p-10 text-center text-sm text-muted"><ShimmerText>Connecting to network...</ShimmerText></div>;
  }

  const totalFees = data.protocolFeesUsd + data.creatorFeesUsd;
  const totalLycFees = data.lycMintFeesUsd + data.lycRedeemFeesUsd;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Analytics</h1>
        <p className="mt-1 text-sm text-secondary">
          Independent onchain reporting for Levera markets.
        </p>
      </div>

      {/* TVL */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Total value locked</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!loaded ? (
            <>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </>
          ) : (
            <>
              <Stat
                label="TVL"
                value={compactUsd(data.tvlUsd)}
                sub={`across ${data.totalLaunches} coin${
                  data.totalLaunches === 1 ? "" : "s"
                }`}
                accent
              />
              <Stat
                label="vLYC — yield pool"
                value={compactUsd(data.seniorUsd)}
                sub={
                  data.lycGlobalCr > 0
                    ? `${data.lycGlobalCr.toFixed(2)}x covered · NAV $${data.lycNav.toFixed(4)}`
                    : "no senior outstanding yet"
                }
              />
              <Stat
                label="Junior — memecoins"
                value={compactUsd(data.juniorUsd)}
                sub={"takes 100% of the collateral’s move, both ways"}
              />
            </>
          )}
        </div>
      </section>

      {/* The senior book */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
          Senior capital — LYC
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!loaded ? (
            <>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </>
          ) : (
            <>
              <Stat
                label="Funding APR"
                value={`${(data.fundingApr * 100).toFixed(2)}%`}
                sub="paid by memecoins to LYC holders"
                accent
              />
              <Stat
                label="Utilisation"
                value={`${(data.seniorUtilization * 100).toFixed(1)}%`}
                sub={`${compactUsd(data.lycIdleUsdc)} idle and ready to pair`}
              />
              <Stat
                label="NAV per LYC"
                value={`$${data.lycNav.toFixed(4)}`}
                sub={
                  data.lycGlobalCr > 0
                    ? `${data.lycGlobalCr.toFixed(3)}x global cover`
                    : "issued at $1"
                }
              />
            </>
          )}
        </div>
      </section>

      {/* Daily charts */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {!loaded ? (
          <>
            <div className="rounded-xl border border-border bg-card p-5 h-52 animate-pulse" />
            <div className="rounded-xl border border-border bg-card p-5 h-52 animate-pulse" />
          </>
        ) : (
          <>
            <DailyBarChart
              data={data.dailyVolume}
              title="Trading volume"
              subtitle="Latest completed day highlighted."
              totalValue={compactUsd(data.dailyVolume.reduce((s, d) => s + d.value, 0))}
            />
            <DailyBarChart
              data={data.dailyLaunches}
              title="Token launches"
              subtitle="Latest completed day highlighted."
              totalValue={`${(data.dailyLaunches.reduce((s, d) => s + d.value, 0)).toLocaleString()}`}
              valueFormat="count"
            />
          </>
        )}
      </section>

      {/* Market activity: buy/sell pressure + unique traders */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {!loaded ? (
          <>
            <div className="rounded-xl border border-border bg-card p-5 h-52 animate-pulse" />
            <div className="rounded-xl border border-border bg-card p-5 h-52 animate-pulse" />
          </>
        ) : (
          <>
            <PressureChart data={data.dailyPressure} />
            <DailyBarChart
              data={data.dailyTraders}
              title="Unique traders"
              subtitle="Latest completed day highlighted."
              totalValue={`${Math.max(...data.dailyTraders.map((d) => d.value), 0).toLocaleString()}`}
              color="#22c55e"
              valueFormat="count"
            />
          </>
        )}
      </section>

      {/* Protocol rebalances */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
          Protocol rebalances
        </h2>
        {!loaded ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SkeletonStat />
            <SkeletonStat />
            <SkeletonStat />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat
                label="Rebalance operations"
                value={data.rebalances.total.toLocaleString()}
                sub={`${data.rebalances.last24h} in the last 24h`}
                accent
              />
              <Stat
                label="Collateral redeployed"
                value={compactUsd(data.rebalances.usdMoved)}
                sub="all-time total"
              />
              <Stat
                label="Latest operation"
                value={data.rebalances.lastTs ? `${timeAgo(data.rebalances.lastTs)} ago` : "—"}
                sub="decoded from Launch logs"
              />
            </div>
            {data.rebalances.total > 0 ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                  {(
                    [
                      ["paired", "Paired", "text-green"],
                      ["relever", "Relever", "text-green"],
                      ["reserve", "Reserve", "text-blue-400"],
                      ["protect", "Delever", "text-red"],
                      ["release", "Peel", "text-red"],
                      ["netted", "Net", "text-red"],
                    ] as const
                  ).map(([key, label, color]) => (
                    <span key={key} className={`font-mono ${color}`}>
                      {label} <span className="text-foreground">{data.rebalances.counts[key]}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* volume + activity */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Traded volume</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {!loaded ? (
            <>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </>
          ) : (
          <>
          <Stat label="Total volume" value={compactUsd(data.totalVolumeUsd)} sub={`${data.totalTrades.toLocaleString()} trades all time`} accent />
          <Stat label="24h volume" value={compactUsd(data.volume24hUsd)} sub={`${data.trades24h.toLocaleString()} trades in the window`} />
          <Stat
            label="Active traders (24h)"
            value={data.activeTraders24h.toLocaleString()}
            sub="unique wallets"
          />
          <Stat
            label="Coins launched"
            value={data.totalLaunches.toLocaleString()}
            sub={`${data.totalGraduated} graduated${
              data.totalLaunches > 0
                ? ` · ${((data.totalGraduated / data.totalLaunches) * 100).toFixed(0)}%`
                : ""
            }${
              data.medianGraduationHours !== null
                ? ` · median grad ${data.medianGraduationHours >= 24 ? `${(data.medianGraduationHours / 24).toFixed(1)}d` : `${data.medianGraduationHours.toFixed(1)}h`}`
                : ""
            }`}
          />
          </>
          )}
        </div>
      </section>

      {/* trading fees */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Trading fees</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!loaded ? (
            <>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </>
          ) : (
          <>
          <Stat label="Total trading fees" value={compactUsd(totalFees)} sub={totalFees > 0 && data.totalVolumeUsd > 0 ? `1.00% per trade — reads ${(totalFees / data.totalVolumeUsd * 100).toFixed(2)}% of volume` : "1.00% per trade"} accent />
          <Stat
            label="Protocol fees"
            value={compactUsd(data.protocolFeesUsd)}
            sub="to the treasury"
          />
          <Stat
            label="Creator fees"
            value={compactUsd(data.creatorFeesUsd)}
            sub="paid to coin creators"
            tag={loaded ? `${compactUsd(data.creatorFeesUsd - data.claimedCreatorFeesUsd)} claimable` : undefined}
          />
          </>
          )}
        </div>
        {totalFees > 0 ? (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex justify-between text-xs text-secondary">
              <span>Protocol {((data.protocolFeesUsd / totalFees) * 100).toFixed(1)}%</span>
              <span>Creators {((data.creatorFeesUsd / totalFees) * 100).toFixed(1)}%</span>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface">
              <div className="h-full bg-accent" style={{ width: `${(data.protocolFeesUsd / totalFees) * 100}%` }} />
              <div className="h-full bg-green" style={{ width: `${(data.creatorFeesUsd / totalFees) * 100}%` }} />
            </div>
            <p className="mt-2 text-xs text-secondary">
              Excludes the up-to-5% LYC slice — that lands as LYC yield, not here.
            </p>
          </div>
        ) : null}
      </section>

      {/* LYC mint/redeem fees */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">LYC fees</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!loaded ? (
            <>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </>
          ) : (
          <>
          <Stat label="Total LYC fees" value={compactUsd(totalLycFees)} sub="lifetime, to the treasury" accent />
          <Stat label="Mint fees" value={compactUsd(data.lycMintFeesUsd)} sub="0.10% of every LYC deposit" />
          <Stat label="Redeem fees" value={compactUsd(data.lycRedeemFeesUsd)} sub="0.25% of every covered exit" />
          </>
          )}
        </div>
      </section>

      {/* coins + top pnl */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Coins by volume</h2>
          {!loaded ? (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <tbody>
                  <SkeletonRows rows={4} cols={5} />
                </tbody>
              </table>
            </div>
          ) : data.launches.length === 0 ? (
            <Empty>No coins launched yet.</Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase text-muted">
                    <th className="px-4 py-2.5 text-left font-medium">Coin</th>
                    <th className="px-4 py-2.5 text-right font-medium">Price</th>
                    <th className="px-4 py-2.5 text-right font-medium">Market cap</th>
                    <th className="px-4 py-2.5 text-right font-medium">24h vol</th>
                    <th className="px-4 py-2.5 text-right font-medium">24h</th>
                    <th className="px-4 py-2.5 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.launches]
                    .sort((a, b) => b.stats.volume24hUsd - a.stats.volume24hUsd)
                    .map((l) => (
                      <tr
                        key={l.address}
                        onClick={() => router.push(`/coin/${l.address}`)}
                        className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-hover"
                      >
                        <td className="px-4 py-3">
                          <div className="font-semibold text-foreground">{l.name}</div>
                          <div className="font-mono text-xs text-muted">${l.symbol}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-secondary"><PriceLabel value={l.priceUsd} /></td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">{usdCompact(l.marketCapUsd)}</td>
                        <td className="px-4 py-3 text-right font-mono text-foreground">
                          {compactUsd(l.stats.volume24hUsd)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          {l.stats.change24h === null ? (
                            <span className="text-muted">—</span>
                          ) : (
                            <span className={l.stats.change24h >= 0 ? "text-green" : "text-red"}>
                              {l.stats.change24h >= 0 ? "+" : ""}
                              {l.stats.change24h.toFixed(1)}%
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {l.graduated ? (
                            <span className="rounded-full bg-green/15 px-2 py-0.5 text-[10px] font-semibold text-green">
                              LIVE
                            </span>
                          ) : (
                            <span className="font-mono text-[11px] text-muted">
                              {l.pctToGraduation.toFixed(0)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Top P&amp;L</h2>
          {!loaded ? (
            <div className="divide-y divide-border/50 rounded-xl border border-border bg-card">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-3 w-3" />
                  <div className="flex-1">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="mt-1.5 h-2.5 w-32" />
                  </div>
                  <Skeleton className="h-4 w-14" />
                </div>
              ))}
            </div>
          ) : data.topPnl.length === 0 ? (
            <Empty>No realized P&amp;L yet — nobody has sold.</Empty>
          ) : (
            <div className="divide-y divide-border/50 rounded-xl border border-border bg-card">
              {data.topPnl.map((t, i) => {
                const identity = handles.get(t.address.toLowerCase());
                return (
                  <div
                    key={t.address}
                    onClick={() => router.push(`/profile/${t.address}`)}
                    title="View profile"
                    className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
                  >
                    <span className="w-4 shrink-0 text-xs text-muted">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-foreground">
                        <TraderIdentity
                          address={t.address}
                          identity={identity}
                          size={18}
                          isMe={!!wallet.address && t.address.toLowerCase() === wallet.address.toLowerCase()}
                        />
                      </div>
                      <div className="font-mono text-[11px] text-secondary">
                        {t.trades} trades · {compactUsd(t.volumeUsd)} vol
                      </div>
                    </div>
                    <span
                      className={`shrink-0 font-mono text-sm font-semibold ${
                        t.realizedUsd >= 0 ? "text-green" : "text-red"
                      }`}
                    >
                      {t.realizedUsd >= 0 ? "+" : "−"}
                      {compactUsd(Math.abs(t.realizedUsd))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-secondary">
            Realized only — wallets still holding a position aren&apos;t counted.
          </p>
        </section>
      </div>
    </div>
  );
}

/// Daily buy-vs-sell volume as one stacked column per day. Same visual grammar as DailyBarChart,
/// but the split is the point: a tall green day with a stub red one reads instantly as one-sided
/// demand, which a single total-per-day bar can never show.
function PressureChart({ data }: { data: PlatformAnalytics["dailyPressure"] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.buyUsd + d.sellUsd), 1);
  const totalBuy = data.reduce((s, d) => s + d.buyUsd, 0);
  const totalSell = data.reduce((s, d) => s + d.sellUsd, 0);

  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
  };

  const labelIndices = new Set<number>([0, Math.floor(data.length / 2), data.length - 1]);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="text-lg font-semibold text-foreground">Buy / sell pressure</div>
          <div className="mt-0.5 text-sm text-muted">Daily volume split by side.</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-foreground">{compactUsd(totalBuy + totalSell)}</div>
          <div className="mt-0.5 text-xs text-secondary">
            <span className="text-green">■ buys {compactUsd(totalBuy)}</span>
            {" · "}
            <span className="text-red">■ sells {compactUsd(totalSell)}</span>
          </div>
        </div>
      </div>

      <div className="flex h-32 items-end gap-[3px]">
        {data.map((d, i) => {
          const total = d.buyUsd + d.sellUsd;
          const isLast = i === data.length - 1;
          const buyH = total > 0 ? (d.buyUsd / max) * 100 : 0;
          const sellH = total > 0 ? (d.sellUsd / max) * 100 : 0;
          return (
            <div key={i} className="flex h-full flex-1 flex-col items-center justify-end" title={`${d.date} · buys ${fmt(d.buyUsd)} / sells ${fmt(d.sellUsd)}`}>
              <div
                className="w-full rounded-t-sm transition-all duration-300"
                style={{ height: `${sellH > 0 ? Math.max(sellH, 1.5) : 0}%`, backgroundColor: isLast ? "#ef4444" : "#ef444499" }}
              />
              <div
                className="w-full transition-all duration-300"
                style={{ height: `${buyH > 0 ? Math.max(buyH, 1.5) : 0}%`, backgroundColor: isLast ? "#22c55e" : "#22c55e99" }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-secondary">
        {data.map((d, i) => (labelIndices.has(i) ? <span key={i}>{d.date}</span> : null))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  tag,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  tag?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs text-secondary">{label}</div>
      <div className={`mt-1 font-mono text-3xl font-semibold ${accent ? "text-accent" : "text-foreground"}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
      {tag ? (
        <div className="mt-1.5 inline-block rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-green">
          {tag}
        </div>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}
