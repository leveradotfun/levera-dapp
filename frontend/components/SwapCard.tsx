"use client";

import { useState } from "react";
import { ethers } from "ethers";
import ConnectWalletButton from "@/components/ConnectWalletButton";
import TokenIcon from "@/components/TokenIcon";
import { formatWad } from "@/lib/launchpad";

/// formatWad always divides by 1e18 — correct for every token here except cbBTC, which is 8
/// decimals. Format against the token's own decimals so an 8-decimal balance doesn't read as ~0.
function formatTokenBalance(balance: bigint, decimals: number): string {
  if (decimals === 18) return formatWad(balance, 4);
  const s = parseFloat(ethers.formatUnits(balance, decimals));
  return s.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function sanitizeNumericInput(v: string): string {
  let s = v.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    const before = s.slice(0, firstDot + 1);
    const after = s.slice(firstDot + 1).replace(/\./g, "").slice(0, 4);
    s = before + after;
  }
  if (s.startsWith("0") && s.length > 1 && s[1] !== ".") {
    s = s.replace(/^0+/, "");
    if (s === "" || s[0] === ".") s = "0" + s;
  }
  // hard cap integer length to 18 digits to avoid overflow
  const [intPart, decPart] = s.split(".");
  if (intPart.length > 18) s = intPart.slice(0, 18) + (decPart !== undefined ? "." + decPart : "");
  return s;
}

function formatWithCommas(v: string): string {
  if (!v) return "";
  const [intPart, decPart] = v.split(".");
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decPart !== undefined) return `${formattedInt}.${decPart}`;
  return formattedInt;
}

export type SwapToken = {
  symbol: string;
  balance: bigint;
  /** Defaults to 18 (WAD). Set to 8 for cbBTC. */
  decimals?: number;
  /** A launched coin's pinned artwork, shown in place of the letter badge. */
  imageUrl?: string;
};

/// One entry in a token picker attached to a Pay/Receive pill. `key` is what's reported back
/// through onChange; `symbol` drives the icon and is shown as the label unless `label` overrides.
export type TokenOption = {
  key: string;
  symbol: string;
  label?: string;
};

export type SwapCardProps = {
  mode: "buy" | "sell";
  onModeChange: (m: "buy" | "sell") => void;
  buyLabel?: string;
  sellLabel?: string;
  /** The token being spent (buy: ETH/USDG, sell: coin) */
  inputToken: SwapToken;
  /** The token being received (buy: coin, sell: ETH/USDG) */
  outputToken: SwapToken;
  /** When set (2+ entries), the Pay pill becomes a dropdown instead of a static badge. */
  inputTokenOptions?: TokenOption[];
  onInputTokenChange?: (key: string) => void;
  /** Same, for the Receive pill. */
  outputTokenOptions?: TokenOption[];
  onOutputTokenChange?: (key: string) => void;
  /** Controlled input value */
  value: string;
  onValueChange: (v: string) => void;
  /** Formatted quote output */
  quoteLabel: string;
  /** Dollar value of input/output — e.g. "$1,000" — so fetch is visible */
  inputUsdLabel?: string;
  outputUsdLabel?: string;
  slippage?: string;
  slippageOptions?: number[];
  onSlippageChange?: (bps: number) => void;
  slippageBps?: number;
  busy: boolean;
  disabled?: boolean;
  isConnected: boolean;
  connectLabel?: string;
  buyButtonLabel?: string;
  sellButtonLabel?: string;
  banner?: React.ReactNode;
  warning?: React.ReactNode;
  feeNote?: string;
  onBuy: () => void;
  onSell: () => void;
  onMax?: () => void;
};

