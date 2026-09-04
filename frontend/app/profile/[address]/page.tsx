"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAppState } from "@/lib/appState";
import { useWallet, shortAddress } from "@/lib/wallet";
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
import { TradePoint, tradesFor, isTrade, fetchLaunchStats } from "@/lib/launchStats";
import { fetchLaunchCollateralPriceUsd } from "@/lib/launchpad";
import PriceLabel from "@/components/PriceLabel";
import { TxLink, AddressLink } from "@/components/ExplorerLink";
import { LycGlobal, LycPosition, LycTx, fetchLycGlobal, fetchLycPosition, fetchLycPnl, LycPnl } from "@/lib/lyc";
import { timeAgo } from "@/lib/utils";
import { useXAuth } from "@/lib/useXAuth";
import { loadXProfile } from "@/lib/xAuth";
import { FollowInfo, fetchFollowInfo, fetchFollowList, FollowListEntry, setFollow } from "@/lib/social";
import { useTopTraders, type TopTraderRow } from "@/lib/topTraders";
import { useXHandles, type HandleMap } from "@/lib/xHandles";
import { toastError, toastSuccess } from "@/lib/toast";

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

function CoinAvatar({ address, size = 40 }: { address: string; size?: number }) {
  const hc = hashOf(address);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        backgroundColor: `${PALETTE[hc % PALETTE.length]}22`,
        border: `1px solid ${PALETTE[hc % PALETTE.length]}55`,
      }}
    >
      {EMOJI[(hc >>> 3) % EMOJI.length]}
    </div>
  );
}

