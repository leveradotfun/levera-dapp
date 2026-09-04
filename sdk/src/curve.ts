/// Bonding-curve and AMM quote math, mirroring Launch.sol exactly. The contract stays the source
/// of truth — these previews exist so a caller can show a number before signing, using the same
/// formulas the fill uses rather than a second, driftable copy.

export const WAD = 10n ** 18n;
/// 1e9, fixed: Launch mints TOTAL_SUPPLY once in initialize() and never mints or burns again, so
/// market cap is price × full supply in both phases.
export const TOTAL_SUPPLY_WAD = 1_000_000_000n * WAD;
export const BPS_DENOMINATOR = 10_000n;
/// Launch.TOTAL_FEE_BPS — the trade fee, in bps, skimmed on every curve/AMM trade. A Launch
/// constant, so it cannot drift per coin; Launch.feeBps() reads it live for callers that hold a
/// launch, and pre-launch previews (creator dev buy) use this value directly.
export const TOTAL_FEE_BPS = 100n;
/// Launch.MAX_SELL_BPS — a pool sell can return at most 15% of the reserve per call.
export const MAX_SELL_BPS = 1500n;

/// Curve shape constants behind the initial virtual reserves. CURVE_SELLABLE (800M) and
/// CURVE_SHAPE_M make the starting reserves a pure function of the raise target — needed for
/// previewing a creator dev buy on a curve that does not exist on-chain yet.
export const CURVE_SELLABLE_WAD = 800_000_000n * WAD;
export const CURVE_SHAPE_M_WAD = 1333333333333333333n;

export type CurveReserves = { virtualTokens: bigint; virtualEth: bigint; curveK: bigint; curveSellable: bigint };
export type PoolReserves = { reserveToken: bigint; reserveQuote: bigint; leverageEnabled: boolean; juniorQuote: bigint };

/// net = in − fee. The curve trades on the net amount; the fee is skimmed on top.
export function netAfterFee(amountIn: bigint, feeBps: bigint): bigint {
  return amountIn - (amountIn * feeBps) / BPS_DENOMINATOR;
}

export function applyFee(amountOut: bigint, feeBps: bigint): bigint {
  return amountOut - (amountOut * feeBps) / BPS_DENOMINATOR;
}

/// Tokens out for a curve buy of `quoteIn` (already the launch's quote units). Mirrors
/// Launch.buy: the contract caps the fill at what inventory is left and refunds the rest, so
/// quoting more than `curveSellable` would promise tokens the trade cannot deliver.
export function curveBuyQuote(reserves: CurveReserves, quoteIn: bigint, feeBps: bigint): bigint {
  if (quoteIn <= 0n) return 0n;
  const netIn = netAfterFee(quoteIn, feeBps);
  const newVt = reserves.curveK / (reserves.virtualEth + netIn);
  const out = reserves.virtualTokens > newVt ? reserves.virtualTokens - newVt : 0n;
  return out > reserves.curveSellable ? reserves.curveSellable : out;
}

/// Quote out for a curve sell of `tokensIn`. The fee comes off the proceeds.
export function curveSellQuote(reserves: CurveReserves, tokensIn: bigint, feeBps: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const newVu = reserves.curveK / (reserves.virtualTokens + tokensIn);
  const grossOut = reserves.virtualEth > newVu ? reserves.virtualEth - newVu : 0n;
  return applyFee(grossOut, feeBps);
}

/// The reserve the AMM prices against. A levered pair prices its sells against the JUNIOR
/// cushion, not the whole reserve — the senior side is not for sale.
export function pricingReserve(pool: PoolReserves): bigint {
  return pool.leverageEnabled && pool.juniorQuote > 0n ? pool.juniorQuote : pool.reserveQuote;
}

/// Tokens out for an AMM (post-graduation) buy. No sell-cap here; the buy side is bounded by the
/// constant-product k alone.
export function poolBuyQuote(pool: PoolReserves, quoteIn: bigint, feeBps: bigint): bigint {
  const pricingQuote = pricingReserve(pool);
  if (quoteIn <= 0n || pool.reserveToken === 0n || pricingQuote === 0n) return 0n;
  const netIn = netAfterFee(quoteIn, feeBps);
  const k = pool.reserveToken * pricingQuote;
  const newRt = k / (pricingQuote + netIn);
  const tokensOut = pool.reserveToken > newRt ? pool.reserveToken - newRt : 0n;
  if (tokensOut >= pool.reserveToken) return 0n;
  return tokensOut;
}

/// Quote out for an AMM sell, capped at MAX_SELL_BPS of the reserve (and at the reserve itself).
export function poolSellQuote(pool: PoolReserves, tokensIn: bigint, feeBps: bigint): bigint {
  const pricingQuote = pricingReserve(pool);
  if (tokensIn <= 0n || pool.reserveToken === 0n || pricingQuote === 0n) return 0n;
  const k = pool.reserveToken * pricingQuote;
  const newY = k / (pool.reserveToken + tokensIn);
  let gross = pricingQuote > newY ? pricingQuote - newY : 0n;
  const maxOut = (pool.reserveQuote * MAX_SELL_BPS) / BPS_DENOMINATOR;
  if (gross > maxOut) gross = maxOut;
  if (gross > pool.reserveQuote) gross = pool.reserveQuote;
  return applyFee(gross, feeBps);
}

/// Spot price of one whole token, in quote-WAD (quote units per 1e18 tokens).
export function spotPriceQuote(reserves: CurveReserves): bigint {
  return reserves.virtualTokens > 0n ? (reserves.virtualEth * WAD) / reserves.virtualTokens : 0n;
}

/// Pool-phase spot price, same units. Returns null when there are no reserves to price from.
export function poolSpotPriceQuote(pool: PoolReserves): bigint | null {
  const pricingQuote = pricingReserve(pool);
  if (pool.reserveToken === 0n || pricingQuote === 0n) return null;
  return (pricingQuote * WAD) / pool.reserveToken;
}

/// What a CREATOR dev buy of `buyInQuote` would receive on a FRESH curve for a coin with this
/// raise target, and the creatorBuyCapBps check that bounds it — for validating a create before
/// submitting rather than letting the factory's "creator cap" revert be the first the user hears.
export function previewCreatorBuy(
  targetRaiseQuote: bigint,
  buyInQuote: bigint,
  creatorBuyCapBps: bigint,
  feeBps: bigint
): { tokensOut: bigint; capTokens: bigint; exceedsCap: boolean } {
  const capTokens = (TOTAL_SUPPLY_WAD * creatorBuyCapBps) / BPS_DENOMINATOR;
  if (buyInQuote <= 0n) return { tokensOut: 0n, capTokens, exceedsCap: false };
  const virtualTokens0 = (CURVE_SELLABLE_WAD * CURVE_SHAPE_M_WAD) / WAD;
  const virtualEth0 = (targetRaiseQuote * (CURVE_SHAPE_M_WAD - WAD)) / WAD;
  const netIn = netAfterFee(buyInQuote, feeBps);
  const newVt = (virtualTokens0 * virtualEth0) / (virtualEth0 + netIn);
  const tokensOut = virtualTokens0 > newVt ? virtualTokens0 - newVt : 0n;
  return { tokensOut, capTokens, exceedsCap: tokensOut > capTokens };
}

/// Slippage helper: a quoted output minus `slippageBps`, floored at 0.
export function minOutFromQuote(quotedOut: bigint, slippageBps: bigint): bigint {
  if (quotedOut <= 0n) return 0n;
  return quotedOut - (quotedOut * slippageBps) / BPS_DENOMINATOR;
}
