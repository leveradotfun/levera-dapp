import { Interface, type ContractTransactionReceipt, type ContractTransactionResponse, type ContractRunner } from "ethers";
import { LAUNCH_ABI } from "./abis.js";
import { contractWith } from "./contract.js";
import {
  curveBuyQuote,
  curveSellQuote,
  minOutFromQuote,
  poolBuyQuote,
  poolSellQuote,
  poolSpotPriceQuote,
  spotPriceQuote,
  TOTAL_SUPPLY_WAD,
  WAD,
  type CurveReserves,
  type PoolReserves,
} from "./curve.js";
import { quoteAmountToUsd } from "./oracle.js";
import type { LeveraSDK } from "./sdk.js";

/// Everything about a launch that is fixed at construction: its quote asset, that asset's scale,
/// its oracle and router, its creator. None of it can change for a given launch address, so it
/// is read once per SDK instance and cached.
export type LaunchMeta = {
  address: string;
  quote: string;
  /// 10 ** (18 − quoteDecimals) — the lift from the quote's own units to WAD (1 for WETH, 1e10
  /// for cbBTC). MUST multiply every quote amount before it meets a USD figure.
  quoteScale: bigint;
  quoteDecimals: number;
  quoteSymbol: string;
  priceOracle: string;
  swapRouter: string;
  earnPool: string;
  creator: string;
  leverageEnabled: boolean;
  /// The on-chain raise cap, in the quote asset's own units.
  targetRaise: bigint;
};

export type LaunchSummary = {
  address: string;
  name: string;
  symbol: string;
  meta: LaunchMeta;
  graduated: boolean;
  paired: boolean;
  raisedQuote: bigint;
  targetRaise: bigint;
  raisedUsd: bigint;
  targetUsd: bigint;
  /// 0–100, capped.
  pctToGraduation: number;
  /// Full-supply market cap (price × 1e9), priced on the launch's own oracle mark — NOT
  /// price × circulating, which on a bonding curve collapses to roughly the money raised.
  marketCapUsd: bigint;
  priceUsd: bigint;
  collateralPriceUsd: bigint;
  circulating: bigint;
  tvlUsd: bigint;
  reserveQuote: bigint;
  reserveToken: bigint;
  vaultQuote: bigint;
  seniorUsd: bigint;
  occupancyPaidUsd: bigint;
  pairingFeesPaidUsd: bigint;
};

export type TradeRoute = "curve" | "pool";

export type TradeResult = {
  hash: string;
  receipt: ContractTransactionReceipt;
  route: TradeRoute;
  /// Quote actually spent/received, from the fill event.
  quoteAmount: bigint;
  tokensIn: bigint | null;
  tokensOut: bigint | null;
  feeQuote: bigint;
};

export type BuyOptions = {
  /// Quote-asset amount to spend, in the quote's own units.
  amountIn: bigint;
  /// Slippage floor in tokens. When omitted, the SDK quotes live and applies `slippageBps`.
  minTokensOut?: bigint;
  /// Slippage tolerance in bps for the auto-quoted floor. Default 100 (1%).
  slippageBps?: bigint;
  /// Extra tx fields (gasLimit, …).
  overrides?: Record<string, unknown>;
};

export type SellOptions = Omit<BuyOptions, "amountIn" | "minTokensOut"> & {
  tokensIn: bigint;
  minQuoteOut?: bigint;
};

const GRADUATION_RACE = /curveclosed|already graduated/i;

type Overrides = Record<string, unknown>;
type TxOut = Promise<ContractTransactionResponse>;