/// Floats formatted as "$1,234.56" without the bigint-WAD round trip -- PnL math here runs in plain
/// numbers off the trade log, and `usd()` cannot take a negative WAD cleanly.
function usdNum(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 10_000 ? 0 : 2;
  return `${n < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function compactNum(n: number): string {
  return usdCompact(BigInt(Math.round(Math.abs(n) * 1e18)));
}

// ── Position book ──────────────────────────────────────────────────────────────────────────────
// One pass over the trade log builds everything the page shows: per-coin positions (FIFO realized
// PnL), the all-time aggregates, the ranked Top-trades list, and the 1D/1W/1M window delta.

type PnlWindow = "1D" | "1W" | "1M";
const WINDOW_MS: Record<PnlWindow, number> = { "1D": 86_400_000, "1W": 7 * 86_400_000, "1M": 30 * 86_400_000 };

type CoinPosition = {
  launch: LaunchSummary;
  boughtUsd: number;
  soldUsd: number;
  trades: number;
  firstTs: number;
  lastTs: number;
  held: boolean;
  tokensNow: number;
  valueNow: number;
  unrealizedUsd: number;
  realizedUsd: number;
  profit: number;
  entryPriceUsd: number;
};

type PositionBook = {
  coins: CoinPosition[];
  closed: CoinPosition[];
  top: CoinPosition[];
  realizedUsd: number;
  unrealizedUsd: number;
  buyVolume: number;
  totalProfit: number;
  portfolioValue: number;
  firstActivityTs: number | null;
  windowPnl: (w: PnlWindow, nowMs?: number) => { usd: number; pct: number | null };
};

const TOKEN_EPS = 1e-9;

const EMPTY_BOOK: PositionBook = {
  coins: [],
  closed: [],
  top: [],
  realizedUsd: 0,
  unrealizedUsd: 0,
  buyVolume: 0,
  totalProfit: 0,
  portfolioValue: 0,
  firstActivityTs: null,
  windowPnl: () => ({ usd: 0, pct: null }),
};

function usePositions(launches: LaunchSummary[], holdings: HeldLaunch[] | null, userAddr: string | null): PositionBook | null {
  return useMemo<PositionBook | null>(() => {
    if (userAddr === null || holdings === null) return null;
    const heldBy = new Map(holdings.map((h) => [h.address.toLowerCase(), h]));

    const coins: CoinPosition[] = [];
    const tradesByUser = new Map<string, TradePoint[]>();
    let realizedUsd = 0;
    let unrealizedUsd = 0;
    let buyVolume = 0;
    let portfolioValue = 0;
    let firstActivityTs: number | null = null;
    const bumpFirst = (ts: number) => {
      if (ts > 0 && (firstActivityTs === null || ts < firstActivityTs)) firstActivityTs = ts;
    };

    for (const launch of launches) {
      const pts = tradesFor(launch.address)
        .filter((t) => isTrade(t) && t.trader === userAddr)
        .sort((a, b) => a.ts - b.ts);
      if (pts.length === 0) continue;
      tradesByUser.set(launch.address, pts);

      // FIFO over this user's own trades: sells consume the oldest buy lots at their average
      // price. For a fully-exited coin this equals sells minus buys; for a held one it is the
      // profit already banked on the way up.
      const lots: { tokens: number; price: number }[] = [];
      let boughtUsd = 0;
      let soldUsd = 0;
      let realized = 0;
      let firstTs = pts[0].ts;
      let lastTs = pts[0].ts;
      for (const t of pts) {
        firstTs = Math.min(firstTs, t.ts);
        lastTs = Math.max(lastTs, t.ts);
        if (t.isBuy) {
          boughtUsd += t.volumeUsd;
          buyVolume += t.volumeUsd;
          lots.push({ tokens: t.tokenAmount, price: t.tokenAmount > 0 ? t.volumeUsd / t.tokenAmount : 0 });
        } else {
          soldUsd += t.volumeUsd;
          const price = t.tokenAmount > 0 ? t.volumeUsd / t.tokenAmount : 0;
          let rem = t.tokenAmount;
          while (rem > TOKEN_EPS && lots.length > 0) {
            const lot = lots[0];
            const take = Math.min(rem, lot.tokens);
            realized += (price - lot.price) * take;
            lot.tokens -= take;
            rem -= take;
            if (lot.tokens <= TOKEN_EPS) lots.shift();
          }
          if (rem > TOKEN_EPS) realized += price * rem; // tokens that never passed through a logged buy
        }
      }

      const held = heldBy.get(launch.address.toLowerCase());
      const valueNow = held ? Number(held.valueUsd) / 1e18 : 0;
      // Cost basis of what is still held, straight from the FIFO lots. The ledger-DB aggregate
      // behind HeldLaunch.pnlUsd only knows trades this browser recorded, so on any address that
      // traded elsewhere it reads a zero basis and books the whole position value as profit.
      const remainingCost = lots.reduce((s, l) => s + l.tokens * l.price, 0);
      const unrealized = held ? valueNow - remainingCost : 0;
      const tokenAmountSum = pts.reduce((s, t) => s + (t.isBuy ? t.tokenAmount : 0), 0);
      const entry = tokenAmountSum > 0 ? boughtUsd / tokenAmountSum : 0;

      coins.push({
        launch,
        boughtUsd,
        soldUsd,
        trades: pts.length,
        firstTs,
        lastTs,
        held: !!held,
        tokensNow: held ? Number(held.tokenBalance) / 1e18 : 0,
        valueNow,
        unrealizedUsd: unrealized,
        realizedUsd: realized,
        profit: realized + unrealized,
        entryPriceUsd: entry,
      });
      realizedUsd += realized;
      unrealizedUsd += unrealized;
      portfolioValue += valueNow;
      bumpFirst(firstTs);
    }

    for (const h of holdings) bumpFirst(h.stats.createdAt ?? 0);

    const windowPnl = (w: PnlWindow, nowMs: number = Date.now()) => {
      const t0 = nowMs - WINDOW_MS[w];
      let pnl = 0;
      let base = 0;
      for (const c of coins) {
        const pts = tradesByUser.get(c.launch.address) ?? [];
        let bw = 0;
        let sw = 0;
        let btw = 0;
        let stw = 0;
        for (const t of pts) {
          if (t.ts < t0) continue;
          if (t.isBuy) {
            bw += t.volumeUsd;
            btw += t.tokenAmount;
          } else {
            sw += t.volumeUsd;
            stw += t.tokenAmount;
          }
        }
        if (!c.held && bw === 0 && sw === 0) continue;
        // Tokens held when the window opened: what is held now, minus everything acquired since.
        const h0 = Math.max(0, c.tokensNow + stw - btw);
        // Mark h0 at the coin's market price when the window opened -- the last trade at or
        // before t0, from the coin's full trade log, not just this user's.
        const allPts = tradesFor(c.launch.address);
        let p0 = 0;
        for (let i = allPts.length - 1; i >= 0; i--) {
          const t = allPts[i];
          if (isTrade(t) && t.ts <= t0) {
            p0 = t.priceUsd;
            break;
          }
        }
        const priceNow = Number(c.launch.priceUsd) / 1e18;
        const v0 = h0 * (p0 > 0 ? p0 : priceNow);
        // Wealth delta over the window: cash taken out minus cash put in, plus the change in the
        // value of whatever was held across it.
        pnl += sw - bw + (c.valueNow - v0);
        base += v0 + bw;
      }
      return { usd: pnl, pct: base > 1e-9 ? (pnl / base) * 100 : null };
    };

    const closed = coins.filter((c) => !c.held).sort((a, b) => b.lastTs - a.lastTs);
    const top = [...coins].sort((a, b) => b.profit - a.profit).slice(0, 5);
    return {
      coins,
      closed,
      top,
      realizedUsd,
      unrealizedUsd,
      buyVolume,
      totalProfit: realizedUsd + unrealizedUsd,
      portfolioValue,
      firstActivityTs,
      windowPnl,
    };
  }, [launches, holdings, userAddr]);
}

function useActivity(launches: LaunchSummary[], userAddr: string | null, limit = 50) {
  return useMemo(() => {
    if (userAddr === null) return null;
    const rows: { launch: LaunchSummary; ts: number; isBuy: boolean; volumeUsd: number; tokenAmount: number; tx: string }[] = [];
    for (const launch of launches) {
      for (const t of tradesFor(launch.address)) {
        if (!isTrade(t) || t.trader !== userAddr) continue;
        rows.push({ launch, ts: t.ts, isBuy: t.isBuy, volumeUsd: t.volumeUsd, tokenAmount: t.tokenAmount, tx: t.tx });
      }
    }
    return rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }, [launches, userAddr, limit]);
}

const TABS: { key: Tab; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "activity", label: "Activity" },
  { key: "lyc", label: "LYC" },
];

function FollowButton({
  target,
  viewerAddress,
  viewerFollows,
  onChanged,
}: {
  target: string;
  viewerAddress: string | null;
  viewerFollows: boolean;
  onChanged: () => void;
}) {
  const { setWalletModalOpen } = useAppState();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (!viewerAddress) {
      setWalletModalOpen(true);
      return;
    }
    setBusy(true);
    const next = viewerFollows ? "unfollow" : "follow";
    try {
      await setFollow(target, next);
      toastSuccess(next === "follow" ? "Followed" : "Unfollowed");
      onChanged();
    } catch (e) {
      toastError(e, "Could not update follow");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={
        viewerFollows
          ? "rounded-lg border border-border bg-surface px-4 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-red/40 hover:text-red disabled:opacity-50"
          : "rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
      }
    >
      {busy ? "…" : viewerFollows ? "Following" : "Follow"}
    </button>
  );
}

/// Left rail on the profile: every trader on the platform ranked by net PnL. This is the
/// discovery surface that makes wallet-to-wallet follows possible — a row click opens that
/// wallet's profile, and the + button follows inline without leaving the page.
function TopTradersPanel({
  rows,
  scanning,
  viewerAddress,
  viewerFollowing,
  handles,
  onFollowed,
}: {
  rows: TopTraderRow[];
  scanning: boolean;
  viewerAddress: string | null;
  viewerFollowing: Set<string>;
  handles: HandleMap;
  onFollowed: () => void;
}) {
  const router = useRouter();
  const { setWalletModalOpen } = useAppState();
  const [busy, setBusy] = useState<string | null>(null);
  const visible = rows.filter((r) => r.address !== viewerAddress);

  async function toggle(target: string) {
    if (!viewerAddress) {
      setWalletModalOpen(true);
      return;
    }
    const following = viewerFollowing.has(target);
    setBusy(target);
    try {
      await setFollow(target, following ? "unfollow" : "follow");
      toastSuccess(following ? "Unfollowed" : "Followed");
      onFollowed();
    } catch (e) {
      toastError(e, "Could not update follow");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Top PNL</h2>
        {scanning ? <span className="text-[10px] text-muted">scanning…</span> : null}
      </div>
      {visible.length === 0 ? (
        <p className="pt-3 text-xs text-muted">No traders yet — any buy or sell on a coin ranks the wallet here.</p>
      ) : (
        <div className="divide-y divide-border">
          {visible.map((r, i) => {
            const following = viewerFollowing.has(r.address);
            const name = handles.get(r.address);
            return (
              <div key={r.address} className="flex items-center gap-2 py-2">
                <button
                  onClick={() => router.push(`/profile/${r.address}`)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title="View profile"
                >
                  <span className="w-4 shrink-0 font-mono text-[10px] text-muted">{i + 1}</span>
                  <CoinAvatar address={r.address} size={26} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                    {name ?? shortAddress(r.address)}
                  </span>
                  <span className={`shrink-0 font-mono text-xs font-semibold ${r.profit >= 0 ? "text-green" : "text-red"}`}>
                    {r.profit >= 0 ? "+" : "-"}
                    {usdNum(Math.abs(r.profit))}
                  </span>
                </button>
                <button
                  onClick={() => toggle(r.address)}
                  disabled={busy === r.address}
                  className={
                    following
                      ? "shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-bold leading-none text-muted transition-colors hover:border-red/40 hover:text-red disabled:opacity-50"
                      : "shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold leading-none text-accent transition-colors hover:bg-accent/25 disabled:opacity-50"
                  }
                  title={following ? "Unfollow" : "Follow"}
                >
                  {busy === r.address ? "…" : following ? "✓" : "+"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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

  const [created, setCreated] = useState<CreatedRow[] | null>(null);
  const [holdings, setHoldings] = useState<HeldLaunch[] | null>(null);
  const [claimHistory, setClaimHistory] = useState<ClaimRecord[] | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("open");
  const [collateralPrice, setCollateralPrice] = useState<bigint>(0n);
  const [lycGlobal, setLycGlobal] = useState<LycGlobal | null>(null);
  const [lycPosition, setLycPosition] = useState<LycPosition | null>(null);
  const [lycPnl, setLycPnl] = useState<LycPnl | null>(null);
  const [pnlWindow, setPnlWindow] = useState<PnlWindow>("1D");
  const [followInfo, setFollowInfo] = useState<FollowInfo | null>(null);
  // Which follower/following list the modal is showing, if either is open.
  const [followModal, setFollowModal] = useState<"followers" | "following" | null>(null);
  const [createdFirstTs, setCreatedFirstTs] = useState<number | null>(null);

  const targetAddress = profileAddress;
  const userAddr = profileAddress?.toLowerCase() ?? null;

  // Cheap on-chain reads: what the header and portfolio card show. Polled.
  const refresh = useCallback(async () => {
    if (!addresses || !targetAddress) {
      setCreated(null);
      setHoldings(null);
      return;
    }
    try {
      const collateralPriceUsd = await fetchCollateralPriceUsd(addresses.oracle);
      setCollateralPrice(collateralPriceUsd);
      const [mine, held] = await Promise.all([
        fetchLaunchesByCreator(addresses, targetAddress),
        fetchHoldings(addresses, targetAddress),
      ]);
      const rows = await Promise.all(
        mine.map(async (launch) => ({
          launch,
          fees: await fetchCreatorFees(launch.address, targetAddress, collateralPriceUsd),
        }))
      );
      setCreated(rows);
      setHoldings(held);
    } catch {
      // anvil down / stale addresses
    }
  }, [addresses, targetAddress]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Heavy event scans (per-launch claim logs, the LYC Transfer log from block 0) -- these were
  // re-run on the 5s poll and buried the RPC. Claims only change when a claim lands, so they load
  // once per address and after each claim; the LYC ledger loads on demand and refreshes on a slow
  // interval only while its tab is open. The creator list is fetched here rather than read from
  // `created` so this callback stays keyed on address only -- a fresh `created` array identity on
  // every poll would otherwise re-trigger the scans.
  const loadLedger = useCallback(async () => {
    if (!addresses || !targetAddress) return;
    fetchLaunchesByCreator(addresses, targetAddress)
      .then((mine) => {
        fetchClaimHistory(mine, targetAddress)
          .then((history) => setClaimHistory(history))
          .catch(() => {});
        return mine;
      })
      .then(async (mine) => {
        // "Account created on" comes from each launch's first-trade timestamp, which only the
        // trade scan knows. Bounded to the launches this address created, once per address; the
        // scan is incremental, so coins already scanned cost nothing.
        let first: number | null = null;
        for (const l of mine) {
          try {
            const price = await fetchLaunchCollateralPriceUsd(l.address);
            const stats = await fetchLaunchStats(l.address, price, null);
            if (stats.createdAt) first = first === null ? stats.createdAt : Math.min(first, stats.createdAt);
          } catch {
            // one unscannable coin should not hide the rest of the dates
          }
        }
        setCreatedFirstTs(first);
      })
      .catch(() => {});
    try {
      const g = await fetchLycGlobal(addresses);
      setLycGlobal(g);
      const p = await fetchLycPosition(addresses, targetAddress);
      setLycPosition(p);
      const pnl = await fetchLycPnl(addresses, targetAddress, g.nav);
      setLycPnl(pnl);
    } catch {
      // LYC reads are best-effort; tiles fall back to zeros
    }
  }, [addresses, targetAddress]);

  useEffect(() => {
    setClaimHistory(null);
    setLycGlobal(null);
    setLycPosition(null);
    setLycPnl(null);
    setCreatedFirstTs(null);
  }, [targetAddress]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]); // created resolving/changes re-triggers, which is when claims can differ

  useEffect(() => {
    if (activeTab !== "lyc") return;
    loadLedger();
    const id = setInterval(loadLedger, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Follow counts. Identity is the address, so this works whether or not either side connected X.
  const reloadFollows = useCallback(() => {
    if (!profileAddress) return;
    fetchFollowInfo(profileAddress, wallet.address ?? null)
      .then(setFollowInfo)
      .catch(() => {});
  }, [profileAddress, wallet.address]);

  useEffect(() => {
    setFollowInfo(null);
    reloadFollows();
  }, [reloadFollows]);

  async function onClaim(launchAddress: string) {
    if (!isOwnProfile) return;
    setClaiming(launchAddress);
    try {
      await claimFees(launchAddress);
      await refresh();
      loadLedger();
    } catch {
      // a claim with nothing to claim reverts
    } finally {
      setClaiming(null);
    }
  }

  const book = usePositions(launches, holdings, userAddr);
  const activity = useActivity(launches, userAddr);

  // Left-rail discovery: every trader on the factory ranked by net PnL, plus the wallets the
  // viewer already follows so the inline +/✓ buttons render the right state. Re-fetched after
  // any sidebar follow toggles (followVersion), so the buttons never drift from the graph.
  const topTraders = useTopTraders(launches, addresses !== null);
  const handles = useXHandles();
  const [viewerFollowing, setViewerFollowing] = useState<Set<string>>(new Set());
  const [followVersion, setFollowVersion] = useState(0);
  useEffect(() => {
    if (!wallet.address) {
      setViewerFollowing(new Set());
      return;
    }
    let stopped = false;
    fetchFollowList(wallet.address, "following")
      .then((entries) => {
        if (!stopped) setViewerFollowing(new Set(entries.map((e) => e.address.toLowerCase())));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [wallet.address, followVersion]);

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
  const ethBalance = isOwnProfile && wallet.balances ? formatWad(wallet.balances.eth, 4) : null;
  const ethValueUsd = isOwnProfile && wallet.balances ? (wallet.balances.eth * collateralPrice) / 10n ** 18n : 0n;

  const safeBook = book ?? EMPTY_BOOK;
  const win = safeBook.windowPnl(pnlWindow);
  const topTrades = safeBook.top;

  const h = hashOf(profileAddress);
  const color = PALETTE[h % PALETTE.length];
  const emoji = EMOJI[(h >>> 3) % EMOJI.length];

  const lycValue = lycPosition && lycGlobal ? (lycPosition.balance * lycGlobal.nav) / WAD : 0n;
  const createdTsList = [safeBook.firstActivityTs, createdFirstTs].filter((t): t is number => t !== null);
  const createdDate = createdTsList.length
    ? new Date(Math.min(...createdTsList)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* ── Left rail: other traders, ranked by PnL ── */}
      <aside className="order-last self-start lg:order-first lg:sticky lg:top-4">
        <TopTradersPanel
          rows={topTraders.rows}
          scanning={topTraders.scanning}
          viewerAddress={wallet.address?.toLowerCase() ?? null}
          viewerFollowing={viewerFollowing}
          handles={handles}
          onFollowed={() => {
            setFollowVersion((v) => v + 1);
            reloadFollows();
          }}
        />
      </aside>

      <div className="min-w-0 space-y-4">
      {/* ── Identity header ── */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="h-24 bg-gradient-to-r from-green/15 via-accent/10 to-transparent" />
        <div className="px-5 pb-5">
          <div className="-mt-9 flex items-end justify-between gap-3">
            {displayXProfile ? (
              <img
                src={displayXProfile.profileImageUrl}
                alt={displayXProfile.name}
                className="h-[72px] w-[72px] shrink-0 rounded-2xl border-4 border-card object-cover"
              />
            ) : (
              <div
                className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-2xl border-4 border-card text-3xl"
                style={{ backgroundColor: `${color}22` }}
              >
                {emoji}
              </div>
            )}
            <div className="mb-1 flex shrink-0 items-center gap-2">
              {isOwnProfile && !displayXProfile ? (
                <button
                  onClick={xAuth.connect}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent/40"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  Connect X
                </button>
              ) : null}
              {!isOwnProfile ? (
                <FollowButton
                  target={profileAddress}
                  viewerAddress={wallet.isConnected ? wallet.address ?? null : null}
                  viewerFollows={followInfo?.viewerFollows ?? false}
                  onChanged={reloadFollows}
                />
              ) : null}
            </div>
          </div>

          <div className="mt-3">
            {displayXProfile ? (
              <>
                <h1 className="text-xl font-bold text-foreground">{displayXProfile.name}</h1>
                <a
                  href={`https://x.com/${displayXProfile.username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 inline-block text-sm text-accent hover:underline"
                >
                  @{displayXProfile.username}
                </a>
              </>
            ) : (
              <h1 className="font-mono text-xl font-bold text-foreground">{shortAddress(profileAddress)}</h1>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-secondary">
            <button
              onClick={() => setFollowModal("followers")}
              className="transition-colors hover:text-foreground"
              title="Show followers"
            >
              <span className="font-semibold text-foreground">{followInfo?.followers ?? "—"}</span>{" "}
              <span className="text-muted">Followers</span>
            </button>
            <button
              onClick={() => setFollowModal("following")}
              className="transition-colors hover:text-foreground"
              title="Show following"
            >
              <span className="font-semibold text-foreground">{followInfo?.following ?? "—"}</span>{" "}
              <span className="text-muted">Following</span>
            </button>
            <button
              onClick={() => navigator.clipboard.writeText(profileAddress).catch(() => {})}
              className="inline-flex items-center gap-1 font-mono text-xs text-muted transition-colors hover:text-foreground"
              title="Copy address"
            >
              {shortAddress(profileAddress)}
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
            <AddressLink address={profileAddress} label="Explorer" className="text-xs text-muted transition-colors hover:text-foreground" />
            {createdDate ? <span className="text-xs text-muted">Account created on {createdDate}</span> : null}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── PnL hero ── */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={`truncate font-mono text-4xl font-bold tracking-tight ${safeBook.totalProfit >= 0 ? "text-foreground" : "text-red"}`}>
                {usdNum(safeBook.totalProfit)}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-muted">Profit</div>
            </div>
            <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-surface p-1">
              {(Object.keys(WINDOW_MS) as PnlWindow[]).map((w) => (
                <button
                  key={w}
                  onClick={() => setPnlWindow(w)}
                  className={`rounded-md px-2.5 py-1 font-mono text-xs font-semibold transition-colors ${
                    pnlWindow === w ? "bg-accent text-accent-ink" : "text-muted hover:text-foreground"
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          <div className={`mt-3 font-mono text-sm font-semibold ${win.usd >= 0 ? "text-green" : "text-red"}`}>
            {win.usd >= 0 ? "+" : ""}
            {usdNum(win.usd)}
            {win.pct !== null ? ` (${win.pct >= 0 ? "+" : ""}${win.pct.toFixed(2)}%)` : ""}{" "}
            <span className="font-sans font-normal text-muted">{pnlWindow}</span>
          </div>

          <div className="mt-1 text-xs text-muted">
            Holdings ≈ <span className="font-mono text-foreground">{usd(holdingsValueUsd)}</span>
            {ethBalance ? (
              <>
                {" · "}
                <span className="font-mono text-foreground">{ethBalance}</span> ETH (≈ {usd(ethValueUsd)})
              </>
            ) : null}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-border">
            <StatTile label="Realized PnL" value={usdNum(safeBook.realizedUsd)} tone={safeBook.realizedUsd >= 0 ? "green" : "red"} />
            <StatTile label="Unrealized PnL" value={usdNum(safeBook.unrealizedUsd)} tone={safeBook.unrealizedUsd >= 0 ? "green" : "red"} />
            <StatTile label="Buy volume" value={usdNum(safeBook.buyVolume)} />
          </div>
        </div>

        {/* ── Top trades ── */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Top trades</h2>
          {topTrades === null ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : topTrades.length === 0 ? (
            <div className="mt-3 flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-6 py-8 text-center">
              <p className="text-sm font-medium text-secondary">No trades yet</p>
              <p className="text-xs text-muted">The most profitable positions will rank up here.</p>
            </div>
          ) : (
            <div className="mt-1 divide-y divide-border">
              {topTrades.map((c, i) => (
                <button
                  key={c.launch.address}
                  onClick={() => router.push(`/coin/${c.launch.address}`)}
                  className="flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-hover/40"
                >
                  <span className="w-6 shrink-0 font-mono text-xs text-muted">#{i + 1}</span>
                  <CoinAvatar address={c.launch.address} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">
                      ${c.launch.symbol} <span className="text-xs font-normal text-muted">{c.launch.name}</span>
                    </div>
                    <div className="truncate font-mono text-xs text-muted">
                      Spent {compactNum(c.boughtUsd)} · Avg entry {compactNum(c.entryPriceUsd * 1e9)} MC / Now{" "}
                      {usdCompact(c.launch.marketCapUsd)} MC
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[10px] uppercase tracking-wider text-muted">Position</div>
                    <div className={`text-xs font-semibold ${c.held ? "text-green" : "text-muted"}`}>{c.held ? "Open" : "Closed"}</div>
                  </div>
                  <div className="w-24 shrink-0 text-right">
                    <div className="text-[10px] uppercase tracking-wider text-muted">Profit</div>
                    <div className={`truncate font-mono text-sm font-semibold ${c.profit >= 0 ? "text-green" : "text-red"}`}>
                      {c.profit >= 0 ? "+" : "-"}
                      {compactNum(c.profit)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex gap-5 overflow-x-auto border-b border-border px-4">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`-mb-px shrink-0 border-b-2 py-3 text-sm font-semibold capitalize transition-colors ${
                activeTab === tab.key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-4">
          {activeTab === "open" && <OpenPositions rows={book?.coins.filter((c) => c.held) ?? null} onOpen={(a) => router.push(`/coin/${a}`)} />}
          {activeTab === "closed" && <ClosedPositions rows={book?.closed ?? null} onOpen={(a) => router.push(`/coin/${a}`)} />}
          {activeTab === "activity" && <ActivityList rows={activity} />}
          {activeTab === "lyc" && <LycPanel global={lycGlobal} position={lycPosition} pnl={lycPnl} />}
        </div>
      </div>

      {/* ── Created coins + fee claims ── */}
      {created !== null && created.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              Coins launched <span className="font-normal text-muted">({created.length})</span>
            </h2>
            <div className="text-right">
              <span className="text-[10px] uppercase tracking-wider text-muted">Lifetime fees </span>
              <span className="font-mono text-sm font-semibold text-foreground">{usd(lifetimeFeesUsd)}</span>
            </div>
          </div>

          <div className="mt-3 divide-y divide-border">
            {created.map(({ launch, fees }) => (
              <div key={launch.address} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <button onClick={() => router.push(`/coin/${launch.address}`)} className="flex min-w-0 items-center gap-3 text-left">
                  <CoinAvatar address={launch.address} size={36} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold text-foreground">${launch.symbol}</span>
                      {launch.graduated ? (
                        <span className="rounded-full bg-green/15 px-1.5 py-0.5 text-[10px] font-semibold text-green">LIVE</span>
                      ) : (
                        <span className="font-mono text-[10px] text-muted">{launch.pctToGraduation.toFixed(1)}% to grad</span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-muted">
                      <PriceLabel value={launch.priceUsd} /> · MC {usdCompact(launch.marketCapUsd)}
                    </div>
                  </div>
                </button>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider text-muted">Fees earned</div>
                    <div className="font-mono text-sm font-semibold text-foreground">{usd(fees.lifetimeUsd)}</div>
                  </div>
                  {isOwnProfile &&
                    (fees.inHfyc ? (
                      <span className="text-xs text-muted" title="Creator fees are accruing in LYC — minted at harvest, withdraw anytime">
                        Paid in LYC
                      </span>
                    ) : (
                      <button
                        onClick={() => onClaim(launch.address)}
                        disabled={fees.claimableCollateral === 0n || claiming === launch.address}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40"
                      >
                        {claiming === launch.address ? "Claiming…" : `Claim ${usd(fees.claimableUsd)}`}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>

          {claimHistory !== null && claimHistory.length > 0 ? (
            <div className="mt-4 border-t border-border pt-4">
              <div className="text-[10px] uppercase tracking-wider text-muted">Fee claims</div>
              <div className="mt-2 space-y-1.5">
                {claimHistory.map((c, i) => {
                  const launch = created.find((r) => r.launch.address.toLowerCase() === c.token.toLowerCase());
                  return (
                    <div key={`${c.tx}-${i}`} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted">
                        {launch ? `$${launch.launch.symbol}` : shortAddress(c.token)} · <span className="font-mono text-foreground">{usd(c.amountUsd)}</span>
                      </span>
                      <span className="flex items-center gap-2 text-muted">
                        {timeAgo(c.timestamp)} ago <TxLink hash={c.tx} className="font-mono text-xs text-accent hover:underline" />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Follower / following list modal ── */}
      {followModal ? (
        <FollowListModal profileAddress={profileAddress} kind={followModal} onClose={() => setFollowModal(null)} />
      ) : null}
      </div>
    </div>
  );
}

/// The wallets behind the Followers / Following counts, X-enriched where the wallet has connected
/// Twitter. Rows navigate to that wallet's profile -- which is exactly the view-only access any
/// visitor already has, just one click deeper.
function FollowListModal({
  profileAddress,
  kind,
  onClose,
}: {
  profileAddress: string;
  kind: "followers" | "following";
  onClose: () => void;
}) {
  const router = useRouter();
  const [entries, setEntries] = useState<FollowListEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchFollowList(profileAddress, kind)
      .then((e) => {
        if (live) setEntries(e);
      })
      .catch(() => {
        if (live) setEntries([]);
      });
    return () => {
      live = false;
    };
  }, [profileAddress, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold capitalize text-foreground">{kind}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted transition-colors hover:text-foreground" title="Close">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {entries === null ? (
            <RowsSkeleton rows={4} />
          ) : entries.length === 0 ? (
            <PanelEmpty
              title={kind === "followers" ? "No followers yet" : "Not following anyone yet"}
              hint={kind === "followers" ? "Wallets that follow this profile will show up here." : "Wallets this profile follows will show up here."}
            />
          ) : (
            <div className="divide-y divide-border">
              {entries.map((e) => (
                <button
                  key={e.address}
                  onClick={() => {
                    onClose();
                    router.push(`/profile/${e.address}`);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover/40"
                >
                  {e.xImageUrl ? (
                    <img src={e.xImageUrl} alt={e.xName || e.address} className="h-9 w-9 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <CoinAvatar address={e.address} size={36} />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">{e.xName || shortAddress(e.address)}</div>
                    {e.xUsername ? (
                      <div className="truncate text-xs text-accent">@{e.xUsername}</div>
                    ) : (
                      <div className="font-mono text-xs text-muted">{shortAddress(e.address)}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "green" | "red" }) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-sm font-semibold ${tone === "green" ? "text-green" : tone === "red" ? "text-red" : "text-foreground"}`}>
        {value}
      </div>
      {sub ? <div className="text-[10px] text-muted">{sub}</div> : null}
    </div>
  );
}

function PanelEmpty({ title, hint, cta }: { title: string; hint?: string; cta?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium text-secondary">{title}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {cta}
    </div>
  );
}

function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function OpenPositions({ rows, onOpen }: { rows: CoinPosition[] | null; onOpen: (a: string) => void }) {
  if (rows === null) return <RowsSkeleton />;
  if (rows.length === 0) return <PanelEmpty title="No open positions" hint="Coins this address holds will show up here." />;
  return (
    <div className="space-y-2">
      {rows.map((c) => (
        <button
          key={c.launch.address}
          onClick={() => onOpen(c.launch.address)}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3 text-left transition-colors hover:border-accent/40 hover:bg-hover"
        >
          <div className="flex min-w-0 items-center gap-3">
            <CoinAvatar address={c.launch.address} />
            <div className="min-w-0">
              <div className="truncate font-semibold text-foreground">${c.launch.symbol}</div>
              <div className="truncate text-xs text-muted">{c.launch.name}</div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-sm text-foreground">{usdNum(c.valueNow)}</div>
            <div className={`font-mono text-xs ${c.unrealizedUsd >= 0 ? "text-green" : "text-red"}`}>
              {c.unrealizedUsd >= 0 ? "+" : ""}
              {usdNum(c.unrealizedUsd)}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function ClosedPositions({ rows, onOpen }: { rows: CoinPosition[] | null; onOpen: (a: string) => void }) {
  if (rows === null) return <RowsSkeleton />;
  if (rows.length === 0) return <PanelEmpty title="No closed positions" hint="Coins this address bought and fully sold will show up here." />;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <button
          key={r.launch.address}
          onClick={() => onOpen(r.launch.address)}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3 text-left transition-colors hover:border-accent/40 hover:bg-hover"
        >
          <div className="flex min-w-0 items-center gap-3">
            <CoinAvatar address={r.launch.address} />
            <div className="min-w-0">
              <div className="truncate font-semibold text-foreground">${r.launch.symbol}</div>
              <div className="text-xs text-muted">
                {r.trades} trades · last {timeAgo(r.lastTs)} ago
              </div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`font-mono text-sm font-semibold ${r.realizedUsd >= 0 ? "text-green" : "text-red"}`}>
              {r.realizedUsd >= 0 ? "+" : ""}
              {usdNum(r.realizedUsd)}
            </div>
            <div className="font-mono text-xs text-muted">bought {compactNum(r.boughtUsd)}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function ActivityList({ rows }: { rows: ReturnType<typeof useActivity> }) {
  if (rows === null) return <RowsSkeleton />;
  if (rows.length === 0) return <PanelEmpty title="No trades yet" hint="Buys and sells across every coin will show up here." />;
  return (
    <div className="divide-y divide-border">
      {rows.map((r, i) => (
        <div key={`${r.tx}-${i}`} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
          <div className="flex min-w-0 items-center gap-3">
            <CoinAvatar address={r.launch.address} size={32} />
            <div className="min-w-0">
              <span className="truncate text-sm font-semibold text-foreground">${r.launch.symbol}</span>
              <span
                className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  r.isBuy ? "bg-green/15 text-green" : "bg-red/15 text-red"
                }`}
              >
                {r.isBuy ? "Buy" : "Sell"}
              </span>
              <div className="text-xs text-muted">{timeAgo(r.ts)} ago</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-right">
            <div>
              <div className="font-mono text-sm text-foreground">{usd(BigInt(Math.round(r.volumeUsd * 1e18)))}</div>
              <div className="font-mono text-xs text-muted">{r.tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} {r.launch.symbol}</div>
            </div>
            <TxLink hash={r.tx} />
          </div>
        </div>
      ))}
    </div>
  );
}

function LycPanel({ global: g, position, pnl }: { global: LycGlobal | null; position: LycPosition | null; pnl: LycPnl | null }) {
  if (!g || !position) return <RowsSkeleton rows={2} />;
  if (position.balance === 0n && (pnl === null || pnl.history.length === 0)) {
    return (
      <PanelEmpty
        title="No LYC activity yet"
        hint="Mint LYC on the Earn page to start earning funding from every leveraged pool."
      />
    );
  }
  const value = (position.balance * g.nav) / WAD;
  const history = [...(pnl?.history ?? [])].sort((a, b) => b.timestamp - a.timestamp);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border sm:grid-cols-4">
        <StatTile label="LYC balance" value={formatWad(position.balance, 4)} sub={`≈ ${usd(value)}`} />
        <StatTile label="Unlocked" value={formatWad(position.unlocked, 4)} />
        <StatTile label="Realized PnL" value={usd(pnl?.realizedPnl ?? 0n)} tone={(pnl?.realizedPnl ?? 0n) >= 0n ? "green" : "red"} />
        <StatTile label="Unrealized PnL" value={usd(pnl?.unrealizedPnl ?? 0n)} tone={(pnl?.unrealizedPnl ?? 0n) >= 0n ? "green" : "red"} />
      </div>

      {history.length === 0 ? (
        <PanelEmpty title="No LYC transactions" hint="Mints and redeems of LYC will show up here." />
      ) : (
        <div className="divide-y divide-border">
          {history.map((t: LycTx, i) => {
            const isFeeMint = t.type === "mint" && t.source === "fees";
            return (
            <div key={`${t.txHash}-${i}`} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <span
                  title={
                    t.type === "mint"
                      ? isFeeMint
                        ? "Creator/protocol fees paid in LYC by a pool harvest"
                        : "Deposit minted on the Earn page"
                      : "Redeemed LYC"
                  }
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    t.type === "mint"
                      ? isFeeMint
                        ? "bg-yellow/15 text-yellow"
                        : "bg-green/15 text-green"
                      : "bg-red/15 text-red"
                  }`}
                >
                  {t.type === "mint" ? (isFeeMint ? "fee mint" : "mint") : "redeem"}
                </span>
                <span className="ml-2 text-sm font-semibold text-foreground">{formatWad(t.shares, 4)} LYC</span>
                <div className="text-xs text-muted">{t.timestamp > 0 ? `${timeAgo(t.timestamp)} ago` : "—"}</div>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right">
                <div className="font-mono text-sm text-foreground">≈ {usd((t.shares * t.navAtTime) / WAD)}</div>
                <TxLink hash={t.txHash} />
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
