import { Interface, type ContractTransactionReceipt, type ContractTransactionResponse, type ContractRunner } from "ethers";
import { LAUNCHPAD_FACTORY_ABI } from "./abis.js";
import { contractWith } from "./contract.js";
import { previewCreatorBuy, TOTAL_FEE_BPS } from "./curve.js";
import type { LeveraSDK } from "./sdk.js";
import type { QuoteLaunchpad } from "./deployment.js";

type Overrides = Record<string, unknown>;

/// Every LaunchpadFactory method the SDK calls, typed against LaunchpadFactory.sol.
type FactoryMethods = {
  launchCount(): Promise<bigint>;
  allLaunches(index: bigint): Promise<string>;
  getLaunchesByCreator(creator: string): Promise<string[]>;
  minRaise(): Promise<bigint>;
  creatorBuyCapBps(): Promise<bigint>;
  collateralToken(): Promise<string>;
  createLaunch(
    name: string,
    symbol: string,
    targetRaise: bigint,
    creatorFeeInHfyc: boolean,
    leverageEnabled: boolean,
    creatorBuyIn: bigint,
    creatorMinTokensOut: bigint,
    overrides?: Overrides
  ): Promise<ContractTransactionResponse>;
};

/// Flat launch fee every createLaunch must pay, in ETH wei — mirrors
/// LaunchpadFactory.LAUNCH_FEE. Keep in sync with the contract constant.
export const LAUNCH_FEE_WEI = 500_000_000_000_000n; // 0.0005 ETH

export type CreateLaunchParams = {
  name: string;
  symbol: string;
  /// Raise cap in the pad's quote asset's own units (NOT WAD): parse with the quote's decimals,
  /// e.g. parseUnits("6.9", 18) for WETH or parseUnits("6.9", 8) for cbBTC. Must clear the pad's
  /// `minRaise` (a tenth of a whole quote token).
  targetRaise: bigint;
  /// Pair against LYC at 2x on graduation. False = a normal 1x market that never pulls senior.
  /// Default true.
  leverageEnabled?: boolean;
  /// Creator's 0.30% paid in LYC (true) or claimable in the coin's quote asset (false, default).
  /// Only valid with leverageEnabled — a 1x coin never pairs, so paying its creator LYC would
  /// mint senior without occupancy behind it; the contract reverts, and so do we, earlier.
  creatorFeeInHfyc?: boolean;
  /// Creator's own first buy, executed by the factory inside createLaunch so the
  /// creatorBuyCapBps cap is unconditional. The factory pulls the quote from the creator, so
  /// this needs an approval to the FACTORY.
  devBuy?: { quoteIn: bigint; minTokensOut?: bigint };
  overrides?: Record<string, unknown>;
};

export type CreateLaunchResult = {
  hash: string;
  receipt: ContractTransactionReceipt;
  launchAddress: string;
  devBuyTokensOut: bigint | null;
};

/// One launchpad = one quote asset. A creator picks their quote asset by picking the launchpad,
/// and the coin is bound to that pad's factory, oracle and router for life.
export class Launchpad {
  readonly sdk: LeveraSDK;
  readonly pad: QuoteLaunchpad;
  readonly address: string;
  readonly contract: FactoryMethods;

  constructor(sdk: LeveraSDK, pad: QuoteLaunchpad, runner?: ContractRunner) {
    this.sdk = sdk;
    this.pad = pad;
    this.address = pad.factory;
    this.contract = contractWith<FactoryMethods>(pad.factory, LAUNCHPAD_FACTORY_ABI, runner ?? sdk.runner);
  }

  private requireSigner(): void {
    if (!this.sdk.signer) {
      throw new Error("Launchpad writes need a signer — call sdk.connect(signer) first");
    }
  }

  async launchCount(): Promise<bigint> {
    return (await this.contract.launchCount()) as bigint;
  }

  /// Every launch this pad has minted, oldest first. One wave of parallel calls, not a chain —
  /// the calls are independent and a ~0.4s testnet RPC makes N sequential round trips seconds.
  async launchAddresses(): Promise<string[]> {
    const count = Number(await this.launchCount());
    const indices = Array.from({ length: count }, (_, i) => BigInt(i));
    return (await Promise.all(indices.map((i) => this.contract.allLaunches(i)))) as string[];
  }

