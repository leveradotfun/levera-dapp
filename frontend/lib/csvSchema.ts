/// The research CSV schema.
///
/// Three files rather than one, because the three things worth recording have three different
/// shapes and cramming them into a single wide row is what produced a file where a third of the
/// columns were blank in every line and the rest meant different things depending on the row type.
///
///   book.csv    one row per interval: the Earn Pool as a whole
///   pools.csv       one row per pool per interval: every registered launch, not just the selected one
///   collaterals.csv one row per listed collateral per interval
///   events.csv  one row per discrete thing that happened: launches, errors, fills, exits, shocks
///
/// Rules this schema follows, each of which exists because its absence cost a session's data:
///
///   * Every file carries `writer` and `seq`. Three processes append here concurrently, so rows
///     arrive out of order and duplicate; `(writer, seq)` is what makes a run reconstructible.
///   * Every sub-1e-6 price ships a `_wei` companion. Those prices are around 2e-9, which float64
///     renders as `0` at default precision -- the values were never missing, they were unreadable.
///   * Nothing is named after a quantity it is not. `reserve_tvl_usd` is the AMM reserve;
///     `pool_tvl_usd` is the whole book. Leverage is computed off the second, and reading it off
///     the first gives a negative junior.
///   * A column that cannot be computed is blank, never zero and never a stale carry-forward.

export const BOOK_COLUMNS = [
  "timestamp",
  "writer",
  "seq",
  "session_id",
  "elapsed_seconds",
  "oracle_live",
  "oracle_price_usd",
  "oracle_shock_pct",
  "shock_path_id",
  // --- the senior claim -------------------------------------------------
  "lyc_nav",
  "lyc_supply",
  "lyc_deposit_minted",
  "lyc_fee_minted",
  "lyc_liability_usd",
  "lyc_idle_usdg",
  // --- what backs it ----------------------------------------------------
  // In USD: collateral quantities across assets cannot be summed. Per-asset detail, which is the
  // only form that means anything with more than one listing, is in collaterals.csv.
  "total_collateral_usd",
  "total_senior_usd",
  "total_junior_nav_usd",
  "total_assets_usd",
  "global_cr",
  "eth_drop_to_impairment_pct",
  // --- the price of senior capital --------------------------------------
  "utilization",
  "occupancy_rate_apr",
  // --- realised return, which is not the occupancy rate ------------------
  "earn_pool_apy",
  "earn_pool_window_yield_usd",
  "earn_pool_window_seconds",
  "earn_pool_window_base_usd",
  "yield_occupancy_share",
  "yield_cash_share",
  "total_occupancy_usd",
  "total_cash_yield_usd",
  // --- book size --------------------------------------------------------
  "pools_registered",
  "pools_paired",
] as const;

export const POOL_COLUMNS = [
  "timestamp",
  "writer",
  "seq",
  "session_id",
  "elapsed_seconds",
  "launch_address",
  // The quote asset IS the collateral: a launch is denominated in it, pairs against it, and is
  // levered against it. Its decimals are load-bearing for reading this row -- `pool_eth`,
  // `vault_eth` and `reserve_eth` are in the quote's OWN units, so an 8-decimal cbBTC pool of
  // 0.99e8 is one whole cbBTC, not 1e-10 of one.
  "collateral_token",
  "quote_symbol",
  "quote_decimals",
  "phase",
  "leverage_enabled",
  "paired",
  "oracle_price_usd",
  "oracle_price_wei",
  "oracle_shock_pct",
  "shock_path_id",
  // --- curve phase ------------------------------------------------------
  "curve_spot_eth",
  "curve_spot_eth_wei",
  "curve_raised_eth",
  "curve_sellable",
  // --- the two ETH buckets ----------------------------------------------
  "pool_eth",
  "vault_eth",
  "reserve_eth",
  "cushion_eth_paid",
  "pool_tvl_usd",
  "reserve_tvl_usd",
  // --- the split --------------------------------------------------------
  "senior_usd",
  "junior_nav_usd",
  "leverage",
  "cr",
  // --- vLYC as a supply with a history ---------------------------------
  "senior_minted_usd",
  "senior_burned_usd",
  "senior_high_water_usd",
  "pairing_billed_usd",
  "senior_claim_eth",
  "senior_coverage",
  "reserve_cover",
  // --- rebalance routes -------------------------------------------------
  "sell_route_eth_available",
  "sell_route_price_usd",
  "buy_route_eth_wanted",
  "buy_route_price_usd",
  "route_pnl_usd",
  // --- what a trade costs right now -------------------------------------
  "trade_fee_bps_buy",
  "trade_fee_bps_sell",
  "surcharge_bps_buy",
  "surcharge_bps_sell",
  // --- what the meme has paid the Earn Pool -----------------------------
  "occupancy_paid_usd",
  "pairing_fees_paid_usd",
  // --- the token --------------------------------------------------------
  "token_price_usd",
  "token_price_wei",
  "reserve_token",
  "circulating",
  "market_cap_usd",
  "recent_volume_usd",
  "lifetime_volume_usd",
  // --- how much room is left --------------------------------------------
  "eth_move_to_sell_route_pct",
  "eth_move_to_wipe_pct",
  // --- realised behaviour, blank unless the collateral actually moved ----
  "eth_move_pct",
  "token_move_pct",
  "realized_leverage",
  "tracking_error_pct",
] as const;

