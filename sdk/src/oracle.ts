import { PRICE_ORACLE_ABI } from "./abis.js";
import { contractWith } from "./contract.js";
import { WAD } from "./format.js";
import type { ContractRunner } from "ethers";

type OracleMethods = {
  price(): Promise<bigint>;
  conf(): Promise<bigint>;
  publishedAt(): Promise<bigint>;
  cashPrice(): Promise<bigint>;
  cashConf(): Promise<bigint>;
  cashPublishedAt(): Promise<bigint>;
};

/// Read side of `IPriceOracle` — the only price surface the protocol reads. Both
/// `MockPriceOracle` (testnet) and `ChainlinkPriceOracle` (live) satisfy it.
export class OracleReader {
  readonly contract: OracleMethods;
  readonly address: string;

  constructor(address: string, runner: ContractRunner) {
    this.address = address;
    this.contract = contractWith<OracleMethods>(address, PRICE_ORACLE_ABI, runner);
  }

  /// Collateral price in USD-WAD (1e18 = $1.00 per whole token).
  async collateralPriceUsd(): Promise<bigint> {
    return this.contract.price();
  }

  /// Cash (USDG) price in USD-WAD. Read rather than assumed so a depeg shows up in the cover
  /// ratio instead of hiding inside it.
  async cashPriceUsd(): Promise<bigint> {
    return this.contract.cashPrice();
  }

  /// The full mark with freshness, so callers can fail closed on staleness themselves.
  async quote(): Promise<{
    priceUsd: bigint;
    conf: bigint;
    publishedAt: bigint;
    cashPriceUsd: bigint;
    cashConf: bigint;
    cashPublishedAt: bigint;
  }> {
    const [price, conf, publishedAt, cashPrice, cashConf, cashPublishedAt] = await Promise.all([
      this.contract.price(),
      this.contract.conf(),
      this.contract.publishedAt(),
      this.contract.cashPrice(),
      this.contract.cashConf(),
      this.contract.cashPublishedAt(),
    ]);
    return { priceUsd: price, conf, publishedAt, cashPriceUsd: cashPrice, cashConf, cashPublishedAt };
  }
}

/// Seconds since the oracle's last publish. The protocol's own staleness guard lives on-chain
/// (OracleLib); this is for off-chain displays.
export async function oracleAgeSeconds(oracle: OracleReader, now?: number): Promise<number | null> {
  const publishedAt = Number(await oracle.contract.publishedAt());
  if (!publishedAt) return null;
  return Math.max(0, (now ?? Math.floor(Date.now() / 1000)) - publishedAt);
}

/// Quote amount → USD-WAD. `quoteScale` (10**(18 − quoteDecimals)) lifts the quote's own units
/// to WAD before the USD price applies — one without the other is off by orders of magnitude for
/// an 8-decimal quote like cbBTC.
export function quoteAmountToUsd(quoteAmount: bigint, quoteScale: bigint, collateralPriceUsd: bigint): bigint {
  return (quoteAmount * quoteScale * collateralPriceUsd) / WAD;
}

/// USD-WAD → quote amount, floored.
export function usdToQuoteAmount(usdWad: bigint, quoteScale: bigint, collateralPriceUsd: bigint): bigint {
  if (collateralPriceUsd === 0n) return 0n;
  return (usdWad * WAD) / (quoteScale * collateralPriceUsd);
}
