# HFyc — Hood Frenzy Yield Coin

Canonical mechanism spec. Every formula below is an invariant or a decision. Nothing here is left as
"the keeper will figure it out."

**HFyc** is the token — the senior, dollar-denominated claim. **The Earn Pool** (`EarnPool.sol`) is
the contract: the book that holds every senior dollar and aggregates the yield from every 2x coin
attached to it. Holding HFyc *is* being in the Earn Pool; there is nothing to stake, which is why
supply never moves when yield arrives.

---

## 1. One-sentence product

People deposit cash (or collateral, sold on arrival) and hold **HFyc** — a single USD-senior token
that starts at $1 and rises only from real inflows. Memecoins are the junior claim on the same
collateral: they take **all** of its price movement, pay the Earn Pool in fees and occupancy rent,
and are delevered by a route somebody else fills when the collateral falls. No flash loan, no second
yield token, no $1 peg promise after the junior is gone, and no execution risk on the protocol's own
defence.

---

## 2. What this is not

| Rejected | Why |
|---|---|
| Morpho looping of raise ETH | Liquidation at ~17% ETH, carry, mock≠Morpho, quoted depth that is not cash |
| hyUSD **and** eHYUSD | One token. Price *is* the yield |
| Naked-minting HFyc as “fees” | Dilutes depositors. Fee asset in, then mint at NAV |
| Time-only funding as the yield engine | A 2-minute coin pays ~0 at any honest APR |
| 3x target | Sell-into-dump has no time. Wipe at −33% ETH |
| Instant $1 redeem when CR ≤ 100% | First-mover bank run |
| Pairing as Uniswap LP | LPs take inventory risk; the meme would not get “all the appreciation” |
| Reading Uniswap spot for NAV or a rebalance price | Self-referential manipulation. Oracle values; the route posts, it does not take |

---

## 3. Actors and tokens

| Who | Holds | What they are |
|---|---|---|
| HFyc depositor | Queue receipt, then **HFyc** | Senior. Dollar claim. No ETH upside once paired. Paid in NAV (unminted fees, pairing bps, funding) |
| Meme buyer | The launch token | Junior. 100% of ETH delta. Pays fees + rent. Leverage is **rented** and can fall |
| Protocol treasury | Fee-minted **HFyc** (always liquid) | Aligned with HFyc. Not paid ETH |
| Creator | ETH **or** fee-minted HFyc | Toggle set once at launch, immutable |

**HFyc** is the only yield token. It is not a stablecoin. $1 is the **issue price** and the **healthy-NAV target**, not a peg the protocol defends with someone else’s collateral.

Each launch is an isolated vault (clone). HFyc accounting is global. A bug in one launch cannot `transferFrom` another launch’s ETH. An ETH crash hits every ETH pool together; isolation does not diversify beta.

On Robinhood Chain the cash leg is **USDG**. Implementation uses USDG, not USDC.

---

## 4. The invariant

Per launch pool `i`, and globally:

```
TVL_i          = ETH_i × P + USDG_i_in_pool
memeNAV_i      = max(TVL_i − senior_i, 0)
L_i            = TVL_i / memeNAV_i          if memeNAV_i > 0
                 ∞                          if memeNAV_i = 0 and TVL_i > 0
CR_i           = TVL_i / senior_i           if senior_i > 0

HFyc_liability = Σ senior_i + idle_USDG     // idle is cash, never unpaired ETH
HFyc_nav       = HFyc_liability / HFyc_supply     // $1 when supply is 0 (genesis)
HFyc_price     = HFyc_nav

global_CR      = (Σ TVL_i + idle_USDG) / HFyc_liability
```

`P` is the collateral oracle (ETH/USD), fail-closed on stale or wide confidence (same 2% conf / 1h age band already in `Launch.sol`). Every USD figure in this spec is computed off that oracle, never off a pool spot.

Identities that must hold after every successful tx:

```
HFyc_liability + Σ memeNAV_i  =  Σ TVL_i + idle_USDG
HFyc_nav × HFyc_supply        =  HFyc_liability
memeNAV_i                     =  max(TVL_i − senior_i, 0)
```

If a launch’s junior is wiped (`memeNAV_i = 0`), that pool’s remaining assets still count toward `TVL_i` and therefore toward HFyc. They are the Earn Pool's problem now, and `protect()` sweeps them to cash. Do not leave orphaned collateral marked as a $1 claim.

---

## 5. HFyc minting — assets in, then shares out

HFyc minted 1:1 against unpaired ETH is already undercollateralized on the next ETH tick down. There is no junior yet. That path is forbidden.

### 5.1 Convert on arrival

There is no queue. A depositor's cash is credited immediately and earns from the first block.

