"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchLaunchCollateralPriceUsd, type LaunchSummary } from "./launchpad";
import { fetchLaunchStats, tradesFor, isTrade } from "./launchStats";

/// The "Top PNL" discovery list for profile pages: every trader on the factory, ranked by net
/// PnL, so wallets can find (and follow) each other without anyone having connected Twitter.
///
/// Reads the SAME shared trade-log scan the coin table and the profile positions already use
/// (lib/launchStats' per-launch cache) — this hook just makes sure every launch has been scanned,
/// then aggregates. PnL per trader is the same FIFO math the profile page uses for itself, with
/// one deliberate substitution: a trader's current tokens come from the trade log (buys − sells)
/// rather than balanceOf, because fetching real balances for every trader ever would be an RPC
/// storm. On this protocol tokens only move through logged trades, so the delta is the balance.

export type TopTraderRow = {
  address: string; // lowercase
  profit: number; // realized + unrealized, USD
  realized: number;
  unrealized: number;
  trades: number;
  firstTs: number | null;
  lastTs: number | null;
};

const TOKEN_EPS = 1e-9;

type LaunchBook = {
  realized: number;
  remainingCost: number;
  tokens: number;
  trades: number;
  first: number;
  last: number;
};

export function useTopTraders(launches: LaunchSummary[], enabled: boolean, limit = 15, pollMs = 30_000) {
  // The scans are incremental and cached per launch; this tick just marks "new data landed".
  const [tick, setTick] = useState(0);
  const [scanning, setScanning] = useState(false);

  const launchKey = launches.map((l) => l.address.toLowerCase()).join(",");

  useEffect(() => {
    if (!enabled || launches.length === 0) return;
    let stopped = false;
    const scan = async () => {
      setScanning(true);
      try {
        for (const address of launchKey.split(",")) {
          if (stopped) return;
          try {
            const price = await fetchLaunchCollateralPriceUsd(address);
            await fetchLaunchStats(address, price, null);
          } catch {
            // one unscannable coin must not hide the rest of the leaderboard
          }
        }
      } finally {
        if (!stopped) {
          setScanning(false);
          setTick((t) => t + 1);
        }
      }
    };
    void scan();
    const id = setInterval(scan, pollMs);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, launchKey, pollMs]);

  return useMemo(() => {
    void tick;
    // trader -> launch -> book. Per-launch books, because one trader's tokens on coin A must be
    // valued at coin A's price, never averaged across coins.
    const traders = new Map<string, Map<string, LaunchBook>>();
    const prices = new Map<string, number>(); // launch -> last traded price, USD per token

    for (const launch of launches) {
      const launchAddr = launch.address.toLowerCase();
      const pts = tradesFor(launch.address).filter(isTrade);
      if (pts.length === 0) continue;

      let price = 0;
      for (const t of pts) {
        const p = t.tokenAmount > 0 ? t.volumeUsd / t.tokenAmount : 0;
        if (p > 0) price = p;
      }
      prices.set(launchAddr, price);

      const byTrader = new Map<string, typeof pts>();
      for (const t of pts) {
        const arr = byTrader.get(t.trader);
        if (arr) arr.push(t);
        else byTrader.set(t.trader, [t]);
      }

      for (const [trader, tps] of byTrader) {
        let books = traders.get(trader);
        if (!books) {
          books = new Map();
          traders.set(trader, books);
        }
        const book: LaunchBook =
          books.get(launchAddr) ?? { realized: 0, remainingCost: 0, tokens: 0, trades: 0, first: Infinity, last: 0 };
        const lots: { tokens: number; price: number }[] = [];
        for (const t of [...tps].sort((a, b) => a.ts - b.ts)) {
          book.trades++;
          book.first = Math.min(book.first, t.ts);
          book.last = Math.max(book.last, t.ts);
          const p = t.tokenAmount > 0 ? t.volumeUsd / t.tokenAmount : 0;
          if (t.isBuy) {
            lots.push({ tokens: t.tokenAmount, price: p });
          } else {
            let rem = t.tokenAmount;
            while (rem > TOKEN_EPS && lots.length > 0) {
              const lot = lots[0];
              const take = Math.min(rem, lot.tokens);
              book.realized += (p - lot.price) * take;
              lot.tokens -= take;
              rem -= take;
              if (lot.tokens <= TOKEN_EPS) lots.shift();
            }
            // Accepted edge (same as the profile FIFO): transfers in/out are invisible to this
            // log, so a transferred-in token sells as pure profit and a transferred-out one
            // leaves phantom cost basis in the remaining lots.
            if (rem > TOKEN_EPS) book.realized += p * rem; // sold tokens with no logged buy
          }
        }
        book.tokens = lots.reduce((s, l) => s + l.tokens, 0);
        book.remainingCost = lots.reduce((s, l) => s + l.tokens * l.price, 0);
        books.set(launchAddr, book);
      }
    }

    const rows: TopTraderRow[] = [];
    for (const [address, books] of traders) {
      let realized = 0;
      let unrealized = 0;
      let trades = 0;
      let first: number | null = null;
      let last: number | null = null;
      for (const [launchAddr, b] of books) {
        realized += b.realized;
        unrealized += b.tokens * (prices.get(launchAddr) ?? 0) - b.remainingCost;
        trades += b.trades;
        if (Number.isFinite(b.first)) first = first === null ? b.first : Math.min(first, b.first);
        last = last === null ? b.last : Math.max(last, b.last);
      }
      rows.push({ address, profit: realized + unrealized, realized, unrealized, trades, firstTs: first, lastTs: last });
    }

    rows.sort((a, b) => b.profit - a.profit || b.trades - a.trades);
    return { rows: rows.slice(0, limit), scanning, total: rows.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, launchKey, limit]);
}
