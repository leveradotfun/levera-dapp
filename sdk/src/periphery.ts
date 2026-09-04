import { Interface, type ContractTransactionReceipt, type ContractTransactionResponse, type ContractRunner } from "ethers";
import { QUOTE_ZAP_ABI, SWAP_EVENT_ABI, SWAP_ROUTER_ABI } from "./abis.js";
import { contractWith } from "./contract.js";
import type { LeveraSDK } from "./sdk.js";

type Overrides = Record<string, unknown>;

type ZapMethods = {
  weth(): Promise<string>;
  buyWithEth(launch: string, minTokensOut: bigint, overrides?: Overrides): Promise<ContractTransactionResponse>;
  sellForEth(launch: string, tokensIn: bigint, minEthOut: bigint, overrides?: Overrides): Promise<ContractTransactionResponse>;
};

/// Native ETH in and out of a WETH-quoted launch, in one transaction. Holds nothing between
/// calls and has no privileged role — every function pulls, converts, forwards and settles in
/// the same tx. Only works on WETH-quoted launches; a cbBTC-quoted coin is traded directly.
export class QuoteZap {
  readonly sdk: LeveraSDK;
  readonly address: string;
  private cached?: { runner: unknown; contract: ZapMethods };

  constructor(sdk: LeveraSDK) {
    this.sdk = sdk;
    this.address = sdk.deployment.quoteZap!;
  }

  /// One Contract instance per connected runner — the zap is called with the signer, while the
  /// SDK it hangs off may have been constructed read-only.
  contract(): ZapMethods {
    const runner = this.sdk.runner;
    if (this.cached?.runner === runner) return this.cached.contract;
    const fresh = contractWith<ZapMethods>(this.address, QUOTE_ZAP_ABI, runner);
    this.cached = { runner, contract: fresh };
    return fresh;
  }
}

type RouterMethods = {
  collateral(): Promise<string>;
  usdg(): Promise<string>;
  swapUsdgForCollateral(usdgIn: bigint, minCollateralOut: bigint, overrides?: Overrides): Promise<ContractTransactionResponse>;
  swapCollateralForUsdg(collateralIn: bigint, minUsdgOut: bigint, overrides?: Overrides): Promise<ContractTransactionResponse>;
};

/// The oracle-priced swap router for one quote asset. Fills from inventory and mints only the
/// shortfall (role-gated to the deployed routers), so there is no inventory to pre-fund and no
/// AMM to bootstrap.
export class SwapRouter {
  readonly sdk: LeveraSDK;
  readonly address: string;
  readonly collateralToken: string;
  readonly contract: RouterMethods;

  constructor(sdk: LeveraSDK, routerAddress: string, collateralToken: string, runner?: ContractRunner) {
    this.sdk = sdk;
    this.address = routerAddress;
    this.collateralToken = collateralToken;
    this.contract = contractWith<RouterMethods>(routerAddress, SWAP_ROUTER_ABI, runner ?? sdk.runner);
  }

  private requireSigner(): void {
    if (!this.sdk.signer) {
      throw new Error("SwapRouter writes need a signer — call sdk.connect(signer) first");
    }
  }

  /// USDG → quote asset. Handles the USDG approval. The filled amount is only available from
  /// the Swap event — a state-changing call yields a receipt, not the uint256 it returns.
  async swapUsdgForCollateral(
    usdgIn: bigint,
    minCollateralOut: bigint | undefined,
    slippageBps = 100n,
    overrides: Record<string, unknown> = {}
  ): Promise<{ hash: string; receipt: ContractTransactionReceipt | null; collateralOut: bigint }> {
    this.requireSigner();
    const owner = await this.sdk.signer!.getAddress();
    await this.sdk.token(this.sdk.deployment.usdg).ensureApproval(owner, this.address, usdgIn);
    const minOut = minCollateralOut ?? 0n;
    const tx = await this.contract.swapUsdgForCollateral(usdgIn, minOut, overrides);
    const receipt = await tx.wait();
    return { hash: tx.hash, receipt, collateralOut: this.parseSwapOut(receipt, minOut, slippageBps) };
  }

  /// Quote asset → USDG. Handles the collateral approval.
  async swapCollateralForUsdg(
    collateralIn: bigint,
    minUsdgOut: bigint | undefined,
    slippageBps = 100n,
    overrides: Record<string, unknown> = {}
  ): Promise<{ hash: string; receipt: ContractTransactionReceipt | null; usdgOut: bigint }> {
    this.requireSigner();
    const owner = await this.sdk.signer!.getAddress();
    await this.sdk.token(this.collateralToken).ensureApproval(owner, this.address, collateralIn);
    const minOut = minUsdgOut ?? 0n;
    const tx = await this.contract.swapCollateralForUsdg(collateralIn, minOut, overrides);
    const receipt = await tx.wait();
    return { hash: tx.hash, receipt, usdgOut: this.parseSwapOut(receipt, minOut, slippageBps) };
  }

  private parseSwapOut(
    receipt: ContractTransactionReceipt | null,
    minOut: bigint,
    slippageBps: bigint
  ): bigint {
    if (!receipt) return 0n;
    const iface = new Interface(SWAP_EVENT_ABI as unknown as readonly string[]);
    for (const log of receipt.logs) {
      let parsed: ReturnType<Interface["parseLog"]> | null = null;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed?.name === "Swap") return parsed.args["amountOut"] as bigint;
    }
    // No event: the caller set an explicit floor — report the floor rather than fabricate a
    // number better than it (or reading the swap as 0).
    if (minOut > 0n) return minOut;
    throw new Error("swap mined but no Swap event was found in the receipt");
  }
}