```
mintWithUsdg(usd):   idle += usd ; liability += usd ; mint usd/nav
mintWithEth(eth):    sell to USDG at oracle minOut, then as above
```

HFyc minted 1:1 against **unpaired collateral** would be undercollateralised on the next tick down,
with no junior beneath it. Converting on the way in removes the exposure rather than making people sit through it: the claim is
dollars, backed by dollars, from the moment it exists. The protocol buys collateral back only at the
instant a pool is actually paired, atomically with the pairing, so there is never a window where a
dollar claim is long collateral by accident.

### 5.2 Pair mint

When a launch attaches `S` USD of senior (§7):

```
ethBought = swap S of idle → collateral at oracle minOut
vaultEth += ethBought        senior += S       // vHFyc minted, §6.2
idle     -= S
```

Liability is unchanged throughout: `senior` and `idle` are both components of it. Later depositors
mint at the **current** nav, never at $1 — if nav is $1.07, $107 mints 100 HFyc and existing holders
are not diluted.

### 5.3 Fee mint (protocol / creator-in-HFyc)

Never `mint(wallet, usd)`. Always:

```
feeEth in  → swap to USDG at oracle minOut
idle_USDG += usdReceived
HFyc_out   = usdReceived / HFyc_nav
mint HFyc_out to recipient
```

Assets in, then shares out. NAV unchanged. This is a deposit, not yield.

All HFyc is the same liquid ERC-20. Deposit-minted and fee-minted shares transfer and redeem immediately. Exit pays idle USDG, or zaps to ETH. If idle is short, `redeemTo` peels senior from 2x pools in **quietest-first** recent-volume order (same allocation law as scarce-capital reallocation). Cover changes the price, never the permission.

### 5.4 Holder yield (no mint)

Unminted fee ETH/USDG, pairing bps, and funding increase `HFyc_liability` **without** increasing supply. That is the only thing that lifts `HFyc_nav`.

---

## 6. Target leverage, the band, and the routes

```
targetL = 2.0          // CR = 200%, senior = junior
band    = [1.5, 2.5]   // where the fee curve is flat
```

```
L  = TVL / (TVL − senior)     =  CR / (CR − 1)
CR = L / (L − 1)
```

| State | L | CR | Collateral move from a 2x, all-collateral start |
|---|---|---|---|
| Buy route fully open | 1.2x | 600% | **+150%** |
| Buy route opens | 1.8x | 225% | **+25%** |
| Target | 2.0x | 200% | 0 |
| Sell route opens | 2.2x | 183% | **−9.1%** |
| Sell route at spot | 2.5x | 167% | **−16.7%** |
| Sell route fully subsidised | 3.0x | 150% | **−25%** |
| Junior gone, senior impaired if still in collateral | ∞ | 100% | **−50%** |

At 3x the sell trigger is ~−10% and impairment is −33%. There is no room to transact. 2x is the
first leverage where "sell into the dump" can exist.

Those percentages assume the pool is **at** target. A pool that has drifted is materially closer to
its trigger, and only the live figure is true. Every published risk number is derived from current
state, never from `targetL`.

### 6.1 What pulls a pool back

Three mechanisms, in order of preference. Each is permissionless.

**Netting (free).** A pool above target is carrying senior it does not need; a pool below target
wants exactly that. `netSeniorBetween` moves the claim and its collateral directly between them, in
kind. No collateral sold, no cash spent, no spread paid, no counterparty. Both pools move toward
2.0 in the same transaction, and neither junior gains or loses because the two legs are the same
size at the oracle price.

**Routes (priced).** The protocol posts a price and lets arbitrageurs fill it. It never calls a
venue, never sets a `minOut`, and therefore cannot be reverted by a thin book at the exact moment it
needs to shrink.

```
routePrice = P × f(L)          f is a 3-point piecewise-linear curve, clamped flat outside

sell route (pool gives collateral, takes cash):
  L < 2.20 ........ shut
  L = 2.20 ........ f = 1.0050   sells above spot — the pool is PAID to de-risk
  L = 2.50 ........ f = 1.0000   exactly oracle spot
  L ≥ 3.00 ........ f = 0.9800   discounts — the pool pays for urgency

buy route (pool gives cash, takes collateral):  mirror image at 1.80 / 1.50 / 1.20
```

Fill size, closed form. Selling `d` at `P·f` retires `d·P·f` of senior, so junior moves by
`d·P·(f−1)`:

```
d = (TVL − targetL · J) / (P · (targetL·f − (targetL − 1)))
  = (TVL − 2J) / P                       when f = 1
```