/// The token pill on a Pay/Receive row. Plain badge when there's nothing to pick; a dropdown
/// button, opening a small menu of icons + symbols, when `options` has more than one entry.
function TokenPill({
  symbol,
  imageUrl,
  options,
  onChange,
}: {
  symbol: string;
  /** The coin's own artwork (token metadata), shown instead of the letter badge. */
  imageUrl?: string;
  options?: TokenOption[];
  onChange?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!options || options.length < 2 || !onChange) {
    return (
      <span className="flex items-center gap-1.5 pl-1.5 pr-3 py-1.5 rounded-full bg-surface-2 text-sm font-semibold text-foreground">
        <TokenIcon symbol={symbol} size={20} imageUrl={imageUrl} />
        {symbol}
      </span>
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 pl-1.5 pr-2 py-1.5 rounded-full bg-surface-2 text-sm font-semibold text-foreground hover:brightness-110 transition-[filter]"
      >
        <TokenIcon symbol={symbol} size={20} imageUrl={imageUrl} />
        {symbol}
        <svg className={`w-3.5 h-3.5 text-muted transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-40 rounded-xl border border-border bg-card shadow-xl p-1.5 z-20">
            {options.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  onChange(opt.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors ${
                  opt.symbol === symbol ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface hover:text-foreground"
                }`}
              >
                <TokenIcon symbol={opt.symbol} size={18} />
                {opt.label ?? opt.symbol}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function SwapCard({
  mode,
  onModeChange,
  buyLabel = "Buy",
  sellLabel = "Sell",
  inputToken,
  outputToken,
  inputTokenOptions,
  onInputTokenChange,
  outputTokenOptions,
  onOutputTokenChange,
  value,
  onValueChange,
  quoteLabel,
  slippage = "1.0",
  slippageOptions,
  onSlippageChange,
  slippageBps,
  busy,
  disabled = false,
  isConnected,
  connectLabel = "Connect wallet to trade",
  buyButtonLabel,
  sellButtonLabel,
  banner,
  warning,
  feeNote,
  onBuy,
  onSell,
  onMax,
  inputUsdLabel,
  outputUsdLabel,
}: SwapCardProps) {
  const parsed = (() => {
    try {
      const v = parseFloat(value);
      return isNaN(v) || v <= 0 ? 0n : BigInt(Math.round(v * 1e18));
    } catch {
      return 0n;
    }
  })();

  const [showSlippage, setShowSlippage] = useState(false);

  const handleSubmit = () => {
    if (mode === "buy") onBuy();
    else onSell();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      {/* Mode toggle + fee */}
      <div className="flex items-center gap-2">
        <div className="flex flex-1 rounded-lg border border-border bg-surface p-1">
          {(["buy", "sell"] as const).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                mode === m ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {m === "buy" ? buyLabel : sellLabel}
            </button>
          ))}
        </div>
        {slippageOptions && onSlippageChange && slippageBps !== undefined ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSlippage(!showSlippage)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-surface text-xs font-medium text-muted hover:text-foreground hover:border-muted transition-colors"
              title="Adjust slippage tolerance"
            >
              <span className="font-mono">{slippage}%</span>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            {showSlippage && (
              <div className="absolute right-0 top-full mt-2 w-48 rounded-xl border border-border bg-card shadow-xl p-2 z-20">
                <div className="text-[11px] font-medium text-muted mb-2 px-1">Max slippage</div>
                <div className="grid grid-cols-3 gap-1">
                  {slippageOptions.map((bps) => (
                    <button
                      key={bps}
                      type="button"
                      onClick={() => {
                        onSlippageChange(bps);
                        setShowSlippage(false);
                      }}
                      className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                        slippageBps === bps ? "bg-accent text-accent-ink" : "bg-surface text-muted hover:text-foreground hover:bg-surface-2"
                      }`}
                    >
                      {(bps / 100).toFixed(1)}%
                    </button>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-border">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      placeholder="Custom %"
                      min={0}
                      max={50}
                      step={0.1}
                      defaultValue={slippageBps !== undefined && !slippageOptions.includes(slippageBps) ? (slippageBps / 100).toFixed(1) : ""}
                      className="flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const v = parseFloat((e.target as HTMLInputElement).value);
                          if (!isNaN(v) && v >= 0 && v <= 50) {
                            onSlippageChange(Math.round(v * 100));
                            setShowSlippage(false);
                          }
                        }
                      }}
                      onBlur={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= 0 && v <= 50) {
                          onSlippageChange(Math.round(v * 100));
                          setShowSlippage(false);
                        }
                      }}
                    />
                    <span className="text-xs text-muted">%</span>
                  </div>
                  <p className="text-[10px] text-muted mt-1 px-1">Higher slippage tolerates larger price moves but may worsen execution.</p>
                </div>
              </div>
            )}
          </div>
        ) : slippageOptions ? (
          <span className="px-2 py-1 rounded-md bg-surface text-xs text-muted font-mono">{slippage}%</span>
        ) : null}
      </div>

      {/* Pay */}
      <div className="relative rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between text-xs text-muted mb-1">
          <span>Pay</span>
          <div className="flex items-center gap-2">
            <span className="font-mono">{formatTokenBalance(inputToken.balance, inputToken.decimals ?? 18)}</span>
            {onMax ? (
              <button onClick={onMax} className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-2 transition-colors">
                Max
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={formatWithCommas(value)}
            onChange={(e) => onValueChange(sanitizeNumericInput(e.target.value))}
            placeholder="0.0"
            inputMode="decimal"
            className="min-w-0 flex-1 bg-transparent font-mono text-3xl text-foreground outline-none placeholder:text-muted"
          />
          <TokenPill symbol={inputToken.symbol} imageUrl={inputToken.imageUrl} options={inputTokenOptions} onChange={onInputTokenChange} />
        </div>
        {inputUsdLabel ? <div className="mt-1 text-xs text-muted">{inputUsdLabel}</div> : null}
      </div>

      {/* Swap direction */}
      <div className="flex justify-center -my-6 relative z-10">
        <button className="w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center text-muted hover:text-foreground transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        </button>
      </div>

      {/* Receive */}
      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between text-xs text-muted mb-1">
          <span>Receive</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate font-mono text-3xl text-foreground">{quoteLabel || "0"}</span>
          <TokenPill symbol={outputToken.symbol} imageUrl={outputToken.imageUrl} options={outputTokenOptions} onChange={onOutputTokenChange} />
        </div>
        {outputUsdLabel ? <div className="mt-1 text-xs text-muted">{outputUsdLabel}</div> : null}
      </div>

      {/* Banner */}
      {banner}

      {/* Warning */}
      {warning}

      {/* Action button */}
      {!isConnected ? (
        <ConnectWalletButton label={connectLabel} />
      ) : (
        <button
          disabled={busy || disabled || parsed <= 0n}
          onClick={handleSubmit}
          className="w-full rounded-xl px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-accent text-accent-ink hover:brightness-110"
        >
          {busy
            ? "Confirming..."
            : parsed <= 0n
              ? `Enter the amount to ${mode}...`
              : mode === "buy"
                ? (buyButtonLabel ?? `Buy ${outputToken.symbol}`)
                : (sellButtonLabel ?? `Sell ${outputToken.symbol}`)}
        </button>
      )}

      {feeNote ? (
        <p className="text-[11px] text-muted text-center">{feeNote}</p>
      ) : null}
    </div>
  );
}
