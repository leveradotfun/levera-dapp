"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useDisconnect } from "wagmi";
import { useAppState } from "@/lib/appState";
import { useWallet, shortAddress } from "@/lib/wallet";
import ConnectWalletButton from "@/components/ConnectWalletButton";
import {
  CreatorFees,
  HeldLaunch,
  LaunchSummary,
  ClaimRecord,
  claimFees,
  fetchCollateralPriceUsd,
  fetchCreatorFees,
  fetchHoldings,
  fetchLaunchesByCreator,
  fetchClaimHistory,
  formatWad,
  usd,
  usdCompact,
  WAD,
} from "@/lib/launchpad";
import { Skeleton } from "@/components/Skeleton";
import { tradesFor } from "@/lib/launchStats";
import PriceLabel from "@/components/PriceLabel";
import { TxLink } from "@/components/ExplorerLink";
import { LycGlobal, LycPosition, fetchLycGlobal, fetchLycPosition, fetchLycPnl, LycPnl } from "@/lib/lyc";
import { useXAuth } from "@/lib/useXAuth";
import { loadXProfile } from "@/lib/xAuth";

type CreatedRow = { launch: LaunchSummary; fees: CreatorFees };
type Tab = "open" | "closed" | "activity" | "lyc";

const PALETTE = ["#ECE3D1", "#22c55e", "#38bdf8", "#f472b6", "#fbbf24", "#a78bfa", "#fb7185", "#34d399"];
const EMOJI = ["🐕", "🚀", "🌙", "🐸", "💎", "🔥", "⚡", "🦍", "🍌", "👽"];

function hashOf(address: string): number {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return h;
}

function isValidAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

