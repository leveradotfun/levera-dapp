"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { DeployedAddresses } from "@/lib/chain";
import { useWallet } from "@/lib/wallet";
import ConnectWalletButton from "@/components/ConnectWalletButton";
import { usePriceHistory, computePeriodChanges } from "@/lib/priceHistory";
import { useTradeHistory } from "@/lib/trades";
import { fetchHolderCount } from "@/lib/launchStats";
import { useXHandles } from "@/lib/xHandles";
import PopNumber from "@/components/PopNumber";
import TraderIdentity from "@/components/TraderIdentity";
import dynamic from "next/dynamic";
import { SkeletonChart, SkeletonRows } from "@/components/Skeleton";

// Code-split and client-only. Neither is needed for the first paint of a coin page -- the chart
// needs a price series that only accumulates after mount, and the trades table sits below the fold
// -- so keeping them out of the initial bundle gets the header and trade card interactive sooner.
const LivePriceChart = dynamic(() => import("@/components/LivePriceChart"), {
  ssr: false,
  loading: () => <SkeletonChart height={380} />,
});
const TradesTable = dynamic(() => import("@/components/TradesTable"), {
  ssr: false,
  loading: () => (
    <table className="w-full text-sm">
      <tbody>
        <SkeletonRows rows={6} cols={6} />
      </tbody>
    </table>
  ),
});
import LeverageBandBar from "@/components/LeverageBandBar";
import { LaunchSummary, buy, fetchEthBalance, fetchTokenBalance, formatWad, quoteBuy, quoteSell, sell, usd, usdCompact, WAD } from "@/lib/launchpad";
import { useTokenMetadata } from "@/lib/tokenMetadata";
import { spendableEth } from "@/lib/wallet";
import PriceLabel from "@/components/PriceLabel";
import SwapCard from "@/components/SwapCard";
import MobileSwapSheet from "@/components/MobileSwapSheet";
import { useIsDesktop } from "@/lib/useMediaQuery";
import { timeAgo } from "@/lib/utils";
import { toastError, toastSuccess } from "@/lib/toast";
import { TX_TIMEOUT_MS, withTimeout } from "@/lib/txTimeout";

const FAV_KEY = "launchpad-favorites";
// Last-used trade side persists across reloads: a seller reloading mid-position shouldn't be
// dropped back on the buy tab.
const TRADE_SIDE_KEY = "launchpad-trade-side";

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

/// Compact USD for the stats panel. Small figures keep cents, because a coin's early trades are
/// worth a few dollars and rounding them to "$0" would read as no activity at all.
function usdShort(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/// Two-tone proportion bar. `left` is the green share as a percentage; the red side is the
/// remainder, so the two can never disagree about what the whole is.
function SplitBar({ left }: { left: number }) {
  const pct = Math.min(100, Math.max(0, left));
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-surface">
      <div className="bg-green" style={{ width: `${pct}%` }} />
      <div className="bg-red" style={{ width: `${100 - pct}%` }} />
    </div>
  );
}

