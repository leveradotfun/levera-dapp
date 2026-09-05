"use client";

import { useState } from "react";

/// Shared token logo. Files live in /public/tokens/ (lyc.svg, cbbtc.svg, weth.svg, eth.svg,
/// usdg.svg); a symbol not in that set (a launched coin with no logo yet) falls back to a plain
/// letter badge rather than a broken image. `imageUrl` overrides the lookup entirely -- a
/// launched coin's pinned IPFS artwork passes through here so the swap card shows the real
/// token image, degrading to the letter badge if the image fails to load.
const TOKEN_LOGOS: Record<string, string> = {
  ETH: "/tokens/eth.svg",
  WETH: "/tokens/weth.svg",
  // The testnet's wrapped-native token is named mWETH; same asset, same logo.
  MWETH: "/tokens/weth.svg",
  CBBTC: "/tokens/cbbtc.svg",
  LYC: "/tokens/lyc.svg",
  USDG: "/tokens/usdg.svg",
};

const FALLBACK_COLORS: Record<string, string> = {
  USDG: "#2775CA",
};

export default function TokenIcon({
  symbol,
  size = 20,
  className,
  imageUrl,
}: {
  symbol: string;
  size?: number;
  className?: string;
  /** Artwork for a launched coin (its token-metadata image). Wins over the built-in logos. */
  imageUrl?: string;
}) {
  const [broken, setBroken] = useState(false);
  const key = symbol.toUpperCase();
  const src = imageUrl || TOKEN_LOGOS[key];

  if (src && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={symbol}
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size, borderRadius: "9999px", flexShrink: 0 }}
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: "9999px",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.42,
        fontWeight: 700,
        color: "#fff",
        background: FALLBACK_COLORS[key] ?? "#52525b",
      }}
    >
      {symbol[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
