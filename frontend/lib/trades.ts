"use client";

import { useCallback, useEffect, useState } from "react";
import { DeployedAddresses } from "./chain";
import { TARGETING_TESTNET } from "./chains";
import { fetchLaunchCollateralPriceUsd } from "./launchpad";
import { fetchLaunchStats, tradesFor } from "./launchStats";

export interface Trade {
  signature: string;
  type: "buy" | "sell" | "rebalance";
  account: string;
  /// The trade's quote (collateral) leg -- what actually moved on-chain, in whole quote tokens
  /// (ETH for a WETH coin, cbBTC for a cbBTC one).
  amount: number;
  /// The same trade valued in USD. Kept alongside `amount` rather than replacing it because the
  /// trades table quotes the native leg while the stats panel quotes dollars, and conflating the
  /// two is what produced "$98 buy vol" for a figure that was really 98 ETH.
  amountUsd: number;
  tokenAmount: number;
  timestamp: number;
  /// Rebalance-specific fields
  /// Rebalance only: USD skimmed from the pool into the loop.
  skimmedUsd?: number;
  newLoopLev?: number;
  /// Rebalance sub-type
  rebalanceType?: "protect" | "relever" | "release" | "paired";
}

/// Trade history for a launch, read from the shared scan in lib/launchStats.ts.
///
/// This used to run its own queryFilter sweep with a sequential getBlock per event -- a second full
/// copy of the scan the coin table was already doing, uncached, repeated on every mount. Reading
/// the cached log instead means opening a coin page costs nothing extra, and the two views can no
/// longer disagree about what a coin's trades were.
export function useTradeHistory(launchAddress: string | null, addresses: DeployedAddresses | null) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!launchAddress) {
      setTrades([]);
      return;
    }
    let stopped = false;
    setLoading(true);

    async function load() {
      try {
        if (addresses) {
          // The launch's own oracle mark, not the global ETH one -- a cbBTC coin's trades are
          // priced and valued off the cbBTC feed.
          const price = await fetchLaunchCollateralPriceUsd(launchAddress!);
          await fetchLaunchStats(launchAddress!, price, null);
        }
        if (stopped) return;
        const points = tradesFor(launchAddress!);
        setTrades(
          points
            .map((p) => ({
              signature: p.tx,
              type: p.type,
              account: p.trader,
              amount: p.collateral,
              amountUsd: p.volumeUsd,
              tokenAmount: p.tokenAmount,
              timestamp: p.ts,
              skimmedUsd: p.skimmedUsd,
              newLoopLev: p.newLoopLev,
              rebalanceType: p.rebalanceType,
            }))
            .sort((a, b) => b.timestamp - a.timestamp)
        );
      } catch (err) {
        console.error("Failed to read trade history:", err);
      } finally {
        if (!stopped) setLoading(false);
      }
    }

    load();
    const id = setInterval(load, TARGETING_TESTNET ? 30_000 : 5_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [launchAddress, addresses, refreshKey]);

  return { trades, loading, refresh };
}