/// One row per listed collateral per sample.
///
/// The senior claim is one unit across assets, but the risk machinery is per asset: its own feed,
/// its own collateral ratio, its own cap, and its own price for renting senior. A single aggregate
/// row stops meaning anything the moment the book holds two, so each gets its own.
export const COLLATERAL_COLUMNS = [
  "timestamp",
  "writer",
  "seq",
  "session_id",
  "elapsed_seconds",
  "collateral_token",
  "collateral_symbol",
  "collateral_price_usd",
  "collateral_oracle_live",
  "oracle_shock_pct",
  "shock_path_id",
  // --- what this asset holds and owes -----------------------------------
  "collateral_pooled",
  "collateral_idle",
  "collateral_senior_usd",
  "collateral_cr",
  // --- routing ----------------------------------------------------------
  "collateral_cap_bps",
  "collateral_headroom_usd",
  "collateral_routing_apr",
  "collateral_funding_apr",
  "collateral_enabled",
] as const;

export const EVENT_COLUMNS = [
  "timestamp",
  "writer",
  "seq",
  "session_id",
  "elapsed_seconds",
  "event_type", // SESSION_START | LAUNCH | GRADUATE | ROUTE_FILL | NETTED | REDEEM | SHOCK | ERROR
  "launch_address",
  "oracle_price_usd",
  "oracle_shock_pct",
  "shock_path_id",
  // --- LAUNCH -----------------------------------------------------------
  "launch_spot_eth",
  "launch_spot_eth_wei",
  "listing_spot_eth",
  "listing_spot_eth_wei",
  "price_after_creator_buy_eth",
  "price_after_creator_buy_eth_wei",
  "creator_buy_eth",
  "creator_buy_impact_pct",
  // --- ROUTE_FILL -------------------------------------------------------
  "route_side",
  "route_eth",
  "route_usdg",
  "route_price_usd",
  "route_pnl_usd",
  "leverage_before",
  "leverage_after",
  // --- NETTED -----------------------------------------------------------
  "netted_from",
  "netted_to",
  "netted_usd",
  // --- REDEEM -----------------------------------------------------------
  "redeem_kind", // cash | in-kind | pro-rata
  "redeem_shares",
  "redeem_usdg_out",
  "redeem_weth_out",
  "redeem_peeled_pools",
  // --- ERROR ------------------------------------------------------------
  "error_action",
  "error_message",
  "error_code",
  "error_tx_hash",
] as const;

export type CsvFile = "book" | "pools" | "collaterals" | "events";

export const SCHEMAS: Record<CsvFile, readonly string[]> = {
  book: BOOK_COLUMNS,
  pools: POOL_COLUMNS,
  collaterals: COLLATERAL_COLUMNS,
  events: EVENT_COLUMNS,
};

export const FILENAMES: Record<CsvFile, string> = {
  book: "book.csv",
  pools: "pools.csv",
  collaterals: "collaterals.csv",
  events: "events.csv",
};
