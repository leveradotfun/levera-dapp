"use client";

import { LaunchSummary, displayQuoteSymbol, usdCompact } from "@/lib/launchpad";
import PriceLabelRaw from "@/components/PriceLabel";
import TokenIcon from "@/components/TokenIcon";
import { timeAgo } from "@/lib/utils";
import { useXHandles } from "@/lib/xHandles";
import { useTokenImages } from "@/lib/tokenMetadata";
import TraderIdentity from "@/components/TraderIdentity";

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

function SproutIcon() {
  return (
    <svg className="w-3 h-3 text-green" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 22c4.97 0 9-4.03 9-9-4.97 0-9 4.03-9 9zM5.6 10.25c0 1.38 1.12 2.5 2.5 2.5.53 0 1.01-.16 1.42-.44l-.02.19c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5l-.02-.19c.4.28.89.44 1.42.44 1.38 0 2.5-1.12 2.5-2.5 0-1-.59-1.85-1.43-2.25.84-.4 1.43-1.25 1.43-2.25 0-1.38-1.12-2.5-2.5-2.5-.53 0-1.01.16-1.42.44l.02-.19C14.5 2.12 13.38 1 12 1S9.5 2.12 9.5 3.5l.02.19c-.4-.28-.89-.44-1.42-.44-1.38 0-2.5 1.12-2.5 2.5 0 1 .59 1.85 1.43 2.25-.84.4-1.43 1.25-1.43 2.25zM12 5.5c1.38 0 2.5 1.12 2.5 2.5s-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8s1.12-2.5 2.5-2.5zM3 13c0 4.97 4.03 9 9 9 0-4.97-4.03-9-9-9z" />
    </svg>
  );
}

function CreatorIcon() {
  return (
    <svg className="w-3 h-3 text-accent" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
    </svg>
  );
}

