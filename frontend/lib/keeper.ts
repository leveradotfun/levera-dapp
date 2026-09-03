"use client";

import { useEffect, useRef } from "react";
import { DeployedAddresses } from "./chain";
import { TARGETING_TESTNET } from "./chains";
import {
  fetchLaunchAddresses,
  getLaunch,
  getProvider,
  getHFyc,
  keeperAccruePools,
  keeperGraduate,
  keeperHarvest,
  keeperProtect,
  keeperReallocate,
  keeperRebalanceToReserve,
  keeperTryPair,
  keeperTryPairUpTo,
  allFactories,
} from "./launchpad";

const POLL_MS = 1_000;
const UPPER_L = 25n * 10n ** 17n;
const LOWER_L = 15n * 10n ** 17n;
const MAX_BAND_STEPS = 6;

type Snap = {
  addr: string;
  leverageEnabled: boolean;
  graduated: boolean;
  paired: boolean;
  gap: bigint;
  senior: bigint;
  vol: bigint;
  lev: bigint;
  harvestableEth: bigint;
};

/// Graduate, attach idle toward 2x, peel quiet coins into loud ones when idle is empty, and
/// actively walk coins back into [1.5, 2.5]: protect() while L ≥ 2.5 (each call is capped at
/// 15% of vault ETH), relever() while L ≤ 1.5 with banked idle USDG. Volume ranking is on-chain
/// (1-day decaying notional).
export function useProtocolKeeper(addresses: DeployedAddresses | null) {
  const busyRef = useRef(false);

  useEffect(() => {
    if (!addresses || TARGETING_TESTNET) return;
    let stopped = false;

    async function snapshot(addr: string): Promise<Snap & { raiseMet: boolean }> {
      const launch = getLaunch(addr, getProvider());
      const [graduated, leverageEnabled, realEthRaised, targetRaiseEth, paired, gap, senior, vol, lev, holderFee, protocolFee, creatorFee, creatorInHfyc] =
        await Promise.all([
          launch.graduated() as Promise<boolean>,
          launch.leverageEnabled() as Promise<boolean>,
          launch.realEthRaised() as Promise<bigint>,
          launch.targetRaiseEth() as Promise<bigint>,
          launch.paired() as Promise<boolean>,
          launch.seniorGapUsd() as Promise<bigint>,
          launch.seniorUsd() as Promise<bigint>,
          launch.recentVolumeUsd() as Promise<bigint>,
          launch.leverageWad() as Promise<bigint>,
          // Renamed from *FeeEth to *FeeQuote when multi-collateral landed (fees are not always
          // literally ETH -- a cbBTC coin books cbBTC). holderFeeQuote is HFyc's leverage-scaled
          // trading-fee slice (up to 5 of the 50 bps remainder, scaled by seniorUsd/memeNAV on
          // this pool) -- real again as of the 50/45/5 fee redesign.
          launch.holderFeeQuote() as Promise<bigint>,
          launch.protocolFeeQuote() as Promise<bigint>,
          launch.creatorFeeQuote() as Promise<bigint>,
          launch.creatorFeeInHfyc() as Promise<boolean>,
        ]);
      const harvestableEth = holderFee + protocolFee + (creatorInHfyc ? creatorFee : 0n);
      return {
        addr,
        leverageEnabled,
        graduated,
        paired,
        gap,
        senior,
        vol,
        lev,
        harvestableEth,
        raiseMet: !graduated && realEthRaised >= targetRaiseEth,
      };
    }

    /// Rebalancing itself is filled by whoever wants the trade, at a price the pool posts. A
    /// public app should not be quietly acting as that counterparty on a visitor's behalf, and it
    /// has no capital to do it with anyway.
    ///
    /// What a keeper can still do unilaterally is the two moves that trade nothing: sweeping a
    /// pool whose junior is gone, and correcting which bucket the collateral sits in so the price
    /// the AMM quotes stays reachable by a seller.
    async function sweepAndCorrect(addr: string) {
      try {
        await keeperRebalanceToReserve(addr);
      } catch {
        // no excess above the senior claim, which is the normal case
      }
      try {
        await keeperProtect(addr); // orphans only: reverts while a junior still exists
      } catch {
        // junior alive, or the venue cannot clear right now. Neither blocks anything.
      }
    }

    async function tick() {
      if (busyRef.current || stopped || !addresses) return;
      busyRef.current = true;
      try {
        const addrs = (await Promise.all(allFactories(addresses).map((f) => fetchLaunchAddresses(f)))).flat();
        const snaps: Snap[] = [];
        const raiseMet: string[] = [];
        const reads = await Promise.all(
          addrs.map(async (addr) => {
            try {
              return await snapshot(addr);
            } catch {
              return null;
            }
          }),
        );
        for (const row of reads) {
          if (!row) continue;
          if (row.raiseMet) raiseMet.push(row.addr);
          snaps.push(row);
        }
        for (const addr of raiseMet) {
          if (stopped) break;
          try {
            await keeperGraduate(addr);
          } catch {
            // already graduated or pool contended
          }
        }

        const hungry = snaps
          .filter((s) => s.leverageEnabled && s.graduated && s.gap > 0n)
          .sort((a, b) => (a.vol < b.vol ? 1 : a.vol > b.vol ? -1 : 0));
        const fat = snaps
          .filter((s) => s.leverageEnabled && s.graduated && s.senior > 0n)
          .sort((a, b) => (a.vol < b.vol ? -1 : a.vol > b.vol ? 1 : 0));

        // Split idle across hungry 2x coins so one graduate does not swallow the whole deposit.
        let idle = 0n;
        try {
          idle = (await getHFyc(addresses.hfyc).idleUsdg()) as bigint;
        } catch {
          idle = 0n;
        }
        const paired = snaps.filter((s) => s.leverageEnabled && s.graduated && s.senior > 0n).map((s) => s.addr);
        if (paired.length > 0) {
          try {
            await keeperAccruePools(addresses.hfyc, paired);
          } catch {
            // views still include pending occupancy; this is a best-effort settle
          }
        }

        // Holder 50 bps of every trade sits as ETH on the launch until harvest(). It is not in
        // TVL and not in HFyc cash yield — without this tick, that slice never reaches holders.
        for (const s of snaps) {
          if (stopped) break;
          if (s.harvestableEth > 0n) {
            try {
              await keeperHarvest(s.addr);
            } catch {
              // empty between read and send, or swap failed
            }
          }
        }

        // The two moves that trade nothing, on every paired coin: correct which bucket the
        // collateral sits in, and sweep a pool whose junior is gone. Actual rebalancing is a
        // posted route somebody else fills — see the Rebalance routes page.
        for (const s of snaps) {
          if (stopped) break;
          if (s.paired) await sweepAndCorrect(s.addr);
        }
        try {
          idle = (await getHFyc(addresses.hfyc).idleUsdg()) as bigint;
        } catch {
          // keep last read
        }

        const slice = hungry.length > 0 && idle > 0n ? idle / BigInt(hungry.length) : 0n;
        for (const h of hungry) {
          if (stopped) break;
          try {
            if (slice > 0n) await keeperTryPairUpTo(h.addr, slice);
            else await keeperTryPair(h.addr);
          } catch {
            continue;
          }
        }

        // Scarce book: one peel per tick from the quietest fat coin onto the loudest hungry coin.
        const dst = hungry[0];
        const src = fat.find((f) => dst && f.addr !== dst.addr && f.vol < dst.vol && f.senior > 0n);
        if (dst && src) {
          try {
            await keeperReallocate(dst.addr, src.addr, dst.gap);
          } catch {
            // volume ranking moved, or swap slippage
          }
        }
      } catch {
        // factory unread
      } finally {
        busyRef.current = false;
      }
    }

    void tick();
    const a = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(a);
    };
  }, [addresses]);
}
