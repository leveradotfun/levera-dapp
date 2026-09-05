"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ethers } from "ethers";
import { useAppState } from "@/lib/appState";
import { useWallet } from "@/lib/wallet";
import {
  LycGlobal,
  LycPosition,
  RedeemTarget,
  fetchLycGlobal,
  fetchLycPosition,
  mintWithCollateral,
  mintWithEth,
  mintWithUsdg,
  parseEthInput,
  quoteMint,
  quoteRedeem,
  redeemLycTo,
} from "@/lib/lyc";
import { WAD, fetchCollateralPriceUsd, formatWad, usd } from "@/lib/launchpad";
import { parseQuote } from "@/lib/quoteAssets";
import { toastError, toastSuccess } from "@/lib/toast";
import { TX_TIMEOUT_LONG_MS, withTimeout } from "@/lib/txTimeout";
import ConnectWalletButton from "@/components/ConnectWalletButton";
import { spendableEth } from "@/lib/wallet";
import { formatApr, useLycMetrics, NavSample } from "@/lib/lycMetrics";
import { TARGETING_TESTNET, ROBINHOOD_TESTNET_ID, ROBINHOOD_MAINNET_ID, explorerAddressUrl } from "@/lib/chains";
import SwapCard from "@/components/SwapCard";
import MobileSwapSheet from "@/components/MobileSwapSheet";
import { useIsDesktop } from "@/lib/useMediaQuery";
import ShimmerText from "@/components/ShimmerText";

type Tab = "position" | "transactions";