export default function LiveLaunchGrid({
  launches,
  onSelect,
}: {
  launches: LaunchSummary[];
  onSelect: (launch: LaunchSummary) => void;
}) {
  // Called before the empty-state early return below: hooks run unconditionally.
  const xHandles = useXHandles();
  const tokenImages = useTokenImages(launches.map((l) => l.address));
  if (launches.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-12 text-center">
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

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {launches.map((l) => {
        const h = hashOf(l.address);
        const color = PALETTE[h % PALETTE.length];
        const emoji = EMOJI[(h >>> 3) % EMOJI.length];
        const isNew = l.stats.createdAt !== null && Date.now() - l.stats.createdAt < 3600000;
        // "Hot" = pre-graduation with high bonding speed: >50% filled or volume exceeds 50% of target
        const targetUsd = Number(l.targetUsd) / 1e18;
        const volumeUsd = l.stats.volume24hUsd;
        const isHot = !l.graduated && (l.pctToGraduation > 50 || (targetUsd > 0 && volumeUsd > targetUsd * 0.5));
        const change = l.stats.change24h;

        return (
          <button
            key={l.address}
            onClick={() => onSelect(l)}
            className="group relative overflow-hidden rounded-2xl border border-border bg-card p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lg hover:shadow-black/40"
          >
            {/* Paired-token art, anchor right like the reference card. Behind the content so the
                right-aligned stats stay readable. */}
            <TokenIcon
              symbol={displayQuoteSymbol(l.quoteSymbol)}
              size={144}
              className="pointer-events-none absolute -right-10 top-1/2 -translate-y-1/2 opacity-20 transition-opacity duration-200 group-hover:opacity-30"
            />
            <div className="relative">
            <div className="flex items-start gap-3">
              {tokenImages.get(l.address.toLowerCase()) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={tokenImages.get(l.address.toLowerCase())}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-xl border object-cover transition-transform group-hover:scale-105"
                  style={{ borderColor: `${color}55` }}
                />
              ) : (
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl transition-transform group-hover:scale-105"
                  style={{
                    background: `linear-gradient(135deg, ${color}30, ${color}0d)`,
                    border: `1px solid ${color}55`,
                  }}
                >
                  {emoji}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-bold text-foreground text-lg">${l.symbol}</span>
                  {isNew && <SproutIcon />}
                </div>
                <div className="truncate text-sm text-muted">{l.name}</div>
              </div>
            </div>

            {/* Pair token + graduation state -- the two things a scanner can't trade without */}
            <div className="mt-2.5 flex items-center gap-1.5 text-sm">
              <span className="text-muted">{l.graduated ? "Paired with" : "Raising in"}</span>
              {/* Logo only -- hovering the icon names the quote asset */}
              <span title={`${l.graduated ? "Paired with" : "Raising in"} ${displayQuoteSymbol(l.quoteSymbol)}`}>
                <TokenIcon symbol={displayQuoteSymbol(l.quoteSymbol)} size={16} />
              </span>
              {l.graduated ? (
                <span
                  className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-green/15 px-2 py-0.5 text-[10px] font-semibold text-green"
                  title={l.paired ? "Graduated — paired against LYC senior at 2x" : "Graduated — trading live on the AMM"}
                >
                  <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 111.4-1.4l2.8 2.79 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                  Graduated
                </span>
              ) : (
                <span
                  className="ml-1 inline-flex shrink-0 items-center rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-muted"
                  title={`On the bonding curve — ${l.pctToGraduation.toFixed(0)}% to graduation`}
                >
                  Bonding
                </span>
              )}
            </div>

            <div className="mt-3 flex items-baseline justify-between">
              <PriceLabelRaw value={l.priceUsd} className="font-mono text-sm text-foreground" />
              <span
                className={`font-mono text-xs ${change === null || change === undefined ? "text-muted" : change >= 0 ? "text-green" : "text-red"}`}
              >
                {change === null || change === undefined ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}% 24h`}
              </span>
            </div>

            <div className="mt-2 flex items-center gap-1 text-xs text-muted">
              <CreatorIcon />
              <span className="truncate">by</span>
              <TraderIdentity address={l.creator} identity={xHandles.get(l.creator.toLowerCase())} size={14} className="text-muted" />
              <span className="ml-auto shrink-0">{timeAgo(l.stats.createdAt) === "—" ? null : `${timeAgo(l.stats.createdAt)} ago`}</span>
            </div>

            {!l.graduated ? (
              <div className="mt-3">
                <div className="flex items-center gap-1.5 mb-1.5">
                  {l.leverageEnabled && (
                    <span className="rounded-full bg-blue-400/15 text-blue-400 px-2 py-0.5 text-[10px] font-semibold">
                      2x
                    </span>
                  )}
                  {isHot && (
                    <span className="rounded-full bg-orange-500/15 text-orange-400 px-2 py-0.5 text-[10px] font-semibold animate-vibrate">
                      HOT
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-muted">{usdCompact(l.marketCapUsd)} mcap</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.max(l.pctToGraduation, l.pctToGraduation > 0 ? 2 : 0)}%`,
                      background: `linear-gradient(90deg, ${color}99, ${color})`,
                    }}
                  />
                </div>
                <div className="flex justify-between mt-1 font-mono text-[10px] text-muted">
                  <span>{usdCompact(l.raisedUsd)} raised</span>
                  <span>{l.pctToGraduation.toFixed(0)}%</span>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-1.5">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    l.paired
                      ? "bg-green/15 text-green"
                      : l.leverageEnabled
                        ? "bg-blue-400/15 text-blue-400"
                        : "bg-surface text-muted"
                  }`}
                  title={l.paired ? "Paired against LYC senior at 2x" : l.leverageEnabled ? "Graduated — pairs when LYC senior is available" : "Spot market"}
                >
                  {l.paired ? "2x live" : l.leverageEnabled ? "1x · awaiting senior" : "spot"}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted">{usdCompact(l.marketCapUsd)} mcap</span>
              </div>
            )}
            </div>
          </button>
        );
      })}
    </div>
  );
}