/// Every Launch method the SDK calls, typed against Launch.sol.
type LaunchMethods = {
  // ERC-20 surface of the coin
  name(): Promise<string>;
  symbol(): Promise<string>;
  totalSupply(): Promise<bigint>;
  balanceOf(owner: string): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  // wiring
  quote(): Promise<string>;
  quoteScale(): Promise<bigint>;
  priceOracle(): Promise<string>;
  swapRouter(): Promise<string>;
  earn(): Promise<string>;
  creator(): Promise<string>;
  creatorFeeInHfyc(): Promise<boolean>;
  leverageEnabled(): Promise<boolean>;
  targetRaiseEth(): Promise<bigint>;
  // curve
  curveSellable(): Promise<bigint>;
  virtualTokens(): Promise<bigint>;
  virtualEth(): Promise<bigint>;
  curveK(): Promise<bigint>;
  realEthRaised(): Promise<bigint>;
  graduated(): Promise<boolean>;
  // amm / senior bookkeeping
  reserveEth(): Promise<bigint>;
  reserveToken(): Promise<bigint>;
  vaultEth(): Promise<bigint>;
  juniorEth(): Promise<bigint>;
  seniorUsd(): Promise<bigint>;
  paired(): Promise<boolean>;
  occupancyPaidUsd(): Promise<bigint>;
  pairingFeesPaidUsd(): Promise<bigint>;
  // supply, price, nav
  TOTAL_SUPPLY(): Promise<bigint>;
  TOTAL_FEE_BPS(): Promise<bigint>;
  circulating(): Promise<bigint>;
  priceUsd(): Promise<bigint>;
  tvlUsd(): Promise<bigint>;
  // fees
  creatorFeeQuote(): Promise<bigint>;
  lifetimeCreatorFeeQuote(): Promise<bigint>;
  // trading
  buy(amountIn: bigint, minTokensOut: bigint, overrides?: Overrides): TxOut;
  sell(tokensIn: bigint, minQuoteOut: bigint, overrides?: Overrides): TxOut;
  buyOnPool(quoteIn: bigint, minTokensOut: bigint, overrides?: Overrides): TxOut;
  sellOnPool(tokensIn: bigint, minQuoteOut: bigint, overrides?: Overrides): TxOut;
  // lifecycle
  graduate(overrides?: Overrides): TxOut;
  tryPair(overrides?: Overrides): TxOut;
  tryPairUpTo(maxUsd: bigint, overrides?: Overrides): TxOut;
  protect(overrides?: Overrides): TxOut;
  harvest(overrides?: Overrides): TxOut;
  accrueFunding(overrides?: Overrides): TxOut;
  rebalanceToReserve(overrides?: Overrides): TxOut;
  claimCreatorFees(overrides?: Overrides): TxOut;
};

/// One launched coin. Reads are available with a provider alone; every write needs
/// `sdk.connect(signer)`.
export class Launch {
  readonly sdk: LeveraSDK;
  readonly address: string;
  readonly contract: LaunchMethods;

  constructor(sdk: LeveraSDK, address: string, runner?: ContractRunner) {
    this.sdk = sdk;
    this.address = address;
    this.contract = contractWith<LaunchMethods>(address, LAUNCH_ABI, runner ?? sdk.runner);
  }

  private requireSigner(): void {
    if (!this.sdk.signer) {
      throw new Error("Launch writes need a signer — call sdk.connect(signer) first");
    }
  }

  /// Immutable launch facts, read once per address per SDK instance.
  async meta(): Promise<LaunchMeta> {
    const cached = this.sdk.caches.launchMeta.get(this.address.toLowerCase());
    if (cached) return cached;

    const [quote, quoteScale, priceOracle, swapRouter, earnPool, creator, leverageEnabled, targetRaise] =
      await Promise.all([
        this.contract.quote(),
        this.contract.quoteScale(),
        this.contract.priceOracle(),
        this.contract.swapRouter(),
        this.contract.earn(),
        this.contract.creator(),
        this.contract.leverageEnabled(),
        this.contract.targetRaiseEth(),
      ]);
    const quoteToken = contractWith<{ symbol(): Promise<string> }>(
      quote,
      ["function symbol() view returns (string)"],
      this.sdk.provider
    );
    const quoteSymbol = await quoteToken.symbol();

    // scale = 10**(18 − decimals), so decimals = 18 − log10(scale): 1e10 lifts to 8, not 10.
    const meta: LaunchMeta = {
      address: this.address,
      quote,
      quoteScale,
      quoteDecimals: 18 - Math.round(Math.log10(Number(quoteScale))),
      quoteSymbol,
      priceOracle,
      swapRouter,
      earnPool,
      creator,
      leverageEnabled,
      targetRaise,
    };
    this.sdk.caches.launchMeta.set(this.address.toLowerCase(), meta);
    return meta;
  }