  async launchSummaries() {
    const addresses = await this.launchAddresses();
    return Promise.all(addresses.map((a) => this.sdk.launch(a).summary()));
  }

  async launchesByCreator(creator: string): Promise<string[]> {
    return (await this.contract.getLaunchesByCreator(creator)) as string[];
  }

  /// Pad constants worth knowing before creating: the raise floor and the dev-buy cap.
  async meta(): Promise<{ minRaise: bigint; creatorBuyCapBps: bigint; collateralToken: string }> {
    const [minRaise, creatorBuyCapBps, collateralToken] = await Promise.all([
      this.contract.minRaise(),
      this.contract.creatorBuyCapBps(),
      this.contract.collateralToken(),
    ]);
    return { minRaise, creatorBuyCapBps, collateralToken };
  }

  /// What a dev buy of `devBuyQuote` would get on a fresh curve with this raise target, checked
  /// against the pad's live creator cap. Use this to validate BEFORE submitting — the factory's
  /// "creator cap" revert should not be the first the creator hears of a problem.
  async previewCreatorBuy(targetRaise: bigint, devBuyQuote: bigint) {
    const { creatorBuyCapBps } = await this.meta();
    // Same Launch constant on every pad; TOTAL_FEE_BPS lives on Launch, and pre-launch there is
    // no launch to read it off yet.
    return previewCreatorBuy(targetRaise, devBuyQuote, creatorBuyCapBps, TOTAL_FEE_BPS);
  }

  /// Mint a coin. The dev buy is pulled by the FACTORY (which is what makes the 20% cap
  /// unconditional rather than a race the creator could win), so the approval target is the
  /// factory — not the not-yet-existing launch.
  async createLaunch(params: CreateLaunchParams): Promise<CreateLaunchResult> {
    this.requireSigner();
    const signer = this.sdk.signer!;
    const owner = await signer.getAddress();

    const leverageEnabled = params.leverageEnabled !== false;
    const creatorFeeInHfyc = params.creatorFeeInHfyc === true;
    if (creatorFeeInHfyc && !leverageEnabled) {
      throw new Error("creatorFeeInHfyc requires leverageEnabled — a 1x coin pays its creator in the quote asset");
    }

    const devBuy = params.devBuy?.quoteIn ?? 0n;
    const devBuyMinOut = params.devBuy?.minTokensOut ?? 0n;
    if (devBuy > 0n) {
      await this.sdk.token(this.pad.collateralToken).ensureApproval(owner, this.address, devBuy);
    }

    // creatorMinTokensOut = 0 by default: this is the creator's own transaction against a curve
    // initialized in the SAME call — no other trade can land between init and this buy to move
    // the price, so the creator cap is what actually bounds the fill, not a slippage floor.
    // The 0.0005 ETH launch fee rides on the creation transaction; the SDK's Overrides type
    // carries it (`value`). Merge AFTER user overrides so the fee cannot be dropped by accident.
    const overrides = { value: LAUNCH_FEE_WEI, ...(params.overrides ?? {}) };
    const tx = await this.contract.createLaunch(
      params.name,
      params.symbol,
      params.targetRaise,
      creatorFeeInHfyc,
      leverageEnabled,
      devBuy,
      devBuyMinOut,
      overrides
    );
    const receipt = (await tx.wait())!;

    const iface = new Interface(LAUNCHPAD_FACTORY_ABI as unknown as readonly string[]);
    let launch: string | null = null;
    let devBuyTokensOut: bigint | null = null;
    for (const log of receipt.logs) {
      let parsed: ReturnType<Interface["parseLog"]> | null = null;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed?.name === "LaunchCreated") launch = parsed.args["launch"] as string;
      if (parsed?.name === "CreatorDevBuy") devBuyTokensOut = parsed.args["tokensOut"] as bigint;
    }
    if (!launch) {
      throw new Error("launch created but no LaunchCreated event was found in the receipt");
    }
    return { hash: receipt.hash, receipt, launchAddress: launch, devBuyTokensOut };
  }
}