Capped at 15% of vault collateral per fill; the buy side is additionally capped at idle cash. The
spread is booked signed to `routePnlUsd` and lands on the **junior** — the party renting the
leverage. De-risking is paid for by the position being de-risked, never socialised onto the senior.

**The surcharge (a backstop).** A trade that drags the book toward an edge pays for the rebalance it
just made necessary. See §11.

The routes are an incentive, not a guarantee: if nobody fills, a pool stays drifted. That is why the
sell route opens at 2.20 rather than at a cliff, and why netting exists.

### 6.2 The two cover ratios

```
seniorCoverage = vaultEth / (senior / P)      is the claim still backed by collateral we hold?
reserveCover   = reserveEth / juniorEth       is the quoted price reachable by a seller?
juniorEth      = reserveEth + vaultEth − senior/P
```

The AMM quotes off `juniorEth` but can only **pay** from `reserveEth`. As P rises, `senior/P`
shrinks, so part of the vault stops backing senior and starts belonging to the junior — while
sitting where a seller cannot reach it. Left alone the pool quotes a healthy price it cannot honour.

`rebalanceToReserve()` moves only the excess:

```
Δ = max(vaultEth − senior/P, 0)
```

Senior keeps exactly the collateral its claim is worth, so coverage lands on 1.0 and the sell route
still has its full backing. TVL, junior NAV and L are all unchanged. This corrects **which bucket**
the collateral is in, nothing else.

## 7. Launch, curve, pair

### 7.1 Bonding curve

Pump.fun-style constant-product on virtual reserves, quoted **in ETH**, custodying ETH. Same solvency reason as the current `Launch.sol`: a USD-quoted curve holding ETH is insolvent on an oracle move.

Default: 1,000,000,000 fixed supply, target raise **6.9 ETH**. USD is snapshotted at the creation-time oracle for display only; the on-chain cap is the ETH amount, so the goalpost cannot drift with the dollar price.

Curve fees: 1.25% on the ETH leg. **2x** (including pre-pair curve): 30 creator / 45 protocol / 50 HFyc holders (unminted USDG). **1x**: 30 creator / 95 protocol / 0 HFyc. 1x never rents senior, so its tape does not lift HFyc NAV.

### 7.2 Graduation / pair

A curve may graduate **and pair at 2x** iff:

```
realEthRaised ≥ targetRaise
idleUsd       ≥ raiseUsd            // at 2x, senior = junior
```

Then:

```
J = raiseUsd
S = raiseUsd                        // 2x ⇒ senior = junior
attach S of idle cash as senior (§5.2)
pool ETH = raise ETH + pulled ETH
senior_i = S
memeNAV_i = J
L_i = 2
```

Worked: 6.9 ETH raise, ETH = $3,000.

```
junior ETH   = 6.9
senior ETH   = 6.9     (bought with idle cash)
pool         = 13.8 ETH = $41,400
HFyc minted  = 20,700 / nav          (20,700 HFyc if nav = $1)
meme NAV     = $20,700
L            = 2.0
```

If idle cash cannot cover `S`, **do not fake 2x**. Attach whatever idle exists (`take = min(gap, idle)`). The coin lists at `L = 1 + take/junior` and `tryPair()` tops it up as deposits arrive. Occupancy rent and the 50 bps pairing fee are charged on the dollars actually attached, not on a ghost 2x. Never mint ghost senior.

**Allocation law (scarce senior):** volume fees, not occupancy, are what a frenzy pays. When idle is empty, a 2x coin with more *recent* volume (1-day decaying notional) may pull senior from a quieter 2x coin (`reallocateFrom`). Same-wallet buy/sell round trips do not count as recent volume — a wash bot must not outrank a quieter real tape. Two-wallet wash can still game the score; that residual is accepted. The transfer is **in kind**: the quiet coin hands over collateral and burns its claim, the loud coin receives the collateral and mints the same claim. No cash is created and none is spent buying collateral back, so reallocation costs no spread and cannot revert on depth. A creator who unchecked 2x is never pulled into or out of this book.

There is **no** hard per-launch cap. One made the first coin on an empty book unpairable, which is a launchpad that cannot launch. Scarcity is priced instead: the occupancy curve makes renting senior steeply more expensive as utilisation climbs, which pays depositors more and pulls capital in.

### 7.3 The token *is* the junior

Post-pair, `memeNAV / reserveToken` is the fair price of the memecoin — junior NAV over the tokens **in the book**, not over the tokens held by buyers. Primary market is mint/redeem against the pool at that NAV, with the fee curve in §11. Secondary Uniswap listing is optional and must not be the NAV calculator.