  /// The USD-WAD price of this launch's QUOTE asset, from the launch's OWN oracle. A cbBTC-quoted
  /// coin carries the cbBTC feed — using a deployment-wide ETH figure marks every one of its USD
  /// numbers off by the ETH/BTC ratio.
  async collateralPriceUsd(): Promise<bigint> {
    const { priceOracle } = await this.meta();
    return this.sdk.oracle(priceOracle).collateralPriceUsd();
  }

  /// The trade fee, read live rather than hardcoded — the bps have moved before and every
  /// preview undercounted the fill when they did.
  async feeBps(): Promise<bigint> {
    return (await this.contract.TOTAL_FEE_BPS()) as bigint;
  }

  async curveReserves(): Promise<CurveReserves> {
    const [virtualTokens, virtualEth, curveK, curveSellable] = await Promise.all([
      this.contract.virtualTokens(),
      this.contract.virtualEth(),
      this.contract.curveK(),
      this.contract.curveSellable(),
    ]);
    return { virtualTokens, virtualEth, curveK, curveSellable };
  }

  async poolReserves(): Promise<PoolReserves> {
    const [reserveToken, reserveQuote, leverageEnabled, juniorQuote] = await Promise.all([
      this.contract.reserveToken(),
      this.contract.reserveEth(),
      this.contract.leverageEnabled(),
      this.contract.juniorEth(),
    ]);
    return { reserveToken, reserveQuote, leverageEnabled, juniorQuote };
  }

  async graduated(): Promise<boolean> {
    return (await this.contract.graduated()) as boolean;
  }

  /// Tokens out for a buy of `quoteIn`, on whichever venue the launch's phase dictates. Mirrors
  /// the contract: a curve buy is capped at remaining inventory (the excess is refunded).
  async quoteBuy(quoteIn: bigint): Promise<bigint> {
    if (quoteIn <= 0n) return 0n;
    const feeBps = await this.feeBps();
    if (await this.graduated()) {
      return poolBuyQuote(await this.poolReserves(), quoteIn, feeBps);
    }
    return curveBuyQuote(await this.curveReserves(), quoteIn, feeBps);
  }

  /// Quote out for a sell of `tokensIn`, on whichever venue the launch's phase dictates.
  async quoteSell(tokensIn: bigint): Promise<bigint> {
    if (tokensIn <= 0n) return 0n;
    const feeBps = await this.feeBps();
    if (await this.graduated()) {
      return poolSellQuote(await this.poolReserves(), tokensIn, feeBps);
    }
    return curveSellQuote(await this.curveReserves(), tokensIn, feeBps);
  }

  /// Spot price in quote-WAD (quote units per whole token), from the live venue.
  async spotPriceQuote(): Promise<bigint> {
    if (await this.graduated()) {
      return (poolSpotPriceQuote(await this.poolReserves()) ?? 0n);
    }
    return spotPriceQuote(await this.curveReserves());
  }

  async balanceOf(owner: string): Promise<bigint> {
    return (await this.contract.balanceOf(owner)) as bigint;
  }