export default function EarnPage() {
  const { addresses } = useAppState();
  const wallet = useWallet(addresses);
  const [g, setG] = useState<LycGlobal | null>(null);
  const [pos, setPos] = useState<LycPosition | null>(null);
  const [depositAmt, setDepositAmt] = useState("");
  // ETH = native gas, spent via the payable mintWithEth (wrapped to WETH inside the same tx).
  // WETH = the ERC-20 already in your wallet, spent via mintWithCollateral(weth, ...) instead --
  // a different balance, a different allowance, a different call. CBBTC = the second listed
  // collateral, when the deployment has it; the option simply does not render otherwise.
  const [payWith, setPayWith] = useState<"ETH" | "WETH" | "USDG" | "CBBTC">("ETH");
  const [cbbtcPriceWad, setCbbtcPriceWad] = useState(0n);
  // What a redeem pays out as. USDG is the pool's native payout (see redeemLycTo); every other
  // option is that same USDG swapped to the target in the same click.
  const [redeemAs, setRedeemAs] = useState<RedeemTarget>("USDG");
  const [redeemAmt, setRedeemAmt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [ethPriceWad, setEthPriceWad] = useState(0n);
  const [tab, setTab] = useState<Tab>("position");
  const [swapMode, setSwapMode] = useState<"buy" | "sell">("buy");
  const [chartPeriod, setChartPeriod] = useState<"5m" | "1h" | "4h" | "1d" | "all">("all");
  const { apy, samples } = useLycMetrics(addresses);
  const isDesktop = useIsDesktop();

  const refresh = useCallback(async () => {
    if (!addresses) return;
    try {
      const [gg, pp, px, btcPx] = await Promise.all([
        fetchLycGlobal(addresses),
        wallet.address ? fetchLycPosition(addresses, wallet.address) : Promise.resolve(null),
        fetchCollateralPriceUsd(addresses.oracle),
        addresses.cbbtcOracle ? fetchCollateralPriceUsd(addresses.cbbtcOracle) : Promise.resolve(0n),
      ]);
      setG(gg);
      setPos(pp);
      setEthPriceWad(px);
      setCbbtcPriceWad(btcPx);
    } catch (e) {
      console.warn("Earn refresh failed:", e);
    }
  }, [addresses, wallet.address]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => { if (!cancelled) await refresh(); };
    void tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [refresh]);

  async function run(label: string, fn: () => Promise<unknown>, ok: string, okDetail?: string) {
    if (!addresses) return;
    setBusy(label);
    try {
      await withTimeout(fn(), TX_TIMEOUT_LONG_MS, label);
      toastSuccess(ok, okDetail);
      await refresh();
    } catch (e) {
      toastError(e, `${label} failed.`);
    } finally {
      setBusy(null);
    }
  }

  const navSamples = useMemo(() => {
    const periodMs = { "5m": 5 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "1d": 24 * 60 * 60_000, "all": Infinity }[chartPeriod];
    if (periodMs === Infinity) return samples;
    const cutoff = Date.now() - periodMs;
    return samples.filter((s) => s.t >= cutoff);
  }, [samples, chartPeriod]);

  const marketCap = g ? (Number(g.supply) / 1e18) * (Number(g.nav) / 1e18) : 0;
  const navReturn = g ? ((Number(g.nav) / 1e18) - 1) * 100 : 0;

  if (!addresses) {
    return <div className="p-10 text-center text-sm text-muted"><ShimmerText>Connecting to network...</ShimmerText></div>;
  }

  // cbBTC is 8 decimals; the amount is parsed in the pay asset's own units.
  const depositWei = payWith === "CBBTC" ? parseQuote(depositAmt, 8) : parseEthInput(depositAmt);
  const redeemWei = parseEthInput(redeemAmt);
  // cbBTC's raw amount is 8-decimal, so it needs the same 1e10 lift to WAD every other cbBTC USD
  // conversion in this app applies (see lib/launchpad.ts's quoteScale) before the oracle price
  // multiplies it -- skipping it made the mint quote ~1e10x too small, rounding "You Receive" to 0.
  const CBBTC_DECIMAL_LIFT = 10n ** 10n;
  const depositUsd =
    payWith === "ETH" || payWith === "WETH"
      ? (depositWei * ethPriceWad) / WAD
      : payWith === "CBBTC"
        ? (depositWei * CBBTC_DECIMAL_LIFT * cbbtcPriceWad) / WAD
        : depositWei;
  const paySymbol = payWith === "CBBTC" ? "cbBTC" : payWith;
  const payBalance =
    wallet.balances === null
      ? 0n
      : payWith === "ETH"
        ? spendableEth(wallet.balances.eth)
        : payWith === "WETH"
          ? wallet.balances.weth
          : payWith === "CBBTC"
            ? wallet.balances.cbbtc
            : wallet.balances.usdg;
  const mintQuote = g ? quoteMint(g, depositUsd) : 0n;
  const redeemQuote = g ? quoteRedeem(g, redeemWei) : { usdOut: 0n, covered: true };
  // Preview only -- redeemLycTo prices the actual swap on-chain at fill time. USDG is 1:1 with the
  // pool's own USD accounting, so no conversion needed there; every other target is estimated the
  // same way depositUsd converts the other direction: divide the USD amount by the asset's price
  // (lifting cbBTC's 8-decimal result back down out of WAD terms).
  const redeemTokenEstimate =
    redeemQuote.usdOut <= 0n
      ? null
      : redeemAs === "USDG"
        ? redeemQuote.usdOut
        : redeemAs === "CBBTC"
          ? cbbtcPriceWad > 0n
            ? (redeemQuote.usdOut * WAD) / cbbtcPriceWad / CBBTC_DECIMAL_LIFT
            : null
          : ethPriceWad > 0n
            ? (redeemQuote.usdOut * WAD) / ethPriceWad
            : null;

  const activeValue = swapMode === "buy" ? depositAmt : redeemAmt;
  const setActiveValue = swapMode === "buy" ? setDepositAmt : setRedeemAmt;

  const earnInputUsdLabel = (() => {
    try {
      if (swapMode === "buy") {
        if (!depositAmt || Number(depositAmt) <= 0) return undefined;
        return usd(depositUsd);
      } else {
        if (!redeemAmt || Number(redeemAmt) <= 0) return undefined;
        if (!g) return undefined;
        return usd((redeemWei * g.nav) / WAD);
      }
    } catch {
      return undefined;
    }
  })();

  const earnOutputUsdLabel = (() => {
    try {
      if (!g) return undefined;
      if (swapMode === "buy") {
        if (mintQuote <= 0n) return undefined;
        return usd((mintQuote * g.nav) / WAD);
      } else {
        if (redeemQuote.usdOut <= 0n) return undefined;
        return usd(redeemQuote.usdOut);
      }
    } catch {
      return undefined;
    }
  })();

  // Same single-instance rule as the coin page: the card owns the amount inputs, so it is
  // defined once and placed either in the desktop column or the mobile bottom sheet.
  const swapContent = (
    <>
          <SwapCard
            mode={swapMode}
            onModeChange={(m) => { setSwapMode(m); setDepositAmt(""); setRedeemAmt(""); }}
            buyLabel="Buy vLYC" sellLabel="Sell vLYC"
            inputToken={{ symbol: swapMode === "buy" ? paySymbol : "vLYC", balance: swapMode === "buy" ? payBalance : (pos?.balance ?? 0n), decimals: swapMode === "buy" && payWith === "CBBTC" ? 8 : 18 }}
            outputToken={{ symbol: swapMode === "buy" ? "vLYC" : redeemAs === "CBBTC" ? "cbBTC" : redeemAs, balance: 0n }}
            inputTokenOptions={
              swapMode === "buy"
                ? [
                    { key: "ETH", symbol: "ETH" },
                    { key: "WETH", symbol: "WETH" },
                    ...(addresses.cbbtc ? [{ key: "CBBTC", symbol: "cbBTC" }] : []),
                    { key: "USDG", symbol: "USDG" },
                  ]
                : undefined
            }
            onInputTokenChange={swapMode === "buy" ? (v) => { setPayWith(v as typeof payWith); setDepositAmt(""); } : undefined}
            outputTokenOptions={
              swapMode === "sell"
                ? [
                    { key: "USDG", symbol: "USDG" },
                    { key: "ETH", symbol: "ETH" },
                    { key: "WETH", symbol: "WETH" },
                    ...(addresses.cbbtc ? [{ key: "CBBTC", symbol: "cbBTC" }] : []),
                  ]
                : undefined
            }
            onOutputTokenChange={swapMode === "sell" ? (v) => setRedeemAs(v as RedeemTarget) : undefined}
            value={activeValue} onValueChange={setActiveValue}
            quoteLabel={
              swapMode === "buy"
                ? formatWad(mintQuote, 4)
                : redeemTokenEstimate !== null
                  ? redeemAs === "CBBTC"
                    ? ethers.formatUnits(redeemTokenEstimate, 8)
                    : formatWad(redeemTokenEstimate, 4)
                  : "—"
            }
            inputUsdLabel={earnInputUsdLabel}
            outputUsdLabel={earnOutputUsdLabel}
            busy={busy !== null} isConnected={wallet.isConnected} connectLabel="Connect wallet to trade"
            buyButtonLabel={busy === "Mint" ? "Minting..." : `Mint with ${paySymbol}`}
            sellButtonLabel={busy === "Redeem" ? "Redeeming..." : `Sell for ${redeemAs === "CBBTC" ? "cbBTC" : redeemAs}`}
            onMax={() => { if (swapMode === "buy") { setDepositAmt(payWith === "CBBTC" ? ethers.formatUnits(payBalance, 8) : formatWad(payBalance, 4)); } else { setRedeemAmt(pos ? formatWad(pos.balance, 6) : "0"); } }}
            warning={!redeemQuote.covered && redeemWei > 0n ? <div className="rounded-lg bg-amber-400/10 border border-amber-400/20 px-3 py-2 text-xs text-amber-400">Book is impaired — you receive pro-rata of assets, not $1.</div> : undefined}
            onBuy={() =>
              run(
                "Mint",
                () =>
                  payWith === "ETH"
                    ? mintWithEth(addresses, depositWei)
                    : payWith === "WETH"
                      ? mintWithCollateral(addresses, addresses.weth, depositWei, ethPriceWad)
                      : payWith === "CBBTC"
                        ? mintWithCollateral(addresses, addresses.cbbtc!, depositWei, cbbtcPriceWad, 8)
                        : mintWithUsdg(addresses, depositWei),
                "Minted vLYC",
                `${depositAmt} ${paySymbol} → ${formatWad(mintQuote, 4)} vLYC`,
              )
            }
            onSell={() =>
              run(
                "Redeem",
                () => redeemLycTo(addresses, redeemWei, redeemAs),
                "Redeemed vLYC",
                `${redeemAmt} vLYC → ${
                  redeemTokenEstimate !== null
                    ? redeemAs === "CBBTC"
                      ? ethers.formatUnits(redeemTokenEstimate, 8)
                      : formatWad(redeemTokenEstimate, 4)
                    : "…"
                } ${redeemAs === "CBBTC" ? "cbBTC" : redeemAs}`,
              )
            }
          />
    </>
  );

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* ── Left: chart + tabs ── */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Stats bar */}
        <div className="flex items-stretch gap-0 overflow-hidden rounded-xl border border-border bg-card">
          <StatBlock label="vLYC Price" value={`$${formatWad(g?.nav ?? 0n, 4)}`}
            badge={navReturn !== 0 ? `${navReturn >= 0 ? "+" : ""}${navReturn.toFixed(2)}%` : "+0.00%"}
            badgeColor={navReturn >= 0 ? "text-green-400 bg-green-400/10" : "text-red-400 bg-red-400/10"} accent />
          <div className="w-px bg-border" />
          <StatBlock
            label="vLYC APY"
            value={
              apy.h24.ready && apy.h24.simpleApr !== null
                ? formatApr(apy.h24.simpleApr)
                : apy.all.ready && apy.all.simpleApr !== null
                  ? `~${formatApr(apy.all.simpleApr)}`
                  : "—"
            }
            badge={!apy.h24.ready && apy.all.ready ? "since launch" : undefined}
            accent
          />
          <div className="w-px bg-border" />
          <StatBlock
            label="Market Cap"
            value={marketCap >= 1e9 ? `$${(marketCap / 1e9).toFixed(2)}B` : marketCap >= 1e6 ? `$${(marketCap / 1e6).toFixed(2)}M` : `$${marketCap.toFixed(2)}`}
            foot={addresses?.lyc ? (
              <a
                href={explorerAddressUrl(TARGETING_TESTNET ? ROBINHOOD_TESTNET_ID : ROBINHOOD_MAINNET_ID, addresses.lyc)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-foreground transition-colors"
                title="The contract holding every asset backing vLYC — idle cash plus collateral in the pools."
              >
                {addresses.lyc.slice(0, 6)}…{addresses.lyc.slice(-4)} ↗
              </a>
            ) : undefined}
          />
          <div className="w-px bg-border" />
          {/* The lend side of the book: vLYC cash currently rented out to xTOKEN pools. Settled
              occupancy only -- pending rent is accrued but not yet on-chain, so it shows the
              utilization badge against the whole book rather than a second number. */}
          <StatBlock
            label="Borrowed"
            value={usd(g?.occupancyUsd ?? 0n)}
            badge={g ? `${(Number(g.utilization) / 1e16).toFixed(0)}% of book` : undefined}
          />
        </div>

        {/* Chart period selector */}
        <div className="flex items-center gap-1">
          {(["5m", "1h", "4h", "1d", "all"] as const).map((p) => (
            <button key={p} onClick={() => setChartPeriod(p)}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${chartPeriod === p ? "bg-surface text-foreground" : "text-muted hover:text-foreground"}`}>
              {p === "all" ? "All" : p}
            </button>
          ))}
        </div>

        {/* Chart */}
        <div className="rounded-xl border border-border bg-card p-4 h-80">
          {navSamples.length >= 2 ? <NavChart samples={navSamples} /> : (
            <div className="flex h-full items-center justify-center text-sm text-muted">Chart fills in as NAV samples are recorded (~5 min intervals)</div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-4 border-b border-border">
          {(["position", "transactions"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`pb-3 text-sm font-semibold capitalize transition-colors border-b-2 ${tab === t ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}>
              {t === "position" ? "Your Position" : "Transactions"}
            </button>
          ))}
        </div>
        {tab === "position" ? <PositionPanel pos={pos} g={g} wallet={wallet} /> : <TransactionsPanel />}
      </div>

      {/* ── Right: swap card — inline column on desktop, bottom sheet on phones ── */}
      {isDesktop ? (
        <div className="w-[380px] shrink-0">
          <div className="sticky top-4 space-y-3">
            {swapContent}
          </div>
        </div>
      ) : (
        <MobileSwapSheet
          triggerLabel={swapMode === "buy" ? "Buy vLYC" : "Sell vLYC"}
          title="Mint or redeem vLYC"
        >
          {swapContent}
        </MobileSwapSheet>
      )}
    </div>
  );
}