> This line previously read `memeNAV / circulating`, which is wrong and would be a visible break. At graduation the AMM is seeded with the ~200M tokens left in the contract, while ~800M sit with curve buyers, so the two denominators differ by 4×. Dividing by `circulating` prints a price **75% below** the last curve tick, so every coin would appear to crash the instant it graduated. Dividing by `reserveToken` is continuous with both the final curve price (`raise/200M`) and the AMM's own opening ratio, which is pump.fun's behaviour and what `Launch.sol` implements. Guarded by `test/GradPrice.t.sol`.

Market cap is quoted on the **full 1e9 supply**, not on `circulating`. Supply is minted once and never burned, so price × 1e9 is exact in both phases; price × circulating collapses to roughly the money deposited and can never exceed the raise.

Minting additional junior (ETH in, more memecoins out) at fair NAV, **without** pairing more HFyc, **lowers L**. That is allowed; the 1.5x edge then optionally re-levers. Do not silently turn a depositor’s ETH into someone else’s senior (the §7 bug in `THESIS.md`).

---

## 8. Who gets the collateral upside

ETH +10% on the §7.2 pool, funding off:

```
TVL     = $41,400 × 1.10 = $45,540
senior  = $20,700                 (unchanged)
memeNAV = $24,840                 (+20% = 2 × 10%)
HFyc    = $20,700, nav unchanged
```

ETH −10%:

```
TVL     = $37,260
senior  = $20,700
memeNAV = $16,560                 (−20%)
L       = 2.25                    (still inside the band)
```

HFyc does not get the moon. HFyc does not take the first 50% of a dump. That is the whole split.

---

## 9. How the Earn Pool is paid

A 5% APR on a coin that lives two minutes is ~0.00002% of senior. Do not try to make occupancy rent pay for a 2-minute frenzy. Do not try to make volume fees pay for a 12-hour book that nobody trades.

### 9.1 Trading fee — the yield (volume)

Total **1.25%** on the quote (ETH) leg, pump.fun-shaped. Do not raise the total to feed HFyc.

| Slice | 2x bps | 1x bps | Destination |
|---|---|---|---|
| Creator | 30 | 30 | ETH, or HFyc mint-at-NAV only if 2x and the creator opted in |
| Protocol | 45 | 95 | HFyc mint-at-NAV to the treasury (backed; nav unchanged) |
| HFyc holders | 50 | 0 | USDG in, **no mint**, nav up. **2x only.** |

Buyer pays fee-inclusive; seller receives fee-exclusive. Same as current `Launch.sol`.

Post-pair and on the curve (§7.1): the 50 bps holder slice is converted to USDG and added to `idle_USDG` (or, if the launch is paired, it may be added to that pool as USDG and then swept to idle on harvest — implementation detail; economically it is unminted backing).

Worked: $2,000,000 2-minute volume × 50 bps = **$10,000** into HFyc NAV. That is the paycheck. Funding over those 120 seconds is cents.

### 9.2 Pairing fee — the 2-minute floor

Once, at pair:

```
pairingFee = 50 bps × S          // 30–50 bps; lock 50 bps as the start
```

Taken from the raise (junior) in ETH, swapped to USDG, **unminted** into HFyc. A coin that pairs, dumps, and never trades still pays for the attach and for the rebalancing that may follow. It is billed against the **high-water** senior, so senior that leaves on a route fill or a redemption peel and comes back is not charged a second time for the same dollars.

$20,700 paired × 50 bps = **$103.50** to HFyc. Always.

### 9.3 Per-second funding — occupancy rent (survivors)

```
rate          = 10% APR           // start; legal range 5–15%
secondsPerYear = 365 × 24 × 3600

on any touch of pool i (trade, protect, redeem, pair, harvest):
  dt   = now − lastAccrued_i
  if L_i ≥ 2.5 or memeNAV_i = 0:  owed = 0
  else: owed = senior_i × rate × dt / secondsPerYear
  owed = min(owed, memeNAV_i)     // never drive junior negative through rent
  senior_i    += owed             // nav up, no mint
  memeNAV implied: TVL unchanged, junior shrinks
  lastAccrued_i = now
```

This is a **timestamp index**, not a 1 Hz keeper. A 2-minute coin pays nothing material. A 2-day coin pays ~5 bps of senior at 10% APR — real if it sat, small next to fees if it traded.

Funding is **off** at L ≥ 2.5. Charging rent while selling the cushion accelerates the wipe.

Do not set APR so that two minutes “matters.” That is a second liquidation.

---

## 10. `protect()` — the orphan sweep, and the only remaining swap

Rebalancing a live pool is a **route** (§6.1). `protect()` is what is left over: the sweep for a
pool whose junior is already gone.