  /// The full launch snapshot the app's explore grid shows, with every USD figure priced on the
  /// launch's own oracle.
  async summary(): Promise<LaunchSummary> {
    const meta = await this.meta();
    const collateralPrice = await this.collateralPriceUsd();
    const toUsd = (quoteAmount: bigint) => quoteAmountToUsd(quoteAmount, meta.quoteScale, collateralPrice);

    const [
      name, symbol, graduated, paired, raisedQuote, circulating, priceUsd, tvlUsd,
      reserveQuote, reserveToken, vaultQuote, seniorUsd, occupancyPaidUsd, pairingFeesPaidUsd,
    ] = await Promise.all([
      this.contract.name(),
      this.contract.symbol(),
      this.contract.graduated(),
      this.contract.paired(),
      this.contract.realEthRaised(),
      this.contract.circulating(),
      this.contract.priceUsd(),
      this.contract.tvlUsd(),
      this.contract.reserveEth(),
      this.contract.reserveToken(),
      this.contract.vaultEth(),
      this.contract.seniorUsd(),
      this.contract.occupancyPaidUsd(),
      this.contract.pairingFeesPaidUsd(),
    ]);

    const raisedUsd = toUsd(raisedQuote);
    const targetUsd = toUsd(meta.targetRaise);
    const pct = targetUsd > 0n ? Number((raisedUsd * 10000n) / targetUsd) / 100 : 0;

    return {
      address: this.address,
      name,
      symbol,
      meta,
      graduated,
      paired,
      raisedQuote,
      targetRaise: meta.targetRaise,
      raisedUsd,
      targetUsd,
      pctToGraduation: Math.min(pct, 100),
      priceUsd,
      collateralPriceUsd: collateralPrice,
      marketCapUsd: (priceUsd * TOTAL_SUPPLY_WAD) / WAD,
      circulating,
      tvlUsd,
      reserveQuote,
      reserveToken,
      vaultQuote,
      seniorUsd,
      occupancyPaidUsd,
      pairingFeesPaidUsd,
    };
  }

  /// The creator's fee position. When `creatorFeeInHfyc` is set, `harvest()` converts the pending
  /// quote into liquid LYC, so nothing is claimable here and the pending figure only reflects
  /// what has not been harvested yet.
  async creatorFees(): Promise<{
    pendingQuote: bigint;
    claimableQuote: bigint;
    lifetimeQuote: bigint;
    claimableUsd: bigint;
    inHfyc: boolean;
  }> {
    const [pending, lifetime, inHfyc, quoteScale, collateralPrice] = await Promise.all([
      this.contract.creatorFeeQuote(),
      this.contract.lifetimeCreatorFeeQuote(),
      this.contract.creatorFeeInHfyc(),
      this.contract.quoteScale(),
      this.collateralPriceUsd(),
    ]);
    const claimableQuote = inHfyc ? 0n : pending;
    return {
      pendingQuote: pending,
      claimableQuote,
      lifetimeQuote: lifetime,
      claimableUsd: quoteAmountToUsd(claimableQuote, quoteScale, collateralPrice),
      inHfyc,
    };
  }

  // ------------------------------------------------------------------
  //                            TRADING
  // ------------------------------------------------------------------

  /// Resolve the slippage floor for a buy: explicit `minTokensOut` wins, else quote live and
  /// apply `slippageBps` (default 1%). Pass `minTokensOut: 0n` to skip the quote round trip.
  private async resolveBuyFloor(opts: BuyOptions): Promise<bigint> {
    if (opts.minTokensOut !== undefined) return opts.minTokensOut;
    const quoted = await this.quoteBuy(opts.amountIn);
    return minOutFromQuote(quoted, opts.slippageBps ?? 100n);
  }

  private async resolveSellFloor(opts: SellOptions): Promise<bigint> {
    if (opts.minQuoteOut !== undefined) return opts.minQuoteOut;
    const quoted = await this.quoteSell(opts.tokensIn);
    return minOutFromQuote(quoted, opts.slippageBps ?? 100n);
  }