function StatBlock({ label, value, badge, badgeColor, accent, foot }: { label: string; value: string; badge?: string; badgeColor?: string; accent?: boolean; foot?: ReactNode }) {
  return (
    <div className="flex-1 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">{label}</span>
        {badge ? <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${badgeColor ?? "text-muted bg-surface"}`}>{badge}</span> : null}
      </div>
      <div className={`mt-1 font-mono text-base sm:text-lg ${accent ? "text-accent" : "text-foreground"}`}>{value}</div>
      {foot ? <div className="mt-0.5 text-[10px]">{foot}</div> : null}
    </div>
  );
}

function NavChart({ samples }: { samples: NavSample[] }) {
  const W = 800, H = 280;
  const PAD = { top: 20, right: 60, bottom: 30, left: 10 };
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const navs = samples.map((s) => s.nav);
  const min = Math.min(...navs), max = Math.max(...navs), range = max - min || 0.001;
  const points = samples.map((s, i) => ({
    x: PAD.left + (i / Math.max(samples.length - 1, 1)) * (W - PAD.left - PAD.right),
    y: PAD.top + (1 - (s.nav - min) / range) * (H - PAD.top - PAD.bottom),
    nav: s.nav, t: s.t,
  }));
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaD = `${pathD} L ${points[points.length - 1].x} ${H - PAD.bottom} L ${points[0].x} ${H - PAD.bottom} Z`;
  const ticks = [0, 1, 2, 3].map((i) => ({ val: min + (range * i) / 3, y: PAD.top + (1 - i / 3) * (H - PAD.top - PAD.bottom) }));
  const xLabels = (() => {
    if (samples.length < 2) return [];
    return Array.from({ length: Math.min(samples.length, 5) }, (_, i) => {
      const idx = Math.floor((i / 4) * (samples.length - 1));
      const d = new Date(samples[idx].t);
      return { label: `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`, x: points[idx].x };
    });
  })();
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * W;
    let closest = 0, minDist = Infinity;
    points.forEach((p, i) => { const d = Math.abs(p.x - mouseX); if (d < minDist) { minDist = d; closest = i; } });
    setHoverIdx(closest);
  };
  const hovered = hoverIdx !== null ? points[hoverIdx] : null;
  const hoveredSample = hoverIdx !== null ? samples[hoverIdx] : null;
  return (
    <div className="relative w-full h-full">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none" onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>
        {ticks.map((t, i) => (<g key={i}><line x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y} stroke="currentColor" className="text-border" strokeWidth={1} strokeDasharray="4 4" /><text x={W - PAD.right + 8} y={t.y + 4} className="fill-muted" fontSize={10}>${t.val.toFixed(4)}</text></g>))}
        {xLabels.map((l, i) => (<text key={i} x={l.x} y={H - 8} textAnchor="middle" className="fill-muted" fontSize={10}>{l.label}</text>))}
        <path d={areaD} fill="url(#navGradient)" />
        <path d={pathD} fill="none" stroke="#ECE3D1" strokeWidth={2} />
        {hovered ? (<><line x1={hovered.x} y1={PAD.top} x2={hovered.x} y2={H - PAD.bottom} stroke="#ECE3D1" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} /><circle cx={hovered.x} cy={hovered.y} r={5} fill="#ECE3D1" stroke="#0a0a0a" strokeWidth={2} /></>) : points.length > 0 ? <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r={4} fill="#ECE3D1" stroke="#0a0a0a" strokeWidth={1} /> : null}
        <defs><linearGradient id="navGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ECE3D1" stopOpacity={0.3} /><stop offset="100%" stopColor="#ECE3D1" stopOpacity={0} /></linearGradient></defs>
      </svg>
      {hovered && hoveredSample ? (
        <div className="absolute pointer-events-none bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-xs z-10"
          style={{ left: `${(hovered.x / W) * 100}%`, top: `${(hovered.y / H) * 100 - 15}%`, transform: "translate(-50%, -100%)" }}>
          <div className="font-mono text-foreground font-semibold">${hovered.nav.toFixed(4)}</div>
          <div className="text-muted mt-0.5">{new Date(hoveredSample.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
        </div>
      ) : null}
    </div>
  );
}

function PositionPanel({ pos, g, wallet }: { pos: LycPosition | null; g: LycGlobal | null; wallet: ReturnType<typeof useWallet> }) {
  if (!wallet.isConnected) return (<div className="rounded-xl border border-dashed border-border p-8 text-center"><p className="text-sm text-muted mb-3">Connect a wallet to see your position.</p><ConnectWalletButton className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink" /></div>);
  if (!pos || !g) return (<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[...Array(4)].map((_, i) => (<div key={i} className="rounded-xl border border-border bg-surface p-4 animate-pulse"><div className="h-3 w-16 bg-surface-2 rounded" /><div className="h-5 w-24 bg-surface-2 rounded mt-2" /></div>))}</div>);
  return (<div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><PosStat label="vLYC held" value={formatWad(pos.balance, 4)} /><PosStat label="Value" value={usd((pos.balance * g.nav) / WAD)} /><PosStat label="Max redeemable" value={formatWad(pos.maxRedeemable, 4)} /><PosStat label="Unlocked" value={formatWad(pos.unlocked, 4)} /></div>);
}

function PosStat({ label, value }: { label: string; value: string }) {
  return (<div className="rounded-xl border border-border bg-surface p-4"><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div><div className="mt-1 font-mono text-lg text-foreground">{value}</div></div>);
}

function TransactionsPanel() {
  return (<div className="rounded-xl border border-dashed border-border p-8 text-center"><p className="text-sm text-muted">Transaction history will appear here.</p></div>);
}