```
require(memeNAV == 0)
sell ALL of vaultEth → USDG      // no cap: there is no cushion left to ration
senior −= min(usdReceived, senior)
idle   += that amount
residual above the claim → depositYield   // the junior it would have gone to no longer exists
```

This is the one place the protocol still touches a venue, and it is deliberately confined here. A
route needs somebody to fill it, and a dead coin has nobody watching. Nothing is blocked when the
swap reverts: the residual stays in collateral and the call can be retried, and holder redemptions
are paid in kind (§11) and never depend on it succeeding.

Permissionless. `EarnPool.sweepOrphaned(pools)` batches up to 32.

## 11. HFyc holder exit

A holder is never locked in.

Senior redemption with `global_CR > 1` **improves** the remaining book: liability and assets leave
together, and since assets exceed liability the ratio rises. The run exists only at
`global_CR ≤ 1`, where paying the first wallet $1 steals from the last.

The exit pays whatever the book actually holds and **converts nothing on the holder's behalf**. The
moment a redemption has to route through a venue, a holder's access to their own money depends on a
fill they never asked for, at a size they did not choose — and a bad book leaves them with neither
the cash nor the collateral.

| Path | When | Pays | Fails on liquidity? |
|---|---|---|---|
| `redeem` | Idle cash covers it | USDG | Says so, and names the path that cannot |
| `redeemInKind` | Always | USDG, then WETH peeled quietest-first | **No** |
| `emergencyRedeem` | Oracle dead **or** `global_CR ≤ 1` | Pro-rata USDG + WETH | **No** |

```
// in kind
usdgOut = min(idleUsdg, shares × nav)
ethOut  = shortfall / P, peeled quietest-first
  per pool:  vaultEth −= E ;  senior −= E·P     ⇒  ΔmemeNAV = 0
```

Both legs are the same size at the oracle price, so the junior neither gains nor loses from
somebody else's exit. What the meme loses is leverage, not value.

**No per-call cap on the in-kind path.** The 15% cap exists to stop one transaction dumping a vault
into a thin book; an in-kind transfer touches no book. It is also strictly cheaper — the swap path
gave up to 1% to the router on every exit.

**The price-free path.** Every term in `emergencyRedeem` is a ratio of quantities, so it works when
the oracle does not. `nav()` fails closed on a stale feed, which is right for minting and for sizing
a rebalance and **wrong for exit**: a holder must never be stuck because a feed went quiet. It is
refused while the book is covered and the feed is live, because pro-rata deliberately claims no
share of the junior cushion. Shares burned scale with what was actually delivered, so an unreachable
remainder is not quietly handed to whoever stayed.

Do not halt — a halt traps people. Do not convert HFyc into the memecoin. Do not let a holder pick
which launch to peel: the order is protocol-defined, quietest-first by recent volume.

10 bps of each exit stays unminted. The exiting holder benefited from the rebalancing that kept the
book solvent, and the remaining holders inherit the cost.

## 12. Meme-side honesty

HFyc is senior. 2x is **rented**.

If a route is filled, the coin’s leverage falls toward 2.0 on a smaller collateral book, or toward 1x if senior leaves entirely. NAV of remaining junior is not robbed by a fair unwind; **future** ETH beta is smaller.

Copy on the coin page, not in a footnote:

> 2x ETH, variable. If ETH dumps, the vault sells to USDG to protect HFyc and this coin’s leverage falls. HFyc can exit. This ticker can go to zero at a 50% ETH gap if that gap is one print.

Primary mint/redeem of the memecoin uses a CR-aware fee: cheap near L = 2, steep as L → 2.5 on junior exits (leaving raises L), steep as L → 1.5 on junior mints (arriving lowers L). Fees stay in the pool (cushion), they are not a buyback.

---

## 13. Protocol fee as HFyc, creator toggle

### 13.1 Protocol (always HFyc)

The 45 bps protocol slice is **never ETH in the treasury**. Path: §5.3. Locked. After the lock, the treasury may redeem at nav or hold. Holding is the alignment. Redeeming is the same ETH they would have been paid in the first place — which is why the lock exists.

### 13.2 Creator toggle

Set once in `createLaunch`, immutable:

```
creatorFeeInHfyc: bool
```

| | Creator receives | Risk |
|---|---|---|
| `false` | Claimable ETH, pull not push (current `Launch.sol` reason: a reverting recipient must not brick trading) | ETH beta on fees |
| `true` | §5.3 mint, creator lock | HFyc yield, senior risk, no ETH upside on that income |

No per-trade flip. They can buy HFyc in the market if they picked ETH.

Accrue-and-claim for ETH. Do not push ETH on every swap.

---

## 14. Supply accounting (show this on the Earn Pool page)

```
HFyc_supply = deposit_minted + fee_minted
```

