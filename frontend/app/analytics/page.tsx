"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppState } from "@/lib/appState";
import { EMPTY_ANALYTICS, PlatformAnalytics, fetchPlatformAnalytics } from "@/lib/analytics";
import { usdCompact } from "@/lib/launchpad";
import PriceLabel from "@/components/PriceLabel";
import DailyBarChart from "@/components/DailyBarChart";
import { SkeletonRows, SkeletonStat, Skeleton } from "@/components/Skeleton";

function compactUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function AnalyticsPage() {
  const router = useRouter();
  const { addresses } = useAppState();
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
    return <div className="p-10 text-center text-sm text-muted">Connecting to network...</div>;
  }

  const totalFees = data.protocolFeesUsd + data.creatorFeesUsd;
  const totalLycFees = data.lycMintFeesUsd + data.lycRedeemFeesUsd;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Analytics</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Measured on-chain: every trade is decoded from its own coin&apos;s events and priced
          through the collateral oracle. Fees are read from the contracts themselves — the record of
          what was actually charged, including fees already claimed — not inferred from volume.
        </p>
      </div>

      {/* TVL */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Total value locked</h2>
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
                label="Senior — LYC"
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
                sub="takes 100% of the collateral\u2019s move, both ways"
              />
            </>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          Every coin&apos;s collateral (WETH, cbBTC) the protocol holds: each bonding-curve raise
          before graduation, then its paired pool afterwards. Nothing here is borrowed — leverage comes from pairing
          against LYC&apos;s senior capital, not from a lending market, so the split shown is
          senior against junior rather than gross against debt. The two sides sum to TVL plus idle
          cash by construction.
        </p>
      </section>

      {/* The senior book */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
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
        <p className="text-[11px] leading-relaxed text-muted">
          No launch is capped in how much senior it may take. Scarcity is priced instead: the
          funding rate climbs steeply as utilisation rises, so depositing pays most exactly when the
          protocol most needs deposits, and the rate settles back on its own as the queue refills.
          That rate is a cost to memecoin holders — renting leverage should be dear when the capital
          behind it is scarce.
        </p>
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
              subtitle="Recent daily context with the latest completed day highlighted."
              totalValue={compactUsd(data.dailyVolume.reduce((s, d) => s + d.value, 0))}
            />
            <DailyBarChart
              data={data.dailyLaunches}
              title="Token launches"
              subtitle="Recent daily context with the latest completed day highlighted."
              totalValue={`${(data.dailyLaunches.reduce((s, d) => s + d.value, 0)).toLocaleString()}`}
            />
          </>
        )}
      </section>

      {/* volume + activity */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Traded volume</h2>
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
          <Stat label="Total volume" value={compactUsd(data.totalVolumeUsd)} sub="all coins, all time" accent />
          <Stat label="24h volume" value={compactUsd(data.volume24hUsd)} sub={`${data.totalTrades.toLocaleString()} trades all time`} />
          <Stat
            label="Active traders (24h)"
            value={data.activeTraders24h.toLocaleString()}
            sub="unique wallets that traded"
          />
          <Stat
            label="Coins launched"
            value={data.totalLaunches.toLocaleString()}
            sub={`${data.totalGraduated} graduated${
              data.totalLaunches > 0
                ? ` · ${((data.totalGraduated / data.totalLaunches) * 100).toFixed(0)}%`
                : ""
            }`}
          />
          </>
          )}
        </div>
      </section>

      {/* trading fees */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Trading fees</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!loaded ? (
            <>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </>
          ) : (
          <>
          <Stat label="Total trading fees" value={compactUsd(totalFees)} sub="1.00% of every trade — 50% creator, rest split protocol/LYC" accent />
          <Stat
            label="Protocol fees"
            value={compactUsd(data.protocolFeesUsd)}
            sub="45–50% share, to the treasury"
          />
          <Stat
            label="Creator fees"
            value={compactUsd(data.creatorFeesUsd)}
            sub="Flat 50% share, paid to coin creators"
            tag={loaded ? `${compactUsd(data.creatorFeesUsd - data.claimedCreatorFeesUsd)} claimable` : undefined}
          />
          </>
          )}
        </div>
        {totalFees > 0 ? (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex justify-between text-xs text-muted">
              <span>Protocol {((data.protocolFeesUsd / totalFees) * 100).toFixed(1)}%</span>
              <span>Creators {((data.creatorFeesUsd / totalFees) * 100).toFixed(1)}%</span>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface">
              <div className="h-full bg-accent" style={{ width: `${(data.protocolFeesUsd / totalFees) * 100}%` }} />
              <div className="h-full bg-green" style={{ width: `${(data.creatorFeesUsd / totalFees) * 100}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-muted">
              &ldquo;Total trading fees&rdquo; above is protocol + creator only — it does not
              include the up-to-5% LYC slice, which scales with how much senior is paired against
              each coin and lands as LYC yield instead, not here. See &ldquo;Pairing + harvested
              fees&rdquo; on the LYC page.
            </p>
          </div>
        ) : null}
      </section>

      {/* LYC mint/redeem fees */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">LYC fees</h2>
        <p className="text-xs text-muted -mt-1">
          Separate from trading fees above: charged to LYC depositors and redeemers, not to
          memecoin traders. Both mint straight to the protocol treasury as liquid LYC — a
          protocol fee, not a NAV lift shared with every holder.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {!loaded ? (
            <>
              <SkeletonStat />
              <SkeletonStat />
              <SkeletonStat />
            </>
          ) : (
          <>
          <Stat label="Total LYC fees" value={compactUsd(totalLycFees)} sub="Lifetime, both charged to the treasury" accent />
          <Stat label="Mint fees" value={compactUsd(data.lycMintFeesUsd)} sub="0.10% of every LYC deposit" />
          <Stat label="Redeem fees" value={compactUsd(data.lycRedeemFeesUsd)} sub="0.25% of every covered exit" />
          </>
          )}
        </div>
      </section>

      {/* coins + top pnl */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Coins by volume</h2>
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
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase text-muted">
                    <th className="px-4 py-2.5 text-left font-medium">Coin</th>
                    <th className="px-4 py-2.5 text-right font-medium">Price</th>
                    <th className="px-4 py-2.5 text-right font-medium">Market cap</th>
                    <th className="px-4 py-2.5 text-right font-medium">24h vol</th>
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
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Top P&amp;L</h2>
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
              {data.topPnl.map((t, i) => (
                <div key={t.address} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-4 shrink-0 text-xs text-muted">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-foreground">{short(t.address)}</div>
                    <div className="font-mono text-[10px] text-muted">
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
              ))}
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-muted">
            Realized only — cash out minus cash in, from trades alone. A wallet still holding its
            position isn&apos;t counted as a loss, because what it paid is knowable but what it will
            get is not.
          </p>
        </section>
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
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold ${accent ? "text-accent" : "text-foreground"}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted">{sub}</div> : null}
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