  /// Buy with the launch's quote ERC-20. Handles the approval, and handles the coin graduating
  /// between the phase read and the fill — the quote is already in this wallet, so a
  /// curve-closed revert is retried against the pool instead of stranding the trade.
  async buy(opts: BuyOptions): Promise<TradeResult> {
    this.requireSigner();
    const signer = this.sdk.signer!;
    const owner = await signer.getAddress();
    const { quote } = await this.meta();
    await this.sdk.token(quote).ensureApproval(owner, this.address, opts.amountIn);
    const minTokensOut = await this.resolveBuyFloor(opts);
    const graduated = await this.graduated();

    let tx: ContractTransactionResponse;
    let usedPool = graduated;
    if (graduated) {
      tx = await this.contract.buyOnPool(opts.amountIn, minTokensOut, opts.overrides);
    } else {
      try {
        tx = await this.contract.buy(opts.amountIn, minTokensOut, opts.overrides);
      } catch (e) {
        if (!isGraduationRace(e)) throw e;
        tx = await this.contract.buyOnPool(opts.amountIn, minTokensOut, opts.overrides);
        usedPool = true;
      }
    }
    const receipt = (await tx.wait())!;
    return this.parseTrade(receipt, usedPool ? "PoolBuy" : "CurveBuy");
  }

  /// Buy with NATIVE ETH via the QuoteZap. WETH-quoted launches only — a cbBTC-quoted coin has
  /// nothing to wrap. No approval involved; the zap wraps, forwards, and refunds the unspent
  /// native in the same transaction.
  async buyWithEth(opts: BuyOptions): Promise<TradeResult> {
    this.requireSigner();
    const { quote } = await this.meta();
    const zap = this.sdk.zap();
    const isWeth = quote.toLowerCase() === this.sdk.deployment.weth.toLowerCase();
    if (!isWeth) {
      throw new Error(`buyWithEth: launch quotes ${quote}, not WETH — trade it with buy() instead`);
    }
    const minTokensOut = await this.resolveBuyFloor(opts);
    const zapContract = zap.contract();
    const tx: ContractTransactionResponse = await zapContract.buyWithEth(
      this.address,
      minTokensOut,
      { ...opts.overrides, value: opts.amountIn }
    );
    const receipt = (await tx.wait())!;
    // The buyer of record in the event is the zap; the amounts are still the fill.
    return this.parseTrade(receipt, "CurveBuy", ["PoolBuy"]);
  }

  /// Sell tokens for the quote ERC-20. Curve or pool by phase, with the same graduation-race
  /// retry as buy — the tokens being sold are untouched by a revert, so the retry just fills.
  async sell(opts: SellOptions): Promise<TradeResult> {
    this.requireSigner();
    const minQuoteOut = await this.resolveSellFloor(opts);
    const graduated = await this.graduated();

    let tx: ContractTransactionResponse;
    let usedPool = graduated;
    if (graduated) {
      tx = await this.contract.sellOnPool(opts.tokensIn, minQuoteOut, opts.overrides);
    } else {
      try {
        tx = await this.contract.sell(opts.tokensIn, minQuoteOut, opts.overrides);
      } catch (e) {
        if (!isGraduationRace(e)) throw e;
        tx = await this.contract.sellOnPool(opts.tokensIn, minQuoteOut, opts.overrides);
        usedPool = true;
      }
    }
    const receipt = (await tx.wait())!;
    return this.parseTrade(receipt, usedPool ? "PoolSell" : "CurveSell");
  }