NAV yield increases neither. If the UI shows "price up" from a fee mint, it is lying: a fee mint is
assets in *then* shares out at the prevailing nav, which is a deposit.

Show:

- `nav`, and `earnPoolApyWad` beside it
- `earnPoolYieldMixWad` — the split between rent and cash income. A book returning 99% trade fees
  behaves nothing like one returning 99% rent, and only one of them survives a quiet day
- deposit-minted vs fee-minted supply
- idle USDG, idle WETH, and collateral still in pools
- `global_CR`
- `ethDropToImpairmentWad` — how far collateral can fall before the senior takes losses, ignoring
  any rebalancing. The gap-risk number, computed from live state and **with** the current cash mix
- occupancy settled vs pending (pending is **not** nav; redeem settles first)

Do **not** put `fundingRateWad` on the page as "APY". That is the occupancy rate 2x coins pay on
attached senior (2% base, 10% at healthy utilisation, up to 70% fully deployed, **zero above 2.5x**).
Holder return is `earnPoolApyWad`, measured over a trailing window. The two are not close.

---

## 15. Locked starting parameters

| Parameter | Value | Notes |
|---|---|---|
| `targetL` | 2.0 | CR 200% |
| No-action band | [1.5, 2.5] | Where the fee curve is flat |
| Sell route | opens 2.20, spot 2.50, outer 3.00 | +50 bps → 0 → −200 bps |
| Buy route | opens 1.80, spot 1.50, outer 1.20 | −50 bps → 0 → +200 bps |
| Collateral | ETH. See §21 for the multi-collateral shape | Cash is USDG |
| Total trade fee | 125 bps flat | 2x: creator 30 / protocol 45 / holders 50. 1x: 30 / 95 / 0 |
| Leverage surcharge | 0 at target → 250 bps at an edge | Cushion, not income. Ceiling 700 bps all-in |
| Cover surcharge | 0 at CR 1.5 → 400 bps at CR 1.0 | Exits only |
| Pairing fee | 50 bps of the **high-water** senior | Unminted. The same dollars are never billed twice |
| Occupancy | kinked: 2% base, 10% at 80% utilisation, 70% fully deployed | Per-second index; 0 if L ≥ 2.5 |
| Swap minOut | 99% of oracle | Orphan sweep, fee swaps, idle conversions. **Routes have no minOut** |
| `MAX_SELL_BPS` | 15% of vault per route fill | In-kind peels are uncapped: they touch no book |
| Launch cap | none | Scarcity is priced through the occupancy curve, not capped |
| Oracle | conf ≤ 2% of P, age ≤ 25h | Fail closed. 25h matches the Robinhood ETH/USD heartbeat |
| Redeem fee | 10 bps | Unminted |
| Yield window | 24h, min 1h sample | `earnPoolApyWad` is measured, never promised |
| Meme supply | 1,000,000,000 | Junior |
| Headline raise | 6.9 ETH | Cap is the ETH amount, so the goalpost cannot drift with the dollar |

---

## 16. Invariants (test these or the spec is fiction)

After every successful public function:

1. `nav × supply = liability` (1 wei rounding).
2. `liability + Σ memeNAV = Σ TVL + idle_USDG + idle_WETH × P`, whenever a price exists.
3. `memeNAV_i = max(TVL_i − senior_i, 0)`.
4. No HFyc exists whose backing is unpaired collateral.
5. Fee mint: `Δsupply × nav = Δidle` (within swap slippage); nav does not drop.
6. Holder 50 bps + pairing + occupancy + route spread: `Δliability` with `Δsupply = 0` (nav up).
7. A sell-route fill moves L toward 2.0 and does not cut junior NAV beyond the booked route spread.
8. **No rebalance reads DEX spot.** Route prices are `P × f(L)`: oracle and schedule only.
9. `global_CR > 1` ⇒ redeem pays ≤ assets, and the remaining CR does not fall.
10. `global_CR ≤ 1` ⇒ every exit is pro-rata; no wallet receives more than `shares/supply`.
11. Occupancy never drives `memeNAV` below 0, and is 0 at L ≥ 2.5.
12. The creator toggle cannot change after `createLaunch`.
13. The Launch implementation cannot be `initialize`d twice; clones only.
14. **vHFyc reconciles:** `senior = minted − burned`, and `highWater ≥ senior`.
15. **The pairing fee is billed once:** `pairingBilled ≤ seniorHighWater`.
16. **The quote stays reachable:** `juniorEth ≤ reserveEth + max(vaultEth − senior/P, 0)`.
17. **Idle assets are real:** the Earn Pool's USDG balance covers `idle_USDG`, its WETH balance
    covers `idle_WETH`.

