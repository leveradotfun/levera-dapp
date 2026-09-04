import { formatUnits, parseUnits } from "ethers";

export const WAD = 10n ** 18n;

/// Format a WAD (1e18) bigint as a fixed-point string, e.g. formatWad(1234_500...n, 2) → "1,234.50".
export function formatWad(value: bigint, decimals = 2, thousands = true): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / WAD;
  const frac = abs % WAD;
  const fracStr = frac.toString().padStart(18, "0").slice(0, decimals);
  const wholeStr = thousands ? whole.toLocaleString("en-US") : whole.toString();
  return `${negative ? "-" : ""}${wholeStr}${decimals > 0 ? "." + fracStr : ""}`;
}

/// "$1,234.56"
export function usd(valueWad: bigint, decimals = 2): string {
  return `$${formatWad(valueWad, decimals)}`;
}

/// Compact USD for tickers: $1.23M, $45.6K, $0.89.
export function usdCompact(valueWad: bigint): string {
  const n = Number(valueWad) / 1e18;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/// Parse a human amount ("6.9") into the quote asset's own units. This is the direction every
/// caller wants: contract inputs are in quote units, not WAD.
export function parseQuoteAmount(amount: string, quoteDecimals: number): bigint {
  return parseUnits(amount, quoteDecimals);
}

/// Format a quote-asset amount (18-decimal or not) for display.
export function formatQuoteAmount(amount: bigint, quoteDecimals: number, fracDigits = 6): string {
  const s = formatUnits(amount, quoteDecimals);
  // trim trailing zeros past fracDigits without touching "0.000021" style strings
  const parts = s.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (!frac) return whole;
  const trimmed = frac.slice(0, fracDigits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}