export default function LaunchDetail({
  launch,
  addresses,
  onBack,
  onRefresh,
}: {
  launch: LaunchSummary;
  addresses: DeployedAddresses | null;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const priceHistory = usePriceHistory(launch.address, addresses?.oracle);
  const { trades, loading: tradesLoading, refresh } = useTradeHistory(launch.address, addresses);
  // The creator's connected X identity, so the byline shows name + picture when known.
  const xHandles = useXHandles();
  // Real holder count: everyone who ever received a transfer of this coin and still holds a
  // nonzero balance, not "unique buyers ∪ sellers in the last 24h" (see fetchHolderCount's own
  // comment for why that undercounts long-term holders and overcounts anyone who fully exited).
  const [holderCount, setHolderCount] = useState<number | null>(null);
  useEffect(() => {
    let stopped = false;
    fetchHolderCount(launch.address, [launch.address, launch.amm])
      .then((n) => {
        if (!stopped) setHolderCount(n);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
    // Re-derive whenever the trade log grows -- a new trade means the holder set may have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.address, launch.amm, trades.length]);
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  // Reopen on the tab the user last traded on: a seller reloading mid-position shouldn't land on
  // Buy. The read lives in an effect (not a lazy initializer) so SSR and first client render agree.
  useEffect(() => {
    try {
      if (localStorage.getItem(TRADE_SIDE_KEY) === "sell") setSide("sell");
    } catch {
      // localStorage unavailable — plain buy default
    }
  }, []);

  function changeSide(m: "buy" | "sell") {
    setSide(m);
    setAmount("");
    try {
      localStorage.setItem(TRADE_SIDE_KEY, m);
    } catch {
      // persistence is best-effort
    }
  }
  // "ETH" here means "the launch's quote asset, paid natively" — for a cbBTC-quoted coin that is
  // plain cbBTC (there is no native cbBTC, so this is its only quote tab), for a WETH-quoted coin
  // it goes through the QuoteZap so a buyer never needs to hold WETH. "WETH" is only offered for a
  // WETH-quoted coin, for someone who already holds WETH and would rather spend it directly than
  // wrap-then-buy. USDG is the second leg: swapped to the quote through the launch's own router at
  // fill time.
  const [payToken, setPayToken] = useState<"ETH" | "WETH" | "USDG">("ETH");
  // Sell-side mirror of payToken. "ETH" means the launch's quote asset -- native ether via the
  // QuoteZap for a WETH-quoted coin, plain cbBTC otherwise. "WETH" (WETH-quoted coins only) keeps
  // the quote as the ERC-20; "USDG" routes the proceeds through the launch's router into cash.
  const [receiveToken, setReceiveToken] = useState<"ETH" | "WETH" | "USDG" | "CBBTC">("ETH");
  const [quoteTokenBalance, setQuoteTokenBalance] = useState<bigint>(0n);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"trades">("trades");
  const [ethBalance, setEthBalance] = useState<bigint>(0n);
  const [tokenBalance, setTokenBalance] = useState<bigint>(0n);
  const [usdgBalance, setUsdgBalance] = useState<bigint>(0n);
  const [slippageBps, setSlippageBps] = useState(100); // 1% curve; bumped on graduation
  const wallet = useWallet(addresses);
  const meta = useTokenMetadata(launch.address);
  // Favorites persist per wallet so the list is yours, not the browser's; a plain-set in
  // localStorage was enough — no backend for a preference this small.
  const [faved, setFaved] = useState(false);
  useEffect(() => {
    const key = wallet.address?.toLowerCase() ?? "";
    let favs: Record<string, string[]> = {};
    try {
      favs = JSON.parse(localStorage.getItem(FAV_KEY) ?? "{}");
    } catch {
      favs = {};
    }
    setFaved(key !== "" && (favs[key] ?? []).includes(launch.address.toLowerCase()));
  }, [launch.address, wallet.address]);

  function toggleFavorite() {
    const key = wallet.address?.toLowerCase() ?? "";
    if (key === "") {
      toastError(new Error("Connect a wallet to save favorites."), "Favorites");
      return;
    }
    try {
      const favs: Record<string, string[]> = JSON.parse(localStorage.getItem(FAV_KEY) ?? "{}");
      const list = new Set(favs[key] ?? []);
      const id = launch.address.toLowerCase();
      if (list.has(id)) {
        list.delete(id);
        setFaved(false);
      } else {
        list.add(id);
        setFaved(true);
        toastSuccess(`${launch.symbol} saved to favorites.`);
      }
      favs[key] = [...list];
      localStorage.setItem(FAV_KEY, JSON.stringify(favs));
    } catch {
      // localStorage unavailable — favorite just doesn't persist
    }
  }

  async function shareLaunch() {
    const text = `${launch.name} ($${launch.symbol})`;
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: text, url });
        return;
      } catch {
        // user dismissed the share sheet — not an error
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toastSuccess("Link copied to clipboard.");
    } catch {
      toastError(new Error("Clipboard unavailable."), "Share failed.");
    }
  }

  async function fetchBalances() {
    try {
      if (!wallet.address) {
        setEthBalance(0n);
        setTokenBalance(0n);
        setUsdgBalance(0n);
        return;
      }
      // Buys pull the launch's quote ERC-20 (Launch.buy is approve-then-pull, not msg.value), so
      // the spendable quote for a WETH coin is still shown against native ETH here -- the ERC-20
      // quote balance for other assets is fetched separately once quoteInfo resolves.
      const [eth, token, usdg] = await Promise.all([
        fetchEthBalance(wallet.address),
        fetchTokenBalance(launch.address, wallet.address),
        addresses ? fetchTokenBalance(addresses.usdg, wallet.address) : Promise.resolve(0n),
      ]);
      setEthBalance(eth);
      setTokenBalance(token);
      setUsdgBalance(usdg);
    } catch (e) {
      console.error("Failed to fetch balances:", e);
    }
  }

  useEffect(() => {
    fetchBalances();
  }, [launch.address, addresses, wallet.address]);

  // The quote asset this coin trades in, taken from the launch summary (which read quote() and
  // quoteScale() off the chain) rather than a separate one-shot fetch: a fetch that 429s at mount
  // used to leave the whole page saying "quote" with 18-decimal formatting. WETH-quoted coins
  // keep the native-ETH wording, cbBTC ones get their own symbol and decimals everywhere below.
  const quoteInfo = launch.quoteToken
    ? { token: launch.quoteToken, symbol: launch.quoteSymbol, decimals: launch.quoteDecimals }
    : null;
  const wrapsNative = !!addresses && !!quoteInfo && quoteInfo.token.toLowerCase() === addresses.weth.toLowerCase();
  const quoteSymbol = wrapsNative ? "ETH" : quoteInfo?.symbol ?? "quote";
  const quoteDecimals = quoteInfo?.decimals ?? 18;
  const paySymbol = payToken === "USDG" ? "USDG" : payToken === "WETH" ? "WETH" : quoteSymbol;
  // What the Receive pill shows on a sell: the picked exit asset, with "ETH" resolving to the
  // quote's display symbol (native ETH for a WETH coin, cbBTC for a cbBTC one).
  const receiveSymbol = receiveToken === "USDG" ? "USDG" : receiveToken === "CBBTC" ? "cbBTC" : receiveToken === "WETH" && wrapsNative ? "WETH" : quoteSymbol;
  // What a buy actually spends from: native gas for the "ETH" tab on a WETH coin, the wallet's own
  // WETH ERC-20 for the "WETH" tab, the quote ERC-20 for everything else (cbBTC), USDG when paying
  // in cash.
  const buyMax =
    payToken === "USDG"
      ? usdgBalance
      : payToken === "WETH"
        ? wallet.balances?.weth ?? 0n
        : wrapsNative
          ? spendableEth(ethBalance)
          : quoteTokenBalance;
  const fmtPay = (v: bigint) => ethers.formatUnits(v, payToken === "USDG" ? 18 : quoteDecimals);
  // Quote-amount formatter with the coin's own decimals: formatWad assumes 18 and printed 0.00
  // for every cbBTC figure on this page.
  const fmtQuote = (v: bigint, places = 4) => {
    const raw = ethers.formatUnits(v, quoteDecimals);
    const [whole, frac = ""] = raw.split(".");
    return `${Number(whole).toLocaleString("en-US")}.${(frac + "0".repeat(places)).slice(0, places)}`;
  };
  const quotePlaces = quoteDecimals >= 18 ? 4 : Math.min(quoteDecimals, 6);
  // Quote amount -> USDG at the coin's own collateral mark. The router does exactly this math
  // (collateralIn * collateralScale * price / WAD) with no spread, so the label and the minOut
  // for the USDG leg can both derive from it.
  const quoteToUsdg = (v: bigint) =>
    launch.collateralPriceUsd > 0n ? (v * launch.collateralPriceUsd) / 10n ** BigInt(quoteDecimals) : 0n;
  const fmtUsdg = (v: bigint, places = 2) => {
    const raw = ethers.formatUnits(v, 18);
    const [whole, frac = ""] = raw.split(".");
    return `${Number(whole).toLocaleString("en-US")}.${(frac + "0".repeat(places)).slice(0, places)}`;
  };

  // Dollar values for the swap card — so we know what's been fetched, like the
  // fUSD → sfUSD example ($1,000 ↔ $1,000).
  const inputUsdLabel = (() => {
    if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) return undefined;
    try {
      if (side === "buy") {
        const dec = payToken === "USDG" ? 18 : quoteDecimals;
        const parsed = ethers.parseUnits(amount, dec);
        if (parsed <= 0n) return undefined;
        let usdWad: bigint;
        if (payToken === "USDG") {
          usdWad = parsed; // 1 USDG = $1
        } else {
          const colPrice = BigInt(launch.collateralPriceUsd as unknown as string);
          if (colPrice === 0n) return undefined;
          usdWad = (parsed * colPrice) / 10n ** BigInt(quoteDecimals);
        }
        return usd(usdWad);
      } else {
        const parsed = ethers.parseUnits(amount, 18);
        if (parsed <= 0n) return undefined;
        const price = BigInt(launch.priceUsd as unknown as string);
        if (price === 0n) return undefined;
        return usd((parsed * price) / WAD);
      }
    } catch {
      return undefined;
    }
  })();

  const outputUsdLabel = (() => {
    if (quote === null) return undefined;
    try {
      if (side === "buy") {
        if (BigInt(launch.priceUsd as unknown as string) === 0n) return undefined;
        return usd((quote * BigInt(launch.priceUsd as unknown as string)) / WAD);
      } else {
        if (BigInt(launch.collateralPriceUsd as unknown as string) === 0n) return undefined;
        return usd((quote * BigInt(launch.collateralPriceUsd as unknown as string)) / 10n ** BigInt(quoteDecimals));
      }
    } catch {
      return undefined;
    }
  })();

  const tokenReserveUsdLabel = (() => {
    try {
      const rt = BigInt(launch.reserveToken as unknown as string);
      const pu = BigInt(launch.priceUsd as unknown as string);
      return usd((rt * pu) / WAD);
    } catch {
      return usd(0n);
    }
  })();
  const tokenReserveAmountLabel = (() => {
    try {
      return `${formatWad(launch.reserveToken, 0)} ${launch.symbol}`;
    } catch {
      return `0 ${launch.symbol}`;
    }
  })();
  // Liquidity, matching how every AMM platform counts it: the value of both sides of the book a
  // trader could actually exit into. junior's residual (tvlUsd - seniorUsd -- senior's claim isn't
  // junior's liquidity, it's LYC's) plus the memecoin's own reserve, priced. For a 1x coin
  // seniorUsd is always zero, so this is just tvlUsd + token reserve -- the same formula, no
  // special case needed.
  //
  // This is mathematically the ETH-terms breakdown "juniorETH (reserveEth) + (vaultEth -
  // seniorClaimEth) + tokenReserveEth" collapsed to one USD expression: reserveEth + vaultEth -
  // seniorClaimEth *is* memeNAV in ETH terms (poolEth - seniorClaimEth), so tvlUsd - seniorUsd
  // already nets in any vault excess from collateral appreciation -- no separate term needed.
  const liquidityUsd = (() => {
    try {
      const tvl = BigInt(launch.tvlUsd as unknown as string);
      const senior = BigInt(launch.seniorUsd as unknown as string);
      const rt = BigInt(launch.reserveToken as unknown as string);
      const pu = BigInt(launch.priceUsd as unknown as string);
      const junior = tvl > senior ? tvl - senior : 0n;
      return junior + (rt * pu) / WAD;
    } catch {
      return launch.tvlUsd as unknown as bigint;
    }
  })();

  // Price impact vs spot: compares execution price to current spot price
  const priceImpact = (() => {
    if (!amount || quote === null || quote === 0n) return null;
    try {
      const clean = amount.replace(/,/g, "");
      if (!clean || Number(clean) <= 0) return null;
      const price = BigInt(launch.priceUsd as unknown as string);
      if (price === 0n) return null;
      if (side === "buy") {
        const dec = payToken === "USDG" ? 18 : quoteDecimals;
        const parsed = ethers.parseUnits(clean, dec);
        if (parsed <= 0n) return null;
        let usdIn: bigint;
        if (payToken === "USDG") usdIn = parsed;
        else {
          const colPrice = BigInt(launch.collateralPriceUsd as unknown as string);
          if (colPrice === 0n) return null;
          usdIn = (parsed * colPrice) / (10n ** BigInt(quoteDecimals));
        }
        const expectedTokens = (usdIn * WAD) / price;
        if (expectedTokens === 0n) return null;
        return (Number(quote - expectedTokens) * 100) / Number(expectedTokens);
      } else {
        const parsed = ethers.parseUnits(clean, 18);
        if (parsed <= 0n) return null;
        const usdInTokens = (parsed * price) / WAD;
        const colPrice = BigInt(launch.collateralPriceUsd as unknown as string);
        if (colPrice === 0n) return null;
        const expectedQuote = (usdInTokens * 10n ** BigInt(quoteDecimals)) / colPrice;
        if (expectedQuote === 0n) return null;
        return (Number(quote - expectedQuote) * 100) / Number(expectedQuote);
      }
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (!wallet.address || !quoteInfo || wrapsNative) {
      setQuoteTokenBalance(0n);
      return;
    }
    let live = true;
    fetchTokenBalance(quoteInfo.token, wallet.address)
      .then((b) => {
        if (live) setQuoteTokenBalance(b);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wallet.address, quoteInfo, wrapsNative, launch.quoteToken]);

  // Default slippage 1% for every swap — previously auto-bumped to 15% after graduation. Also
  // reset the per-pool picks: the receive token (a "WETH" picked on an ETH-quoted coin is
  // meaningless on a cbBTC one) and the default spend — the user's own WETH on ETH-quoted coins
  // (the common post-sell case, no wrap hop), the quote ERC-20 itself on cbBTC ones. The amount
  // box starts empty either way; the user types what they want.
  useEffect(() => {
    setSlippageBps(100);
    setReceiveToken("ETH");
    setPayToken(wrapsNative ? "WETH" : "ETH");
    // wrapsNative is derived from this same launch; it is settled before the page mounts LaunchDetail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.address]);

  // The amount box is denominated in what is actually being SPENT: the pay token when buying
  // (ETH or USDG), the coin itself when selling.

  async function refreshQuote(next: string) {
    // sanitize: numbers only, one dot, max 4 decimals, comma-aware
    let clean = next.replace(/,/g, "").replace(/[^0-9.]/g, "");
    const dotIdx = clean.indexOf(".");
    if (dotIdx !== -1) {
      const before = clean.slice(0, dotIdx + 1);
      const after = clean.slice(dotIdx + 1).replace(/\./g, "").slice(0, 4);
      clean = before + after;
    }
    if (clean.startsWith("0") && clean.length > 1 && clean[1] !== ".") {
      clean = clean.replace(/^0+/, "");
      if (clean === "" || clean[0] === ".") clean = "0" + clean;
    }
    if (clean.split(".")[0].length > 18) clean = clean.slice(0, 18) + (clean.includes(".") ? "." + clean.split(".")[1] : "");
    setAmount(clean);
    try {
      // The box is denominated in what is being spent: the quote asset's own units when paying in
      // it (cbBTC is 8 decimals), USDG's 18 when paying in cash, the coin's 18 when selling.
      const dec = side === "sell" ? 18 : payToken === "USDG" ? 18 : quoteDecimals;
      const parsed = ethers.parseUnits(clean || "0", dec);
      if (parsed <= 0n) {
        setQuote(null);
        return;
      }
      if (side === "sell") {
        setQuote(await quoteSell(launch.address, parsed));
        return;
      }
      const quoteIn =
        payToken === "USDG" && launch.collateralPriceUsd > 0n
          ? (parsed * 10n ** BigInt(quoteDecimals)) / launch.collateralPriceUsd
          : parsed;
      setQuote(await quoteBuy(launch.address, quoteIn));
    } catch {
      setQuote(null);
    }
  }

  // Re-quote when the side or pay token flips -- the same figure means something different on the
  // other side, so a stale quote from the previous side would be actively misleading.
  useEffect(() => {
    refreshQuote(amount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, payToken, quoteDecimals, launch.address]);

  async function submit() {
    if (!addresses || !wallet.isConnected || !wallet.address) return;
    setBusy(true);
    try {
      const dec = side === "sell" ? 18 : payToken === "USDG" ? 18 : quoteDecimals;
      const cleanAmount = amount.replace(/,/g, "");
      const parsed = ethers.parseUnits(cleanAmount || "0", dec);
      if (parsed <= 0n) throw new Error("Enter an amount greater than zero.");

      if (side === "buy") {
        if (parsed > buyMax) {
          throw new Error(`Not enough ${paySymbol} — you have ${fmtPay(buyMax)}.`);
        }
        // quoteBuy speaks quote units; a USDG amount converts at the coin's own oracle mark.
        const quoteIn =
          payToken === "USDG" && launch.collateralPriceUsd > 0n
            ? (parsed * WAD) / launch.collateralPriceUsd
            : parsed;
        const q = await quoteBuy(launch.address, quoteIn);
        if (q <= 0n) {
          // A zero quote from a readable contract means the curve is genuinely sold out or the
          // junior has no NAV to price against -- not that the amount is wrong. Saying "try a
          // different amount" sent people to fiddle with an input that was never the problem.
          throw new Error(
            "This market can't fill a buy right now — the curve is sold out, or the coin's NAV is zero pending a rebalance."
          );
        }
        const minTokensOut = (q * (10000n - BigInt(slippageBps))) / 10000n;
        await withTimeout(buy(addresses, launch.address, payToken, parsed, minTokensOut), TX_TIMEOUT_MS, "Buy");
        toastSuccess("Swap confirmed", `${fmtPay(parsed)} ${paySymbol} → ${formatWad(q, 0)} ${launch.symbol}`);
      } else {
        // Clamp to the live balance rather than whatever is in the box: the balance can move
        // between typing and submitting (the autopilot trades the same coins), and selling more
        // than you hold reverts.
        const bal: bigint = await fetchTokenBalance(launch.address, wallet.address);
        if (bal === 0n) throw new Error(`You hold no ${launch.symbol} to sell.`);
        const amt = parsed > bal ? bal : parsed;
        // minOut is a COLLATERAL amount, so it has to come from a collateral quote. Deriving it
        // from the token amount instead compares two different units and reverts every time.
        const expectedOut = await quoteSell(launch.address, amt);
        const minOut = (expectedOut * (10000n - BigInt(slippageBps))) / 10000n;
        // Native ETH keeps the QuoteZap; a WETH or cbBTC payout takes the plain ERC-20 path; USDG
        // converts after the fill. The USDG minOut re-derives from the same oracle the router
        // prices at, so it only has to absorb drift between the two transactions.
        const sellReceive =
          receiveToken === "USDG" ? ("USDG" as const)
          : receiveToken === "CBBTC" && addresses.cbbtc ? ("CBBTC" as const)
          : wrapsNative ? (receiveToken === "WETH" ? ("QUOTE" as const) : ("ETH" as const))
          : ("QUOTE" as const);
        const expectedUsdg = quoteToUsdg(expectedOut);
        const minUsdgOut = (expectedUsdg * (10000n - BigInt(slippageBps))) / 10000n;
        await withTimeout(sell(addresses, launch.address, amt, minOut, sellReceive, minUsdgOut), TX_TIMEOUT_MS, "Sell");
        toastSuccess(
          "Swap confirmed",
          `${formatWad(amt, 0)} ${launch.symbol} → ${
            sellReceive === "USDG" ? `${fmtUsdg(expectedUsdg)} USDG` : `${fmtQuote(expectedOut, quotePlaces)} ${quoteSymbol}`
          }`,
        );
      }
      setAmount("");
      setQuote(null);
      onRefresh();
      fetchBalances();
    } catch (e) {
      // Toast, not an inline panel: the raw ethers revert dump is many lines long and rendering it
      // inside the card stretched the card itself.
      toastError(e, side === "buy" ? "Buy failed." : "Sell failed.");
    } finally {
      setBusy(false);
    }
  }

  const periodChanges = computePeriodChanges(priceHistory);

  const isDesktop = useIsDesktop();

  const h = hashOf(launch.address);
  const color = PALETTE[h % PALETTE.length];
  const emoji = EMOJI[(h >>> 3) % EMOJI.length];
  const isNew = launch.stats.createdAt !== null && Date.now() - launch.stats.createdAt < 3600000;

  // The trade card and the token info panels sit in different places per breakpoint but must each
  // exist exactly once: the swap card owns the amount input state, and LeverageBandBar polls the
  // chain, so neither may render in two copies. On phones the card lives inside a bottom sheet
  // (opened from a fixed bar above the nav) while the info panels stay in the page flow below the
  // trades; on desktop both stack in the sticky right-hand column.
  const swapContent = (
    <>
      <SwapCard
        mode={side}
        onModeChange={changeSide}
        buyLabel="Buy" sellLabel="Sell"
        inputToken={{
          symbol: side === "buy" ? paySymbol : launch.symbol,
          balance: side === "buy" ? buyMax : tokenBalance,
          decimals: side === "buy" ? (payToken === "USDG" ? 18 : quoteDecimals) : 18,
          imageUrl: side === "buy" ? undefined : meta?.imageUrl ?? undefined,
        }}
        outputToken={{
          symbol: side === "buy" ? launch.symbol : receiveSymbol,
          balance: 0n,
          imageUrl: side === "buy" ? meta?.imageUrl ?? undefined : undefined,
        }}
        inputTokenOptions={
          side === "buy"
            ? [
                { key: "ETH", symbol: quoteSymbol },
                ...(wrapsNative ? [{ key: "WETH", symbol: "WETH" }] : []),
                { key: "USDG", symbol: "USDG" },
              ]
            : undefined
        }
        onInputTokenChange={side === "buy" ? (v) => { setPayToken(v as typeof payToken); setAmount(""); } : undefined}
        outputTokenOptions={
          side === "sell"
            ? [
                { key: "ETH", symbol: quoteSymbol },
                { key: "USDG", symbol: "USDG" },
                ...(addresses?.cbbtc ? [{ key: "CBBTC", symbol: "cbBTC" }] : []),
                ...(wrapsNative ? [{ key: "WETH", symbol: "WETH" }] : []),
              ]
            : undefined
        }
        onOutputTokenChange={side === "sell" ? (v) => setReceiveToken(v as typeof receiveToken) : undefined}
        value={amount} onValueChange={(v) => refreshQuote(v)}
        quoteLabel={
          quote !== null
            ? side === "buy"
              ? formatWad(quote, 0)
              : receiveToken === "USDG"
                ? fmtUsdg(quoteToUsdg(quote))
                : fmtQuote(quote, quotePlaces)
            : "…"
        }
        inputUsdLabel={inputUsdLabel}
        outputUsdLabel={outputUsdLabel}
        slippage={(slippageBps / 100).toFixed(1)} slippageOptions={[50, 100, 300]} onSlippageChange={setSlippageBps} slippageBps={slippageBps}
        busy={busy} disabled={!addresses} isConnected={!!wallet.isConnected} connectLabel="Connect wallet to trade"
        buyButtonLabel={`Buy ${launch.symbol}`} sellButtonLabel={`Sell ${launch.symbol}`}
        onMax={() => {
          const max = side === "buy" ? buyMax : tokenBalance;
          const dec = side === "sell" ? 18 : payToken === "USDG" ? 18 : quoteDecimals;
          const raw = ethers.formatUnits(max, dec);
          const [ip, dp] = raw.split(".");
          const trimmed = dp ? `${ip}.${dp.slice(0, 4)}` : ip;
          refreshQuote(trimmed);
        }}
        onBuy={submit} onSell={submit}
      />

      {amount && quote !== null && (
        <div className="rounded-lg border border-border bg-surface p-3 space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-muted">Slippage tolerance</span>
            <span className="font-mono text-foreground">{(slippageBps / 100).toFixed(2)}%</span>
          </div>
          {priceImpact !== null && (
            <div className="flex justify-between text-xs">
              <span className="text-muted">Price impact</span>
              <span className={`font-mono ${priceImpact < -0.5 ? "text-red" : priceImpact > 0.5 ? "text-green" : "text-muted"}`}>
                {priceImpact > 0 ? "+" : ""}
                {priceImpact.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* Presets — directly under swap card, above Stats/Audit */}
      {side === "buy" && (
        <div className="grid grid-cols-3 gap-2">
          {(payToken === "USDG"
            ? ["100", "500", "1000"]
            : quoteSymbol === "cbBTC"
              ? ["0.001", "0.005", "0.01"]
              : ["0.1", "0.5", "1"]
          ).map((amt) => (
            <button key={amt} type="button" onClick={() => refreshQuote(amt)}
              className="rounded-lg border border-border bg-surface py-2 text-sm font-medium text-foreground hover:border-accent transition-colors">
              {amt} {paySymbol}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {["25%", "50%", "100%"].map((pct) => (
          <button key={pct} type="button"
            onClick={() => { const max = side === "buy" ? buyMax : tokenBalance; refreshQuote(ethers.formatUnits((max * BigInt(parseInt(pct))) / 100n, side === "sell" ? 18 : payToken === "USDG" ? 18 : quoteDecimals)); }}
            className="rounded-lg border border-border bg-surface py-2 text-sm font-medium text-foreground hover:border-accent transition-colors">
            {pct}
          </button>
        ))}
      </div>

      <p className="text-[11px] text-muted text-center">
        1.00% fee — 0.50% creator, up to 0.05% to vLYC (scaled by how paired this pool is),
        the rest to protocol.
      </p>
    </>
  );

  const infoContent = (
    <>
      {/* Token Data */}
      {(() => {
        const since = Date.now() - 86_400_000;
        const inWindow = trades.filter((t) => t.timestamp >= since && t.type !== "rebalance");
        const buys = inWindow.filter((t) => t.type === "buy");
        const sells = inWindow.filter((t) => t.type === "sell");
        const buyVol = buys.reduce((sum, t) => sum + t.amountUsd, 0);
        const sellVol = sells.reduce((sum, t) => sum + t.amountUsd, 0);
        const totalVol = buyVol + sellVol;
        const buyPct = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;
        return (
          <div className="rounded-xl border border-border bg-card p-3 space-y-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted font-semibold">Token Data</div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-lg bg-surface px-2.5 py-2">
                <div className="text-base font-bold text-foreground leading-tight">{holderCount ?? "…"}</div>
                <div className="text-[10px] text-muted leading-tight">Holders</div>
              </div>
              <div className="rounded-lg bg-surface px-2.5 py-2">
                <div className="text-base font-bold text-foreground leading-tight truncate">{usd(liquidityUsd)}</div>
                <div className="text-[10px] text-muted leading-tight">Liquidity</div>
              </div>
              <div className="rounded-lg bg-surface px-2.5 py-2">
                <div className="text-base font-bold text-green leading-tight">{buyVol > 0 ? `${((buyVol / (buyVol + sellVol || 1)) * 100).toFixed(0)}%` : "0%"}</div>
                <div className="text-[10px] text-muted leading-tight">Buy pressure 24h</div>
              </div>
              <div className="rounded-lg bg-surface px-2.5 py-2">
                <div className="text-base font-bold text-foreground leading-tight truncate">{usdShort(totalVol)}</div>
                <div className="text-[10px] text-muted leading-tight">Volume 24h</div>
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[11px] mb-1 gap-2">
                <span className="text-green truncate">{buys.length} buys {usdShort(buyVol)}</span>
                <span className="text-red truncate text-right">{sells.length} sells {usdShort(sellVol)}</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-surface overflow-hidden flex">
                <div className="h-full bg-green rounded-l-full" style={{ width: `${buyPct}%` }} />
                <div className="h-full bg-red rounded-r-full" style={{ width: `${100 - buyPct}%` }} />
              </div>
            </div>
            <div className="border-t border-border pt-2 space-y-1 text-[11px]">
              <div className="flex justify-between gap-2"><span className="text-muted truncate">AMM reserve</span><span className="font-mono text-foreground truncate">{fmtQuote(launch.reserveEth, quotePlaces)} {quoteSymbol}</span></div>
              <div className="flex justify-between gap-2"><span className="text-muted truncate">Token reserve</span><span className="font-mono text-foreground truncate">{tokenReserveAmountLabel} · {tokenReserveUsdLabel}</span></div>
              {launch.leverageEnabled ? (
                <>
                  <div className="flex justify-between gap-2"><span className="text-muted truncate">vLYC vault</span><span className="font-mono text-foreground truncate">{fmtQuote(launch.vaultEth, quotePlaces)} {quoteSymbol}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-muted truncate">Occupancy paid</span><span className="font-mono text-foreground truncate">{usd(launch.occupancyPaidUsd)}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-muted truncate">Pairing fees</span><span className="font-mono text-foreground truncate">{usd(launch.pairingFeesPaidUsd)}</span></div>
                </>
              ) : null}
            </div>
          </div>
        );
      })()}

      {/* Bonding curve / Leverage */}
      {!launch.graduated ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span>
              <span className="text-sm font-semibold text-foreground">Bonding curve progress</span>
            </div>
            <span className="text-sm font-semibold text-accent">{launch.pctToGraduation.toFixed(0)}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface mb-3">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${launch.pctToGraduation}%` }} />
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-muted">To graduate</span><span className="font-semibold text-foreground">MC {usdCompact(launch.targetUsd)}</span></div>
            <div className="flex justify-between"><span className="text-muted">Amount required</span><span className="font-semibold text-foreground">{fmtQuote(launch.targetCollateral - launch.raisedCollateral, quotePlaces)} {quoteSymbol}<span className="text-muted ml-1">({usdCompact(launch.targetUsd - launch.raisedUsd)})</span></span></div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted">
            <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            <span>Graduates at 100%.</span>
          </div>
        </div>
      ) : (
        <LeverageBandBar launchAddress={launch.address} />
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-muted hover:text-foreground">
        &larr; All coins
      </button>

      {/* ── Full-width token header ── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {meta?.imageUrl ? (
            <img
              src={meta.imageUrl}
              alt={launch.symbol}
              className="h-14 w-14 shrink-0 rounded-2xl object-cover border-2"
              style={{ borderColor: `${color}55` }}
            />
          ) : (
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-2xl"
              style={{ backgroundColor: `${color}22`, border: `2px solid ${color}55` }}
            >
              {emoji}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">${launch.symbol}</h1>
            <div className="text-sm text-muted">{launch.name}</div>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-muted">
              {isNew && (
                <svg className="w-3 h-3 text-green" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 22c4.97 0 9-4.03 9-9-4.97 0-9 4.03-9 9zM5.6 10.25c0 1.38 1.12 2.5 2.5 2.5.53 0 1.01-.16 1.42-.44l-.02.19c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5l-.02-.19c.4.28.89.44 1.42.44 1.38 0 2.5-1.12 2.5-2.5 0-1-.59-1.85-1.43-2.25.84-.4 1.43-1.25 1.43-2.25 0-1.38-1.12-2.5-2.5-2.5-.53 0-1.01.16-1.42.44l.02-.19C14.5 2.12 13.38 1 12 1S9.5 2.12 9.5 3.5l.02.19c-.4-.28-.89-.44-1.42-.44-1.38 0-2.5 1.12-2.5 2.5 0 1 .59 1.85 1.43 2.25-.84.4-1.43 1.25-1.43 2.25zM12 5.5c1.38 0 2.5 1.12 2.5 2.5s-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8s1.12-2.5 2.5-2.5zM3 13c0 4.97 4.03 9 9 9 0-4.97-4.03-9-9-9z" />
                </svg>
              )}
              <span>{timeAgo(launch.stats.createdAt)} ago</span>
              <span className="text-muted">·</span>
              <TraderIdentity address={launch.creator} identity={xHandles.get(launch.creator.toLowerCase())} size={14} className="text-muted" />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
          <div className="text-right">
            <div className="text-xs text-muted">Market cap.</div>
            <PopNumber
                value={usdCompact(launch.marketCapUsd)}
                className="text-2xl font-bold text-foreground"
              />
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button"
              onClick={() => navigator.clipboard.writeText(launch.address).then(() => toastSuccess("Contract address copied.")).catch(() => {})}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground hover:border-accent transition-colors"
              title="Copy contract address">
              {launch.address.slice(0, 4)}...{launch.address.slice(-4)}
            </button>
            <button type="button" onClick={shareLaunch}
              className="rounded-lg border border-border bg-surface p-2 text-muted hover:text-foreground transition-colors" title="Share">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </button>
            <button type="button" onClick={toggleFavorite}
              className={`rounded-lg border border-border bg-surface p-2 transition-colors ${faved ? "text-red" : "text-muted hover:text-foreground"}`}
              title={faved ? "Remove from favorites" : "Add to favorites"}>
              <svg className="w-4 h-4" fill={faved ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Chart + swap card ── */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Left: chart + trades + stats */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Chart */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xl font-bold text-foreground">
                <PriceLabel value={launch.priceUsd} />
              </span>
              <div className="flex flex-wrap gap-3">
                {periodChanges.map((pc) => (
                  <span key={pc.label} className="text-xs text-muted-foreground">
                    {pc.label}{" "}
                    {pc.pct !== null ? (
                      <span className={`font-mono ${pc.pct >= 0 ? "text-green" : "text-red"}`}>
                        {pc.pct >= 0 ? "+" : ""}{pc.pct.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="font-mono">—</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
            <LivePriceChart points={priceHistory} />
          </div>

          {/* About: the token's own description + links, from its launch metadata */}
          {meta && (meta.description || meta.website || meta.telegram || meta.discord || meta.twitter) ? (
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">About ${launch.symbol}</h2>
                <div className="flex items-center gap-3">
                  {meta.website && (
                    <a href={meta.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18" /></svg>
                      Website
                    </a>
                  )}
                  {meta.telegram && (
                    <a href={meta.telegram.startsWith("http") || meta.telegram.startsWith("@") ? (meta.telegram.startsWith("@") ? `https://t.me/${meta.telegram.slice(1)}` : meta.telegram) : `https://t.me/${meta.telegram}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                      <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2a10 10 0 00-3.16 19.49c-.07-.7-.13-1.78-.04-2.55l.53-3.05-1.08-.21c-.88-.17-1.5-.74-1.5-1.5 0-.07.01-.14.02-.21A10 10 0 0012 2z" /></svg>
                      Telegram
                    </a>
                  )}
                  {meta.twitter && (
                    <a href={meta.twitter.startsWith("http") ? meta.twitter : `https://x.com/${meta.twitter.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                      </svg>
                      X
                    </a>
                  )}
                  {meta.discord && (
                    <a href={meta.discord} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                      <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M19.73 4.87A17.2 17.2 0 0012 0a17.2 17.2 0 00-7.73 4.87A16.06 16.06 0 002 14.3a13.6 13.6 0 004.11 2.07 11.1 11.1 0 001.22-1.86 9.6 9.6 0 01-1.93-.93l.46-.36a11.1 11.1 0 001.97.93 11.1 11.1 0 001.97-.93l.46.36a9.6 9.6 0 01-1.93.93 11.1 11.1 0 001.22 1.86A13.6 13.6 0 0022 14.3a16.06 16.06 0 00-2.27-9.43z" /></svg>
                      Discord
                    </a>
                  )}
                </div>
              </div>
              {meta.description ? (
                <p className="text-sm leading-relaxed text-secondary whitespace-pre-line">{meta.description}</p>
              ) : null}
            </div>
          ) : null}

          {/* Trades */}
          <div>
            <div className="flex gap-2 mb-3">
              <button onClick={() => setActiveTab("trades")}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${activeTab === "trades" ? "bg-surface text-foreground" : "text-muted hover:text-foreground"}`}>
                Trades
              </button>
            </div>
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              {tradesLoading && trades.length === 0 ? (
                <table className="w-full text-sm"><tbody><SkeletonRows rows={6} cols={6} /></tbody></table>
              ) : (
                <TradesTable
                  trades={trades}
                  creatorAddress={launch.creator}
                  userAddress={wallet.address ?? ""}
                  onRefresh={refresh}
                  refreshing={tradesLoading}
                  quoteSymbol={quoteInfo ? (wrapsNative ? "ETH" : quoteInfo.symbol) : undefined}
                  quoteDecimals={quoteDecimals}
                />
              )}
            </div>
          </div>

          {/* Phones: token info stays in the page flow below the trades; the swap card itself
              lives in the bottom sheet opened from the fixed trade bar. */}
          {!isDesktop && <div className="space-y-4">{infoContent}</div>}
        </div>

        {isDesktop ? (
          <div className="w-[380px] shrink-0">
            <div className="sticky top-4 space-y-4">
              {swapContent}
              {infoContent}
            </div>
          </div>
        ) : (
          <MobileSwapSheet
            triggerLabel={side === "buy" ? `Buy ${launch.symbol}` : `Sell ${launch.symbol}`}
            title={`Trade $${launch.symbol}`}
          >
            {swapContent}
          </MobileSwapSheet>
        )}
      </div>
    </div>
  );
}
