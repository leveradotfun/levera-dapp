"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ethers } from "ethers";
import Link from "next/link";
import { LAUNCH_DEFAULTS, createLaunch, previewCreatorBuy } from "@/lib/launchpad";
import { humanizeError } from "@/lib/toast";
import { TX_TIMEOUT_LONG_MS, withTimeout } from "@/lib/txTimeout";
import { spendableEth, useWallet } from "@/lib/wallet";
import { useAppState } from "@/lib/appState";
import ConnectWalletButton from "@/components/ConnectWalletButton";
import { QuoteAsset, formatQuote, listQuoteAssets, parseQuote } from "@/lib/quoteAssets";

export default function CreatePage() {
  const router = useRouter();
  const { addresses, refreshLaunches } = useAppState();
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [buyIn, setBuyIn] = useState("");
  const [leverageEnabled, setLeverageEnabled] = useState(true);
  const [feeInHfyc, setFeeInHfyc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallet = useWallet(addresses);

  // Arweave image + socials
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [website, setWebsite] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");

  async function handleImageFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Image must be png, jpg, webp, gif or svg.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Image too large. Max 5MB.");
      return;
    }
    setUploading(true);
    setError(null);
    const preview = URL.createObjectURL(file);
    setImagePreview(preview);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/arweave/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed");
      setImageUrl(json.gatewayUrl || json.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Image upload failed");
      setImageUrl(null);
    } finally {
      setUploading(false);
    }
  }

  // The quote asset a coin is denominated in, pairs against, and is levered against. Choosing one
  // chooses a launchpad, and the coin is bound to it afterwards.
  const [quotes, setQuotes] = useState<QuoteAsset[]>([]);
  const [quoteToken, setQuoteToken] = useState<string>("");
  useEffect(() => {
    if (!addresses) return;
    let live = true;
    listQuoteAssets(addresses).then((list) => {
      if (!live) return;
      setQuotes(list);
      setQuoteToken((prev) => prev || list[0]?.token || "");
    });
    return () => {
      live = false;
    };
  }, [addresses]);
  const quote = useMemo(() => quotes.find((q) => q.token === quoteToken) ?? quotes[0], [quotes, quoteToken]);

  let buyInWad = 0n;
  let buyInInvalid = false;
  if (buyIn.trim() && quote) {
    try {
      // In the quote asset's OWN units. cbBTC is 8 decimals, so parsing as WAD would make a
      // 0.05 cbBTC buy-in 1e10 too large.
      buyInWad = parseQuote(buyIn.trim(), quote.decimals);
      if (buyInWad < 0n) buyInInvalid = true;
    } catch {
      buyInInvalid = true;
    }
  }
  const spendable = wallet.balances ? spendableEth(wallet.balances.eth) : 0n;
  // What the buy-in spends: native ETH (through the QuoteZap) for a WETH-quoted coin, the quote
  // ERC-20 itself for anything else -- cbBTC is 8 decimals and is never native gas.
  const quoteName = quote ? quote.label : "ETH";
  const quoteBalance = quote ? (quote.wrapsNativeEth ? spendable : wallet.balances?.cbbtc ?? 0n) : 0n;
  const insufficient = !!quote && buyInWad > 0n && wallet.balances !== null && buyInWad > quoteBalance;
  const maxLabel = quote ? formatQuote(quoteBalance, quote.decimals, Math.min(quote.decimals, 6)) : "0";

  // What the dev buy would actually receive, and the 20% cap it is checked against -- computed
  // the same way the factory itself will, so this can refuse the click instead of the transaction
  // reverting "creator cap" after a real (if cheap) gas spend.
  const devBuyPreview =
    quote && buyInWad > 0n
      ? previewCreatorBuy(quote.targetRaise, buyInWad, quote.creatorBuyCapBps)
      : null;
  const exceedsCap = devBuyPreview?.exceedsCap ?? false;
  const capTokensLabel = quote
    ? Number(previewCreatorBuy(quote.targetRaise, 0n, quote.creatorBuyCapBps).capTokens / 10n ** 18n).toLocaleString()
    : null;

  async function submit() {
    if (!addresses) {
      setError("No deployment found. Deploy the contracts from the local console first.");
      return;
    }
    if (!wallet.isConnected) {
      setError("Connect a wallet to launch a coin.");
      return;
    }
    if (!name.trim() || !ticker.trim()) {
      setError("Name and ticker are required.");
      return;
    }
    if (buyInInvalid) {
      setError("Buy-in amount isn't a valid number.");
      return;
    }
    if (insufficient) {
      setError(`Buy-in is more ${quote ? quote.label : "collateral"} than this wallet holds.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus("Creating coin...");
      const launchAddress = await withTimeout(
        createLaunch(addresses, {
          name: name.trim(),
          symbol: ticker.trim().toUpperCase(),
          buyInCollateral: buyInWad > 0n ? buyInWad : undefined,
          quote: quote ? { factory: quote.factory, targetRaise: quote.targetRaise, token: quote.token } : undefined,
          leverageEnabled,
          creatorFeeInHfyc: leverageEnabled && feeInHfyc,
        }),
        TX_TIMEOUT_LONG_MS,
        "Creating coin",
      );
      // Persist off-chain metadata (Arweave image + website/socials) for display
      if (imageUrl || website.trim() || telegram.trim() || discord.trim()) {
        try {
          await fetch("/api/token-metadata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              launch: launchAddress,
              imageUrl: imageUrl || null,
              website: website.trim() || null,
              telegram: telegram.trim() || null,
              discord: discord.trim() || null,
            }),
          });
        } catch {
          // metadata is best-effort — coin already exists
        }
      }
      refreshLaunches();
      router.push(`/coin/${launchAddress}`);
    } catch (e) {
      setError(humanizeError(e, "Could not create the coin."));
      import("@/lib/sessionLog").then((m) => m.logError("createLaunch", e)).catch(() => {});
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl py-6">
      <Link href="/" className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </Link>

      <div className="mb-5">
        <h1 className="text-lg font-bold text-foreground">Launch a coin</h1>
        <p className="text-xs text-muted mt-0.5">
          Bonding curve first. Check 2x to pair against HFyc at graduation, or leave it off for a
          normal market.
        </p>
      </div>

      {/* Two columns side by side instead of one long stack -- this page has the width to spare,
          and splitting "what you're creating" from "how it's configured" means both fit on screen
          together instead of the settings being scrolled out of view below the fold. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <div className="text-[10px] uppercase tracking-wide text-muted">Coin details</div>

          {quotes.length > 0 ? (
            <div className="space-y-1">
              <div className="text-xs text-muted">Quote asset</div>
              <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
                {quotes.map((q) => (
                  <button
                    key={q.factory}
                    type="button"
                    onClick={() => {
                      setQuoteToken(q.token);
                      setBuyIn(""); // a new asset has different decimals; never re-parse the old number
                    }}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      quote?.token === q.token ? "bg-accent text-accent-ink" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {q.label}
                    <span className="ml-1.5 font-mono text-[10px] opacity-70">raise {q.targetRaiseLabel}</span>
                  </button>
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-muted">
                Denominates the curve, the AMM pair, and every fee — and it is fixed at creation,
                because picking a quote asset is picking a launchpad. cbBTC is 8 decimals; amounts
                are parsed in the asset&apos;s own units.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Robinhood Doge"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              />
            </Field>
            <Field label="Ticker">
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="RHDOGE"
                maxLength={10}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-accent"
              />
            </Field>
          </div>

          {/* Token image — stored on Arweave (permanent, content-addressed) */}
          <div className="space-y-1">
            <div className="text-xs text-muted">Token image (Arweave, permanent)</div>
            <div className="flex items-center gap-3">
              {imagePreview ? (
                <img src={imagePreview} alt="preview" className="h-16 w-16 rounded-xl object-cover border border-border" />
              ) : (
                <div className="h-16 w-16 rounded-xl border border-dashed border-border bg-surface flex items-center justify-center text-[10px] text-muted">
                  No image
                </div>
              )}
              <label className={`cursor-pointer rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${uploading ? "border-border bg-surface text-muted" : "border-border bg-surface text-foreground hover:border-accent"}`}>
                {uploading ? "Uploading…" : imageUrl ? "Change image" : "Upload image"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImageFile(f);
                  }}
                  disabled={uploading}
                />
              </label>
              {imageUrl ? <span className="text-[11px] text-green truncate max-w-[160px]">✓ {imageUrl}</span> : null}
            </div>
            <p className="text-[11px] text-muted">PNG/JPG/WebP/GIF/SVG, max 5MB. Stored via Arweave (content-addressed, permanent).</p>
          </div>

          <div className="space-y-3">
            <div className="text-xs text-muted">Links (optional)</div>
            <Field label="Website">
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              />
            </Field>
            <Field label="Telegram">
              <input
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
                placeholder="https://t.me/... or @handle"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              />
            </Field>
            <Field label="Discord">
              <input
                value={discord}
                onChange={(e) => setDiscord(e.target.value)}
                placeholder="https://discord.gg/..."
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
              />
            </Field>
          </div>

          {/* Optional first buy, the way pump.fun offers one at creation. Deliberately framed as
              "first in line", not a discount: it's an ordinary buy on the open curve at the same
              price and the same 1.00% fee anyone else pays -- see createLaunch's own comment. */}
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted">
                Buy some {ticker.trim() ? `$${ticker.trim()}` : "of your coin"} first{" "}
                <span className="opacity-70">(optional)</span>
              </span>
              {wallet.balances ? (
                <button
                  type="button"
                  onClick={() => setBuyIn(maxLabel)}
                  className="font-mono text-[10px] text-muted hover:text-foreground"
                >
                  max {maxLabel} {quoteName}
                </button>
              ) : null}
            </div>
            <div
              className={`flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 ${
                buyInInvalid || insufficient || exceedsCap ? "border-red/50" : "border-border focus-within:border-accent"
              }`}
            >
              <input
                value={buyIn}
                onChange={(e) => setBuyIn(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                className="w-full bg-transparent text-sm font-mono text-foreground outline-none"
              />
              <span className="shrink-0 font-mono text-xs text-muted">{quoteName}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted">
              Optional, but buying a little first means you&apos;re ahead of the snipers rather than
              behind them. Same curve price and same 1.00% fee as any other buyer — creating a coin
              doesn&apos;t buy it cheaper.
              {capTokensLabel ? (
                <>
                  {" "}Capped at {capTokensLabel} tokens
                  ({(Number(quote!.creatorBuyCapBps) / 100).toFixed(0)}% of supply) —
                  buying past it is refused before you spend anything.
                </>
              ) : null}
            </p>
            {exceedsCap && devBuyPreview ? (
              <p className="text-[11px] leading-relaxed text-red">
                That would get you ~{Number(devBuyPreview.tokensOut / 10n ** 18n).toLocaleString()}{" "}
                tokens — over the {capTokensLabel}-token cap. Lower the amount to launch with a buy.
              </p>
            ) : null}
          </div>

          <p className="text-[11px] leading-relaxed text-muted">
            You earn <span className="text-accent">0.50%</span> of every trade on your coin, forever,
            paid in {quoteName}.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-3 rounded-2xl border border-border bg-card p-6">
            <div className="text-[10px] uppercase tracking-wide text-muted">Launch settings</div>

            {/* Protocol settings, shown for transparency but not editable -- these define what the
                product IS, and a per-coin combination of them would make every coin behave
                differently. */}
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                leverageEnabled ? "border-accent/40 bg-accent/5" : "border-border bg-surface/50"
              }`}
            >
              <input
                type="checkbox"
                checked={leverageEnabled}
                onChange={(e) => {
                  setLeverageEnabled(e.target.checked);
                  if (!e.target.checked) setFeeInHfyc(false);
                }}
                className="mt-0.5 h-4 w-4 accent-[var(--accent,#ECE3D1)]"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-semibold text-foreground">2x leverage</span>
                <span className="block text-[11px] leading-relaxed text-muted">
                  {leverageEnabled
                    ? "Attaches whatever HFyc is idle at graduation (up to 2x), then tops up as cash arrives. If senior is scarce, quieter 2x coins get peeled into this one. You pay occupancy rent and a pairing fee only on the dollars actually attached."
                    : "Normal launch. After the curve fills it trades as a 1x market and never pulls HFyc senior."}
                </span>
              </span>
            </label>

            {leverageEnabled ? (
              <div className="rounded-lg border border-border bg-surface/50 p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-muted">Creator fee (0.50%)</div>
                <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
                  {(
                    [
                      { hfyc: false, label: quoteName },
                      { hfyc: true, label: "HFyc" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => setFeeInHfyc(opt.hfyc)}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                        feeInHfyc === opt.hfyc ? "bg-accent text-accent-ink" : "text-muted hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  {feeInHfyc
                    ? "Your 0.50% is converted to HFyc at harvest, minted at NAV, and immediately withdrawable (in the pool's collateral or USDG) on the HFyc page. This cannot be changed after launch."
                    : `Your 0.50% stays as ${quoteName}. Claim it from your profile whenever you want. This cannot be changed after launch.`}
                </p>
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted">
                1x: creator 0.50% in {quoteName}, the rest to protocol — a 1x coin never pairs, so
                HFyc has nothing attached and earns nothing from it. Taking your OWN fee as HFyc
                still requires 2x.
              </p>
            )}

            <div className="rounded-lg border border-border bg-surface/50 p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Protocol settings</div>
              <Spec
                label="Graduates at"
                value={`${quote?.targetRaiseLabel ?? LAUNCH_DEFAULTS.targetRaiseEth} ${quoteName} raised`}
              />
              <Spec label="Supply" value="800M public / 200M LP seed" />
              <Spec label="Leverage" value={leverageEnabled ? "2x (HFyc loop + our AMM)" : "None (spot AMM)"} />
              <Spec
                label="Your fee"
                value={leverageEnabled && feeInHfyc ? "0.50% in HFyc" : `0.50% in ${quoteName}`}
              />
            </div>
          </div>

          {error ? (
            <div className="rounded-lg border border-red/20 bg-red/5 p-2.5 text-xs text-red">{error}</div>
          ) : null}

          {!wallet.isConnected ? (
            <ConnectWalletButton label="Connect wallet to launch" />
          ) : (
            <button
              onClick={submit}
              disabled={busy || buyInInvalid || insufficient || exceedsCap}
              className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? status ?? "Launching..." : buyInWad > 0n ? "Create coin & buy" : "Create coin"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-secondary">{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