  /// Sell tokens for NATIVE ETH via the QuoteZap. WETH-quoted launches only. Handles the token
  /// approval to the zap.
  async sellForEth(opts: SellOptions): Promise<TradeResult> {
    this.requireSigner();
    const signer = this.sdk.signer!;
    const owner = await signer.getAddress();
    const { quote } = await this.meta();
    const isWeth = quote.toLowerCase() === this.sdk.deployment.weth.toLowerCase();
    if (!isWeth) {
      throw new Error(`sellForEth: launch quotes ${quote}, not WETH — trade it with sell() instead`);
    }
    const zap = this.sdk.zap();
    await this.sdk.token(this.address).ensureApproval(owner, zap.address, opts.tokensIn);
    const minEthOut = await this.resolveSellFloor(opts);
    const zapContract = zap.contract();
    const tx: ContractTransactionResponse = await zapContract.sellForEth(
      this.address,
      opts.tokensIn,
      minEthOut,
      opts.overrides
    );
    const receipt = (await tx.wait())!;
    return this.parseTrade(receipt, "CurveSell", ["PoolSell"]);
  }

  /// Pull the filled amounts out of the receipt. `primary`/`also` cover the zap paths, where the
  /// launch may have crossed venues inside the zap's own transaction.
  private parseTrade(receipt: ContractTransactionReceipt, primary: string, also: string[] = []): TradeResult {
    const iface = new Interface(LAUNCH_ABI as unknown as readonly string[]);
    for (const name of [primary, ...also]) {
      for (const log of receipt.logs) {
        let parsed: ReturnType<Interface["parseLog"]> | null = null;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue; // not this contract's log
        }
        if (parsed?.name !== name) continue;
        const args = parsed.args as unknown as {
          ethIn: bigint;
          ethOut: bigint;
          tokensIn: bigint;
          tokensOut: bigint;
          feeEth: bigint;
        };
        const isBuy = name === "CurveBuy" || name === "PoolBuy";
        return {
          hash: receipt.hash,
          receipt,
          route: name === "CurveBuy" || name === "CurveSell" ? "curve" : "pool",
          quoteAmount: isBuy ? args["ethIn"] : args["ethOut"],
          tokensOut: isBuy ? args["tokensOut"] : null,
          tokensIn: isBuy ? null : args["tokensIn"],
          feeQuote: args["feeEth"],
        };
      }
    }
    throw new Error(`trade mined (tx ${receipt.hash}) but no ${primary}${also.length ? `/${also.join("/")}` : ""} event was found in the receipt`);
  }

  // ------------------------------------------------------------------
  //                     LIFECYCLE / KEEPER ACTIONS
  // ------------------------------------------------------------------

  /// Permissionless once the curve is filled. Runs the graduation (pairing the AMM, pulling
  /// senior when queued).
  async graduate(overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.graduate(overrides));
  }

  /// Permissionless. A launch that graduated while the LYC queue was short lists at 1x until
  /// this succeeds — pairing pulls whatever idle senior the queue can cover.
  async tryPair(overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.tryPair(overrides));
  }

  async tryPairUpTo(maxUsd: bigint, overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.tryPairUpTo(maxUsd, overrides));
  }

  /// Sell reserve ETH down to the senior claim requires — the solvency poke.
  async protect(overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.protect(overrides));
  }

  /// Settle booked trade fees: holder share as unminted NAV yield, protocol and creator shares
  /// as fee mints/transfers. Without it the quote sits in the launch, excluded from TVL.
  async harvest(overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.harvest(overrides));
  }

  async accrueFunding(overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.accrueFunding(overrides));
  }

  /// Move vault quote the senior claim no longer needs into the AMM reserve.
  async rebalanceToReserve(overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.rebalanceToReserve(overrides));
  }

  async claimCreatorFees(overrides: Record<string, unknown> = {}) {
    this.requireSigner();
    return send(this.contract.claimCreatorFees(overrides));
  }
}

function isGraduationRace(e: unknown): boolean {
  const reason = (e as { reason?: string; message?: string })?.reason ?? "";
  const message = (e as Error)?.message ?? "";
  return GRADUATION_RACE.test(`${reason} ${message}`);
}

async function send(tx: Promise<ContractTransactionResponse>) {
  const response = await tx;
  return { hash: response.hash, receipt: await response.wait() };
}