Identity 2 is exact only while a price exists. The price-free `emergencyRedeem` retires the same
*fraction* of a pool's claim as it takes of its collateral, and those are equal in value only when a
feed exists to say so — which is precisely when that path is not in use.

---

## 17. Failure modes, named

**Slow dump.** The sell route opens at 2.2x, fillers ratchet the senior into USDG, nav holds, memes delever. This is the intended path — and it depends on somebody filling. The route pays a premium near the inner bound precisely so that somebody does.

**Gap −50% one oracle print.** Junior zero. HFyc nav = leftover / supply, possibly below $1. Pro-rata exit. This is not a bug. 2x means a *larger* gap than 3x, not no gap.

**Thin USDG book.** Rebalancing is unaffected: a route has no `minOut`, so a thin book means it fills slowly, not that it fails. Fee swaps and the orphan sweep still revert rather than take a bad fill, and neither blocks anything — booked fees wait, and holder exits are paid in kind. Do not widen minOut to "make it work."

**No idle cash.** No 2x pairs. Coins can still sell on the curve; they do not graduate into fake leverage.

**2-minute coin, huge volume.** HFyc nav jumps from the 50 bps + pairing bps. Funding ≈ 0. Correct.

**2-minute coin, zero volume, instant dump.** Pairing bps is the only yield. `protect()` may slip against junior. HFyc should still be whole if the move is inside −50% and txs land. If not, §17 gap.

**Protocol sells fee-HFyc.** Equivalent to having been paid USDG. Depositors were not diluted at mint (assets in, then shares out). Fee-minted shares are liquid; alignment is that the treasury holds the senior of live 2x pools, not a time-lock.

**All launches are ETH.** Isolation does not save HFyc from one crash. USDG idle is the only diversifier until another collateral type exists.

**Junior mint at NAV without new senior.** L falls. If it hits 1.5, optional relever. Do not steal the minter’s ETH into senior.

---

## 18. Contract surface

Throw away: `MockLendingPool` as a production facade, flash-loan build/relever/recall, skim-into-Morpho, 80% LTV, 3x blended, self-hosted NAV AMM as the only market.

Keep: isolated clones, oracle conf/staleness, fee accrue-not-push, factory param guards, swap minOut, “no buyback with holder collateral.”

New:

1. **`HFyc`** — ERC-20 + `nav()`, mint against USDG/ETH, `redeem`/`redeemTo`, fee-mint (always liquid), idle USDG.
2. **`Launch` clone** — curve, pair, junior mint/redeem, `protect`, funding index, fee split.
3. **`LaunchpadFactory`** — whitelist, `createLaunch(..., creatorFeeInHfyc)`, launch cap `f`, register pool with HFyc.
4. No Morpho adapter. No 1 Hz keeper. `protect()` is permissionless; a bounty from the 10 bps redeem fee is enough.

---

## 19. Formula sheet

```
// Leverage
L  = TVL / (TVL − senior)          CR = TVL / senior          targetL = 2
senior_needed_to_pair = raiseUsd   // because targetL = 2

// vHFyc — the per-pool virtual senior unit
senior       = minted − burned
highWater    = max over time of senior
claimEth     = senior / P
coverage     = vaultEth / claimEth        // 1.0 at attach, decays with fees and spreads
reserveCover = reserveEth / juniorEth     // < 1 means the quote is not reachable
juniorEth    = reserveEth + vaultEth − claimEth

// The Earn Pool
nav       = liability / supply             // $1 if supply = 0
liability = Σ senior_i + idle_USDG + idle_WETH × P
global_CR = (Σ TVL_i + idle_USDG + idle_WETH × P) / liability
pair_mint = usd / nav
fee_mint  = usdReceived / nav              // assets in, then shares out
APY       = (yield over window / avg liability) × (year / elapsed)

// Piecewise-linear schedules — every reactive price and fee in the system
segment(x; x0→x1, y0→y1) = clamp flat outside, linear between   // x0 > x1 allowed

// Rebalance routes
routePrice = P × f(L)
  sell f: 2.20→1.0050,  2.50→1.0000,  3.00→0.9800
  buy  f: 1.80→0.9950,  1.50→1.0000,  1.20→1.0200
d = (TVL − targetL·J) / (P · (targetL·f − (targetL − 1)))       // = (TVL − 2J)/P at f = 1
capped at 15% of vaultEth per fill; buy side also capped at idle cash
routePnl += cashLeg − d·P                                       // signed, lands on the junior

// Netting — no trade at all
Δ = min(seniorExcess_src, seniorGap_dst)
seniorExcess = max(senior − J, 0)      seniorGap = max(J − senior, 0)
collateral and claim move together at P  ⇒  ΔJ = 0 on both sides, Δliability = 0

// Bucket correction
Δ = max(vaultEth − claimEth, 0)        // vault → AMM reserve; TVL, J and L unchanged

// Occupancy (per pool, on touch)
r(U) = 2% + 8%·(U/0.8)                       U ≤ 0.8
     = 10% + 60%·(U − 0.8)/0.2               U > 0.8
owed = senior × r(U) × dt / secondsPerYear   // 0 if L ≥ 2.5
senior += min(owed, memeNAV)

// Fees (quote ETH)
flat      = 125 bps                 // 2x: 30 creator / 45 protocol / 50 holders. 1x: 30 / 95 / 0
surcharge = segment(L; 2 → edge, 0 → 250 bps) [+ coverSurcharge on exits]   // ceiling 700 all-in
coverSurcharge = segment(global_CR; 1.5 → 1.0, 0 → 400 bps)
  → the surcharge goes into the AMM reserve as cushion, NOT into any fee stream
pairing   = 50 bps × max(senior_after − pairingBilled, 0)      // high-water basis

// Exit
in kind:   usdgOut = min(idle, shares × nav);  ethOut = shortfall / P peeled quietest-first
           per pool: vaultEth −= E, senior −= E·P    ⇒  ΔmemeNAV = 0
pro-rata:  usdgOut = idle × s/supply;  ethOut = (idleWeth + Σ vaultEth) × s/supply   // no price
```