export default function ProfileAddressPage() {
  const params = useParams<{ address: string }>();
  const rawAddress = params.address ?? "";
  const profileAddress = isValidAddress(rawAddress) ? rawAddress : null;

  const router = useRouter();
  const { addresses, launches } = useAppState();
  const wallet = useWallet(addresses);
  const isOwnProfile = wallet.address?.toLowerCase() === profileAddress?.toLowerCase();
  // For other wallets, read their X profile directly from storage (no connect)
  const otherXProfile = profileAddress && !isOwnProfile ? loadXProfile(profileAddress) : null;
  const xAuth = useXAuth(isOwnProfile ? wallet.address : null);
  const displayXProfile = isOwnProfile ? xAuth.profile : otherXProfile;
  const { disconnect } = useDisconnect();

  const [created, setCreated] = useState<CreatedRow[] | null>(null);
  const [holdings, setHoldings] = useState<HeldLaunch[] | null>(null);
  const [claimHistory, setClaimHistory] = useState<ClaimRecord[]>([]);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("open");
  const [timeframe, setTimeframe] = useState<"1D" | "1W" | "1M">("1D");
  const [collateralPrice, setCollateralPrice] = useState<bigint>(0n);
  const [lycGlobal, setLycGlobal] = useState<LycGlobal | null>(null);
  const [lycPosition, setLycPosition] = useState<LycPosition | null>(null);
  const [lycPnl, setLycPnl] = useState<LycPnl | null>(null);

  const targetAddress = profileAddress;

  const refresh = useCallback(async () => {
    if (!addresses || !targetAddress) {
      setCreated(null);
      setHoldings(null);
      setClaimHistory([]);
      setLycGlobal(null);
      setLycPosition(null);
      setLycPnl(null);
      return;
    }
    try {
      const collateralPriceUsd = await fetchCollateralPriceUsd(addresses.oracle);
      setCollateralPrice(collateralPriceUsd);
      const [mine, held, lycG, lycP] = await Promise.all([
        fetchLaunchesByCreator(addresses, targetAddress),
        fetchHoldings(addresses, targetAddress),
        fetchLycGlobal(addresses),
        fetchLycPosition(addresses, targetAddress),
      ]);
      const rows = await Promise.all(
        mine.map(async (launch) => ({
          launch,
          fees: await fetchCreatorFees(launch.address, targetAddress, collateralPriceUsd),
        }))
      );
      setCreated(rows);
      setHoldings(held);
      setLycGlobal(lycG);
      setLycPosition(lycP);
      if (lycG) {
        const pnl = await fetchLycPnl(addresses, targetAddress, lycG.nav);
        setLycPnl(pnl);
      }
      const history = await fetchClaimHistory(mine, targetAddress, collateralPriceUsd);
      setClaimHistory(history);
    } catch {
      // anvil down / stale addresses
    }
  }, [addresses, targetAddress]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function onClaim(launchAddress: string) {
    if (!isOwnProfile) return;
    setClaiming(launchAddress);
    try {
      await claimFees(launchAddress);
      await refresh();
    } catch {
      // a claim with nothing to claim reverts
    } finally {
      setClaiming(null);
    }
  }

  if (!profileAddress) {
    return (
      <div className="p-10 text-center">
        <p className="text-sm text-red">Invalid address — expected 0x + 40 hex characters.</p>
        <button onClick={() => router.push("/")} className="mt-2 text-sm text-accent hover:underline">
          Back to all coins
        </button>
      </div>
    );
  }

  if (!addresses) {
    return <div className="p-10 text-center text-sm text-muted">Connecting to network...</div>;
  }

  const lifetimeFeesUsd = (created ?? []).reduce((sum, r) => sum + r.fees.lifetimeUsd, 0n);
  const holdingsValueUsd = (holdings ?? []).reduce((sum, h) => sum + h.valueUsd, 0n);
  const holdingsPnlUsd = (holdings ?? []).reduce((sum, h) => sum + h.pnlUsd, 0n);
  // For other profiles, we don't have wallet balances — show 0, the on-chain holdings are still fetched
  const ethBalance = isOwnProfile && wallet.balances ? formatWad(wallet.balances.eth, 4) : "0";
  const ethValueUsd = isOwnProfile && wallet.balances ? (wallet.balances.eth * collateralPrice) / 10n ** 18n : 0n;

  // Compute realized PnL from trade history for the profile address
  const userAddr = profileAddress.toLowerCase();
  let realizedPnl = 0;
  let buyVolume = 0;
  for (const launch of launches) {
    const trades = tradesFor(launch.address);
    for (const t of trades) {
      if (t.trader !== userAddr) continue;
      if (t.type === "rebalance") continue;
      if (t.isBuy) buyVolume += t.volumeUsd;
      else realizedPnl += t.volumeUsd;
    }
  }
  realizedPnl -= buyVolume;

  const h = hashOf(profileAddress);
  const color = PALETTE[h % PALETTE.length];
  const emoji = EMOJI[(h >>> 3) % EMOJI.length];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_0.7fr]">
      {/* Left Column */}
      <div className="space-y-4">
        {/* Profile Header */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="h-32 bg-gradient-to-br from-green/20 via-accent/10 to-transparent relative">
            <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "radial-gradient(circle at 20% 50%, rgba(34,197,94,0.3) 0%, transparent 50%), radial-gradient(circle at 80% 50%, rgba(200,255,0,0.2) 0%, transparent 50%)" }} />
          </div>
          <div className="px-6 pb-6">
            <div className="flex items-end gap-4 -mt-10">
              {displayXProfile ? (
                <img src={displayXProfile.profileImageUrl} alt={displayXProfile.name} className="h-20 w-20 shrink-0 rounded-2xl border-4 border-card object-cover" />
              ) : (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl text-4xl border-4 border-card" style={{ backgroundColor: `${color}22`, border: `2px solid ${color}55` }}>
                  {emoji}
                </div>
              )}
              <div className="flex-1 pb-1">
                <div className="flex items-center gap-2">
                  {displayXProfile ? (
                    <>
                      <h1 className="text-2xl font-bold text-foreground">{displayXProfile.name}</h1>
                      <span className="text-sm text-muted">@{displayXProfile.username}</span>
                    </>
                  ) : (
                    <h1 className="text-2xl font-bold text-foreground">trader</h1>
                  )}
                  {isOwnProfile && !displayXProfile && (
                    <button onClick={xAuth.connect} className="text-xs text-accent hover:text-accent/80 transition-colors font-medium">
                      Connect X
                    </button>
                  )}
                </div>
                {displayXProfile ? (
                  <div className="flex items-center gap-4 text-sm text-muted mt-1">
                    <a href={`https://x.com/${displayXProfile.username}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
                      @{displayXProfile.username}
                    </a>
                  </div>
                ) : (
                  <div className="flex items-center gap-4 text-sm text-muted mt-1">
                    <span><span className="font-semibold text-foreground">0</span> Followers</span>
                    <span><span className="font-semibold text-foreground">0</span> Following</span>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm">
              <span className="font-mono text-muted">{shortAddress(profileAddress)}</span>
              <button onClick={() => navigator.clipboard.writeText(profileAddress)} className="text-muted hover:text-foreground transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              {!isOwnProfile && wallet.isConnected && (
                <span className="ml-2 text-[11px] text-muted">Viewing as {shortAddress(wallet.address!)}</span>
              )}
            </div>
          </div>
        </div>

        {/* Portfolio Value */}
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-4xl font-bold text-foreground">{usd(holdingsValueUsd)}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className={`text-sm font-semibold ${holdingsPnlUsd >= 0n ? "text-green" : "text-red"}`}>
                  {holdingsPnlUsd >= 0n ? "+" : ""}{usd(holdingsPnlUsd)} ({holdingsValueUsd > 0n ? ((Number(holdingsPnlUsd) / Number(holdingsValueUsd)) * 100).toFixed(2) : "0.00"}%)
                </span>
                <span className="text-sm text-muted">{timeframe}</span>
              </div>
            </div>
            <div className="flex items-center gap-1 bg-surface rounded-lg p-0.5">
              {(["1D", "1W", "1M"] as const).map((tf) => (
                <button key={tf} onClick={() => setTimeframe(tf)} className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${timeframe === tf ? "bg-card text-foreground" : "text-muted hover:text-foreground"}`}>
                  {tf}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/20 text-[10px] text-accent">$</span>
              <span className="text-sm font-medium text-foreground">{ethBalance} ETH</span>
              <span className="text-sm text-muted">≈ {usd(ethValueUsd)}</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mt-6">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Realized</div>
              <div className={`mt-1 font-mono text-lg ${realizedPnl >= 0 ? "text-green" : "text-red"}`}>{usd(BigInt(Math.round(realizedPnl * 1e18)))}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Unrealized</div>
              <div className={`mt-1 font-mono text-lg ${holdingsPnlUsd >= 0n ? "text-green" : "text-red"}`}>{usd(holdingsPnlUsd)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Buy Volume</div>
              <div className="mt-1 font-mono text-lg text-foreground">{usd(BigInt(Math.round(buyVolume * 1e18)))}</div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2">
          {(["open", "closed", "activity", "lyc"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab ? "bg-accent text-accent-ink" : "bg-surface text-muted hover:text-foreground"}`}>
              {tab === "lyc" ? "LYC" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Positions List */}
        <div className="space-y-2">
          {holdings === null ? (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="space-y-3 p-4">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            </div>
          ) : holdings.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">No open positions</div>
          ) : (
            holdings.map((h) => {
              const hc = hashOf(h.address);
              const hColor = PALETTE[hc % PALETTE.length];
              const hEmoji = EMOJI[(hc >>> 3) % EMOJI.length];
              return (
                <button key={h.address} onClick={() => router.push(`/coin/${h.address}`)} className="w-full flex items-center justify-between rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-accent/40 hover:bg-hover">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg" style={{ backgroundColor: `${hColor}22`, border: `1px solid ${hColor}55` }}>
                      {hEmoji}
                    </div>
                    <div>
                      <div className="font-semibold text-foreground">${h.symbol}</div>
                      <div className="text-xs text-muted">{h.name}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-foreground">{usd(h.valueUsd)}</div>
                    <div className={`font-mono text-xs ${h.pnlUsd >= 0n ? "text-green" : "text-red"}`}>
                      {h.pnlUsd >= 0n ? "+" : ""}{usd(h.pnlUsd)}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Created Coins */}
        {created && created.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">Coins launched <span className="text-muted">({created.length})</span></h2>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-muted">Total Lifetime Fees</div>
                <div className="font-mono text-sm font-semibold text-foreground">{usd(lifetimeFeesUsd)}</div>
              </div>
            </div>
            <div className="space-y-2">
              {created.map(({ launch, fees }) => (
                <div key={launch.address} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button onClick={() => router.push(`/coin/${launch.address}`)} className="text-left">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{launch.name}</span>
                        <span className="font-mono text-xs text-muted">${launch.symbol}</span>
                        {launch.graduated ? (
                          <span className="rounded-full bg-green/15 px-1.5 py-0.5 text-[10px] font-semibold text-green">LIVE</span>
                        ) : (
                          <span className="font-mono text-[10px] text-muted">{launch.pctToGraduation.toFixed(1)}%</span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-muted"><PriceLabel value={launch.priceUsd} /> · MC {usdCompact(launch.marketCapUsd)}</div>
                    </button>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-[10px] uppercase tracking-wide text-muted">Lifetime</div>
                        <div className="font-mono text-xs text-muted">{usd(fees.lifetimeUsd)}</div>
                      </div>
                      {isOwnProfile ? (
                        fees.inHfyc ? (
                          <div className="text-right">
                            <div className="text-[10px] uppercase tracking-wide text-muted">Fee denom</div>
                            <div className="font-mono text-sm font-semibold text-foreground">LYC</div>
                            <div className="text-[10px] text-muted">minted at harvest, withdraw anytime</div>
                          </div>
                        ) : (
                          <>
                            <div className="text-right">
                              <div className="text-[10px] uppercase tracking-wide text-muted">Claimable</div>
                              <div className="font-mono text-sm font-semibold text-foreground">{usd(fees.claimableUsd)}</div>
                            </div>
                            <button onClick={() => onClaim(launch.address)} disabled={fees.claimableCollateral === 0n || claiming === launch.address} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                              {claiming === launch.address ? "..." : "Claim"}
                            </button>
                          </>
                        )
                      ) : (
                        <div className="text-right">
                          <div className="text-[10px] uppercase tracking-wide text-muted">Fees</div>
                          <div className="font-mono text-xs text-muted">{usd(fees.lifetimeUsd)}</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Right Column */}
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              {displayXProfile?.profileImageUrl ? (
                <img src={displayXProfile.profileImageUrl} alt={displayXProfile.username} className="h-8 w-8 rounded-full object-cover" />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/20">
                  <svg className="w-4 h-4 text-accent" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </div>
              )}
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-muted">X (Twitter)</div>
                <div className="text-sm font-medium text-foreground truncate">{displayXProfile ? `@${displayXProfile.username}` : "Not linked"}</div>
              </div>
            </div>
            {isOwnProfile ? (
              displayXProfile ? (
                <button onClick={() => xAuth.disconnect()} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground transition-colors shrink-0">
                  Disconnect
                </button>
              ) : (
                <button onClick={xAuth.connect} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90 transition-opacity shrink-0">
                  Connect X
                </button>
              )
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/20">
              <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
              </svg>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted">Profile</div>
              <div className="text-sm font-medium text-foreground">{isOwnProfile ? "Your profile" : "Viewing"}</div>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-4 pt-4 border-t border-border">
            <button onClick={() => router.push("/")} className="flex items-center gap-2 text-sm text-muted hover:text-foreground transition-colors">
              Explore coins
            </button>
            {isOwnProfile && wallet.isConnected ? (
              <button onClick={() => disconnect()} className="flex items-center gap-2 text-sm text-muted hover:text-foreground transition-colors">
                Disconnect
              </button>
            ) : !wallet.isConnected ? (
              <ConnectWalletButton className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink" />
            ) : (
              <button onClick={() => router.push(`/profile/${wallet.address}`)} className="flex items-center gap-2 text-sm text-accent hover:text-accent-dim transition-colors">
                View your profile
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
