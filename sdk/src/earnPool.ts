import { Interface, type ContractTransactionReceipt, type ContractTransactionResponse, type ContractRunner } from "ethers";
import { EARN_POOL_ABI } from "./abis.js";
import { contractWith } from "./contract.js";
import type { LeveraSDK } from "./sdk.js";

type Overrides = Record<string, unknown>;

/// Every EarnPool method the SDK calls, typed against EarnPool.sol.
type EarnPoolMethods = {
  balanceOf(owner: string): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  mintWithUsdg(usdAmount: bigint, overrides?: Overrides): Promise<ContractTransactionResponse>;
  mintWithEth(overrides?: Overrides): Promise<ContractTransactionResponse>;
  redeem(shares: bigint, overrides?: Overrides): Promise<ContractTransactionResponse>;
  unlockedBalanceOf(user: string): Promise<bigint>;
  maxRedeemableShares(holder: string): Promise<bigint>;
  nav(): Promise<bigint>;
  utilizationWad(): Promise<bigint>;
  fundingRateWad(): Promise<bigint>;
  globalCr(): Promise<bigint>;
  totalAssetsUsd(): Promise<bigint>;
  collateralPriceUsd(): Promise<bigint>;
  oracleLive(): Promise<boolean>;
  earnPoolApyWad(): Promise<bigint>;
  poolCount(): Promise<bigint>;
  collateralCount(): Promise<bigint>;
};

export type EarnPoolStats = {
  navUsd: bigint;
  utilizationWad: bigint;
  fundingRateWad: bigint;
  globalCrWad: bigint;
  totalAssetsUsd: bigint;
  collateralPriceUsd: bigint;
  oracleLive: boolean;
  apyWad: bigint;
  poolCount: bigint;
  collateralCount: bigint;
};

/// The Earn Pool: USDG / native ETH in, LYC shares out, senior capital to graduated launches.
/// Shares are an ERC-20 ("Levera Yield Coin", LYC) — transferable, 18 decimals.
export class EarnPool {
  readonly sdk: LeveraSDK;
  readonly address: string;
  readonly contract: EarnPoolMethods;

  constructor(sdk: LeveraSDK, runner?: ContractRunner) {
    this.sdk = sdk;
    this.address = sdk.deployment.lyc;
    this.contract = contractWith<EarnPoolMethods>(this.address, EARN_POOL_ABI, runner ?? sdk.runner);
  }

  private requireSigner(): void {
    if (!this.sdk.signer) {
      throw new Error("EarnPool writes need a signer — call sdk.connect(signer) first");
    }
  }

  // ---- user flows ----

  /// Mint LYC shares with native ETH. Payable — the value IS the deposit.
  async mintWithEth(value: bigint, overrides: Overrides = {}): Promise<{
    hash: string;
    receipt: ContractTransactionReceipt | null;
    sharesOut: bigint;
  }> {
    this.requireSigner();
    const tx = await this.contract.mintWithEth({ ...overrides, value });
    const receipt = await tx.wait();
    return { hash: tx.hash, receipt, sharesOut: this.parseMint(receipt) };
  }

  /// Mint LYC shares with USDG. Handles the approval to the pool.
  async mintWithUsdg(
    usdAmount: bigint,
    overrides: Overrides = {}
  ): Promise<{ hash: string; receipt: ContractTransactionReceipt | null; sharesOut: bigint }> {
    this.requireSigner();
    const owner = await this.sdk.signer!.getAddress();
    await this.sdk.token(this.sdk.deployment.usdg).ensureApproval(owner, this.address, usdAmount);
    const tx = await this.contract.mintWithUsdg(usdAmount, overrides);
    const receipt = await tx.wait();
    return { hash: tx.hash, receipt, sharesOut: this.parseMint(receipt) };
  }

  /// Redeem LYC shares back to USDG (plus WETH when the book holds it). A redemption leaves
  /// REDEEM_FEE_BPS (25 bps) behind, unminted; under full cover the payout is partially in
  /// reserve ETH and `covered` is false.
  async redeem(shares: bigint, overrides: Overrides = {}): Promise<{
    hash: string;
    receipt: ContractTransactionReceipt | null;
    usdgOut: bigint;
  }> {
    this.requireSigner();
    const tx = await this.contract.redeem(shares, overrides);
    const receipt = await tx.wait();
    let usdgOut = 0n;
    if (receipt) {
      const iface = new Interface(EARN_POOL_ABI as unknown as readonly string[]);
      for (const log of receipt.logs) {
        let parsed: ReturnType<Interface["parseLog"]> | null = null;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue;
        }
        if (parsed?.name === "Redeemed") {
          usdgOut = parsed.args["usdgOut"] as bigint;
          break;
        }
      }
    }
    return { hash: tx.hash, receipt, usdgOut };
  }

  private parseMint(receipt: ContractTransactionReceipt | null): bigint {
    if (!receipt) return 0n;
    const iface = new Interface(EARN_POOL_ABI as unknown as readonly string[]);
    for (const log of receipt.logs) {
      let parsed: ReturnType<Interface["parseLog"]> | null = null;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed?.name === "Minted") return parsed.args["hfycOut"] as bigint;
    }
    return 0n;
  }

  // ---- reads ----

  async balanceOf(owner: string): Promise<bigint> {
    return (await this.contract.balanceOf(owner)) as bigint;
  }

  /// Shares that have passed the deposit lock — the redeemable part of the balance.
  async unlockedBalanceOf(owner: string): Promise<bigint> {
    return (await this.contract.unlockedBalanceOf(owner)) as bigint;
  }

  /// The most `redeem(shares)` can accept right now (bounded by idle cash under low cover).
  async maxRedeemableShares(owner: string): Promise<bigint> {
    return (await this.contract.maxRedeemableShares(owner)) as bigint;
  }

  /// The whole book in one round of parallel reads.
  async stats(): Promise<EarnPoolStats> {
    const [nav, utilizationWad, fundingRateWad, globalCrWad, totalAssetsUsd, collateralPriceUsd, oracleLive, apyWad, poolCount, collateralCount] =
      await Promise.all([
        this.contract.nav(),
        this.contract.utilizationWad(),
        this.contract.fundingRateWad(),
        this.contract.globalCr(),
        this.contract.totalAssetsUsd(),
        this.contract.collateralPriceUsd(),
        this.contract.oracleLive(),
        this.contract.earnPoolApyWad(),
        this.contract.poolCount(),
        this.contract.collateralCount(),
      ]);
    return {
      navUsd: nav,
      utilizationWad,
      fundingRateWad,
      globalCrWad,
      totalAssetsUsd,
      collateralPriceUsd,
      oracleLive,
      apyWad,
      poolCount,
      collateralCount,
    };
  }
}