---

## 20. The rule that makes the rest hold

HFyc is a dollar-senior that **starts** at $1 and **rises** only when assets enter without a
matching mint: fees, pairing, occupancy, and the spread the protocol earns for de-risking. The
memecoin is the residual on the collateral.

When the collateral falls, the protocol does not go to market. It **posts a price at which somebody
else will take the collateral and hand back the cash**, and moves the senior out with that cash —
so de-risking cannot be reverted by the thin book that the fall itself created. When two pools want
opposite things, they are matched directly and no market is involved at all.

When the residual is gone, $1 is over and everyone remaining is pro-rata — and they can always get
out, because the exit hands over what the book holds rather than converting it first.

No loop. No second token. No naked mint. No execution risk on the protocol's own defence. No APR
that pretends a 2-minute coin paid rent.

---

## 21. Multi-collateral and routing

HFyc is a dollar claim and vHFyc is denominated in dollars, so a claim against a BTC pool and one
against an ETH pool are the same unit. The senior token does not care which asset backs it. The risk
machinery does.

```
Collateral { oracle, router, pooled, idle, seniorUsd, capBps, enabled }
```

Each listed asset carries its own feed, its own venue for cash conversions, its own collateral
ratio, its own cap, and its own price for renting senior. `totalAssetsUsd` sums the registry, each
leg marked with its own oracle. `global_CR` is unchanged in meaning.

This needed **no change to `Launch`**. Every senior mint or burn already routes through `lendIdle`,
`moveSeniorToIdle`, `accrueFunding` or `receiveSeniorInKind`, and every collateral move through
`addPoolEth` / `subPoolEth` — all `onlyPool`, so the asset is attributable from `msg.sender`.

### Routing, priced where the choice is made

Deposits are cash and do not pick an asset. A pool attaching senior against one does.

```
r_asset(U) = r(U) + segment(CR_asset; 2.0 → 1.0, 0 → 30% APR)
```

Renting senior against a thin collateral costs more rent than renting against a thick one, so flow
moves toward cover on its own. `fundingRateWad()` keeps its signature and returns the calling pool's
asset-aware rate; anything that is not a registered pool gets the book-wide rate.

The hard half is the cap: `lendIdle` refuses a loan that would push an asset past
`capBps × liability`. `_tryPair` catches the revert, so a coin at the ceiling graduates unlevered and
retries rather than breaking.

### Constraints that hold

1. **One dead feed fails only its own asset.** `totalCollateralUsd` skips a stale leg instead of
   reverting — otherwise a single quiet oracle would take `nav()` down and trap every priced exit on
   every other asset.
2. **`emergencyRedeem` still needs no price.** One asset per call, still a pure ratio of quantities.
3. **Netting and reallocation stay within an asset.** Across assets that is a swap, and swaps belong
   on a route.
4. **A per-asset cap.** One listing cannot become the whole book's risk however loud its tape.
5. **Exits name their token.** A mixed peel list reverts rather than paying a basket nobody chose.
6. **The research files are per asset.** `collaterals.csv` and the `collateral_samples` table: a
   single aggregate stops meaning anything the moment there are two.

A creator picks their collateral by picking the launchpad, and it is immutable for the same reason
the 2x toggle is. Isolation contains a bad listing; it does not diversify beta.
