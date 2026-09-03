import { getLyc, getLaunch, getProvider, tryPairLaunch } from "./launchpad";

export type LeverageBand = {
  achieved: number;
  target: number;
  low: number;
  high: number;
  status: "in-band" | "below" | "above" | "unpaired";
  tripped: boolean;
  paired: boolean;
  leverageEnabled: boolean;
  juniorUsd: bigint;
  seniorUsd: bigint;
  idleUsdg: bigint;
  occupancyPaidUsd: bigint;
  pairingFeesPaidUsd: bigint;
};

/// Per-coin leverage: L_i = TVL_i / junior_i. Each launch is its own pool. LYC is a shared
/// cash book — pairing pulls idle USDG equal to that coin's junior USD, it does not average
/// leverage across coins.
export async function fetchLeverageBand(launchAddress: string): Promise<LeverageBand | null> {
  const launch = getLaunch(launchAddress, getProvider());
  try {
    const graduated: boolean = await launch.graduated();
    if (!graduated) return null;

    const [paired, leverageEnabled, leverageWad, tvlUsd, seniorUsd, lycAddr, occupancyPaidUsd, pairingFeesPaidUsd] =
      (await Promise.all([
        launch.paired(),
        launch.leverageEnabled(),
        launch.leverageWad(),
        launch.tvlUsd(),
        launch.seniorUsd(),
        launch.earn(),
        launch.occupancyPaidUsd(),
        launch.pairingFeesPaidUsd(),
      ])) as [boolean, boolean, bigint, bigint, bigint, string, bigint, bigint];

    const idleUsdg: bigint = await getLyc(lycAddr).idleUsdg();
    const juniorUsd = tvlUsd > seniorUsd ? tvlUsd - seniorUsd : 0n;

    const target = 2.0;
    const low = 1.5;
    const high = 2.5;

    if (!paired) {
      return {
        achieved: 1,
        target,
        low,
        high,
        status: "unpaired",
        tripped: leverageEnabled,
        paired: false,
        leverageEnabled,
        juniorUsd,
        seniorUsd,
        idleUsdg,
        occupancyPaidUsd,
        pairingFeesPaidUsd,
      };
    }

    // Wiped junior reports uint256 max. Anything beyond 100x is "infinite" for the bar.
    const achieved = leverageWad > 100n * 10n ** 18n ? Infinity : Number(leverageWad) / 1e18;
    return {
      achieved,
      target,
      low,
      high,
      status: achieved < low ? "below" : achieved > high ? "above" : "in-band",
      tripped: achieved >= high || achieved <= low,
      paired: true,
      leverageEnabled: true,
      juniorUsd,
      seniorUsd,
      idleUsdg,
      occupancyPaidUsd,
      pairingFeesPaidUsd,
    };
  } catch {
    return null;
  }
}

export async function pairLaunch(launchAddress: string) {
  return tryPairLaunch(launchAddress);
}
