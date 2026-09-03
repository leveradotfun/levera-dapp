# Levera

A memecoin launchpad on **Robinhood Chain** (Arbitrum Orbit, chain id **4663**) with an optional 2x overlay. Memecoins are the product. **LYC** is dollar-senior credit that 2x coins rent, held in the **Earn Pool**. No lending-pool facade, no mint/burn of the meme after launch, and no donating the raise into a Uniswap LP so dumpers can steal it.

Full docs: `docs/` (Mintlify — `cd docs && mint dev`). Mechanism spec: `LEVERA.md`.

## How it works

### 1. Launch (fixed 1B supply)

Every coin is an EIP-1167 clone of `Launch`:

- **1,000,000,000** tokens minted to the launch contract at creation.
- **800,000,000** sit on a constant-product bonding curve.
- **200,000,000** plus the raise seed a TOKEN/ETH AMM at graduation.

The curve is quoted **in ETH**, not USD — the quote asset and the custodied asset are the same thing on purpose, because a USD-quoted curve holding ETH is insolvent the moment the oracle moves. Virtual reserves are set so that selling the full 800M raises a fixed **6.9 ETH** (`m = 4/3`):

- `Vt0 ≈ 1.0667B`, `Vu0 = 2.3 ETH`
- Last curve tick = listing price = `6.9 ETH / 200M`

A creator buy is an ordinary curve buy at the same 1.25% fee, and it **does** move the spot. That impact is logged to `data/events.csv` as a `LAUNCH` row, with a `_wei` companion on every price so a float64 read cannot silently render a ~2e-9 number as zero.

Toggle **2x** at creation. The flag is immutable — flipping it after the curve filled would let a creator attach leverage only once it was free. 1x coins never pull senior.

The creator's 0.30% is paid in the coin's **quote asset** — cbBTC on a cbBTC-quoted coin, WETH on a WETH one. A 2x creator may instead take LYC mint-at-NAV; a 1x creator may not, because a coin that never pairs against the Earn Pool would be minting senior out of trade fees with no occupancy behind it. The choice is frozen at creation (`createLaunch` reverts "1x quote fees" otherwise).

### 2. Graduation → AMM

When the raise is met or the 800M is gone, `_graduate()`:

1. Marks the curve closed.
2. Wraps the raise as WETH and seeds `MemePair` (Uniswap V2-style `xy=k`), deployed by `MemePairFactory`.
3. If 2x is on, `_tryPair()` borrows idle Earn Pool cash, buys real ETH, and parks it in `vaultEth`.

Two collateral buckets after that:

| Bucket | What it is | Who can take it |
|---|---|---|
| `reserveEth` | AMM reserve | Anyone selling the meme (15% of reserve per swap) |
| `vaultEth` | Senior collateral | Route fills, redemption peels, netting, `rebalanceToReserve` |

2x pricing uses `juniorEth` (`reserveEth + vaultEth − senior/P`) as the ETH side of `k`, so spot moves ~2x with the collateral **without** putting vault ETH in the dumpable book.

The mirror of that is `reserveCover = reserveEth / juniorEth`. The AMM quotes off `juniorEth` but can only *pay* from `reserveEth`, and on a rally the senior claim shrinks in ETH terms so part of the vault stops backing senior and starts belonging to the junior — while sitting where a seller cannot reach it. `rebalanceToReserve()` moves exactly that excess and nothing else: TVL, junior NAV and leverage are all unchanged.

### 3. vLYC — the senior claim is a supply, not a number

`seniorUsd` is the supply of a per-pool virtual unit. One vLYC is one dollar of the Earn Pool's claim in that pool, minted when senior attaches and burned when it leaves. It is deliberately not transferable.

```
memeNAV = TVL − senior      CR = TVL / senior      L = TVL / memeNAV
```

The counter carries history — cumulative mint/burn (churn), and a high-water mark. That high water is what the pairing fee is billed against, so senior that leaves on a route fill and comes back is **not** charged 50 bps twice for the same dollars.

### 4. Rebalancing: the protocol posts a price, it does not trade

Three mechanisms, in order of preference. All permissionless.

**Netting.** A pool above target has senior it does not need; a pool below target wants it. `EarnPool.netSeniorBetween` moves the claim and its collateral directly between them, in kind. No collateral sold, no cash spent, no spread, no counterparty — and both pools move toward 2x in one transaction.

**Routes.** `routePrice = P × f(L)`, a piecewise-linear schedule. The sell route opens at **L = 2.20**, prices *above* spot there (the pool is paid to de-risk), crosses at spot at 2.50, and subsidises out to 3.00. The buy route mirrors it at 1.80 / 1.50 / 1.20.

There is no `minOut` anywhere in this path, which is the entire point: the moment de-risking is most needed is the moment the venue is worst, and a route that a thin book cannot fill is a route that fills slowly, not one that reverts. The spread is booked signed to `routePnlUsd` and lands on the junior — the party renting the leverage.

**The surcharge.** A trade dragging the book toward an edge pays 0→250 bps on top of the flat 125, plus a cover surcharge on exits as global CR thins. It is not income: it goes into the AMM reserve as cushion for whoever is still holding.

`protect()` is now only the orphan sweep, confined to pools whose junior is already gone. It is the one place a venue remains in the path, because a route needs somebody to fill it and a dead coin has nobody watching.

### 5. Multi-collateral

One senior claim, many collaterals. LYC is a dollar claim and vLYC is denominated in dollars, so a claim against a BTC pool and one against an ETH pool are the same unit; the senior token does not care which asset backs it. The risk machinery does — each listed asset gets its own oracle, its own venue for cash conversions, its own collateral ratio, its own cap, and its own price for renting senior.

```solidity
earnPool.addCollateral(token, oracle, router, capBps);
earnPool.collateralCr(token);           // this asset's cover
earnPool.fundingRateFor(token);         // rent, including this asset's routing surcharge
earnPool.collateralHeadroomUsd(token);  // how much more senior it may take
```

Routing is priced where the choice is actually made. Deposits are cash and do not pick an asset; a pool attaching senior against one does. So renting senior against a thin collateral costs more rent — `segment(CR_asset; 2.0 → 1.0, 0 → 30% APR)` on top of the book-wide utilisation curve — and flow moves toward cover on its own. The hard half is the cap: `lendIdle` refuses a loan that would push an asset past `capBps × liability`, and `_tryPair` catches the revert so a coin at the ceiling graduates unlevered and retries rather than breaking.

A creator picks their collateral by picking the launchpad, and it is immutable for the same reason the 2x toggle is.

**This needed no changes to `Launch`.** Every senior mint or burn already routed through `lendIdle` / `moveSeniorToIdle` / `accrueFunding` / `receiveSeniorInKind`, and every collateral move through `addPoolEth` / `subPoolEth` — all `onlyPool`, so the asset is attributable from `msg.sender`. That mattered: `Launch` has 63 bytes of headroom.

A dead feed on one asset skips that leg rather than reverting the valuation. Otherwise one quiet oracle would take `nav()` down and trap every priced exit on every other asset.

**Two quote assets today: WETH and cbBTC.** The quote asset *is* the collateral — a launch is denominated in it, pairs against it, and is levered against it. A launchpad is bound to one at construction, so a creator picks their quote by picking the launchpad.

`Launch` takes its quote as a plain ERC-20 and nothing else, because cbBTC has no native form: `msg.value`, `call{value:}` and `weth.deposit` have no equivalent for it. Native ETH is wrapped at the edge by `QuoteZap`, which holds nothing between calls and refunds an overshoot as native ETH.

cbBTC is **8 decimals**, and that is load-bearing. The oracle prices one whole token, so a raw balance multiplied by a price without scaling under-reports by 1e10. Everything internal stays in the quote's own units; only the USD boundary scales — `Launch.quoteScale`, `Collateral.scale`, `OracleSwapRouter.collateralScale`. All three were caught by testing against a genuinely 8-decimal token. The `CBBTC/USD` feed is live on Robinhood Chain (`0x0009cD49…`); the cbBTC **token** is not deployed there yet, so the deploy pairs the real feed with a stand-in that has the right decimals.

### 6. The Earn Pool

Depositors mint LYC against USDG (or collateral sold to USDG on arrival), issued at $1 NAV. Holding LYC *is* being in the Earn Pool — there is nothing to stake, which is why supply never moves when yield arrives. NAV rises only when value arrives **without** new shares:

- Occupancy rent 2x memes pay on attached senior (no cash in; junior NAV down).
- The pairing 50 bps, billed on high-water senior.
- The harvested 50 bps holder slice of the 1.25% trade fee, **2x only**. 1x is 30 creator / 95 protocol / 0 holders.
- Route spread earned near the inner bound.

```solidity
earnPool.earnPoolApyWad();        // realised return over a trailing window, annualised
earnPool.earnPoolYieldMixWad();   // the split between rent and cash income
earnPool.fundingRateWad();        // the occupancy RATE — not APY, never show it as one
```

The occupancy rate (2% base, 10% at 80% utilisation, up to 70% fully deployed, zero above 2.5x) is what 2x coins pay. It is not what holders earn, and the two are not close in a fee-driven book. Publish the mix beside the headline so nobody has to infer it.

### 7. Exit — a holder is never locked in

```solidity
earnPool.redeem(shares);                      // cash only; says so if idle is short
earnPool.redeemInKind(shares, peelFrom);      // cash + WETH; cannot fail on liquidity
earnPool.emergencyRedeem(shares, peelFrom);   // pro-rata, needs no price at all
```

The exit pays what the book holds — idle cash first, then WETH peeled quietest-first — and converts **nothing** on the holder's behalf. The moment a redemption routes through a venue, a holder's access to their own money depends on a fill they never asked for, at a size they did not choose, and a bad book leaves them with neither the cash nor the collateral.

Each peel moves collateral and claim together at the oracle price, so `memeNAV` is unchanged: what the meme loses is leverage, not value. There is no per-call cap on the in-kind path — the 15% cap exists to stop one transaction dumping a vault into a thin book, and an in-kind transfer touches no book. It is also strictly cheaper than the swap it replaces, which gave up to 1% to the router on every exit.

`emergencyRedeem` is a ratio of quantities throughout, so it works when the oracle does not. `nav()` fails closed on a stale feed — right for minting and for sizing a rebalance, wrong for exit.

Anyone wanting a specific token swaps it themselves afterwards: their transaction, their slippage tolerance, and a failed conversion costs a retry instead of trapping the withdrawal.

## Apps

| App | Port | Role |
|---|---|---|
| `contracts/` | — | Solidity, tests, `./anvil-fork.sh` |
| `ui/` | 3001 | Admin console: deploy, bots, keeper, collateral shock, research files |
| `frontend/` | 3002 | Public launchpad: create coins, trade, Earn Pool |
| `docs/` | 3000 | Mintlify docs |
| `db/` | — | Postgres store, schema, wipe scripts |
| `testnet/` | — | Robinhood **testnet** (46630) deploy harness — see `testnet/README.md` |

Always develop against a **Robinhood fork** (`./contracts/anvil-fork.sh`, chain 4663, shanghai). Plain Anvil 31337 is rejected. Wipe reverts an `evm_snapshot` taken at fork start — a bare `anvil_reset` disables the fork.

```bash
./contracts/anvil-fork.sh          # keep this running
cd contracts && forge test --nmt invariant
cd ui && npm run dev               # :3001 — Deploy is always a tab
cd frontend && npm run dev         # :3002
```

For the real chain's testnet instead of a fork, deploy from `testnet/` and point the apps at it with one variable — `NEXT_PUBLIC_RPC_URL=https://rpc.testnet.chain.robinhood.com` — which switches the provider, the wallet transport, the storage key, and the deployment file (`data/deployment-testnet.json`) together. The mock oracles are seeded with the real mainnet feed prices at deploy and re-synced by `testnet/refresh-prices.mjs`.

After contract changes:

```bash
cd contracts && forge build --sizes && python3 extract-abis.py && python3 audit-app-calls.py
```

`--sizes` is not optional. `Launch` sits within ~60 bytes of the EIP-170 24,576-byte runtime cap, and a contract over it fails at CREATE with **empty revert data** — which surfaces as an unexplained deploy failure, not as a compile error. `MemePair` is deployed by `MemePairFactory` rather than with `new` for exactly this reason.

## Postgres

Durable home for the data that used to live in browser `localStorage` — NAV history, price points, the trade ledger, rebalances, X profiles, and per-asset `collateral_samples`.

```bash
createdb levera          # once
cd db && npm run smoke       # schema + store round trip
```

The schema **applies itself**. `ensureSchema()` runs before the first query in every process, so a fresh clone or a dropped database is a non-event rather than an opaque 500 halfway through a session. `db/schema.sql` is idempotent throughout; keep it that way.

A console **Deploy wipe** truncates every session table and clears the CSVs, automatically. It wipes *all* rows, not the outgoing factory's: the factory address is read from a local file the wipe itself deletes, so scoping it left earlier sessions' rows behind after a crash, on a fresh clone, or on a second redeploy — and two incompatible books in one series silently changes what every aggregate means.

```bash
cd db && npm run wipe        # clean slate by hand
cd db && npm run counts      # what is in there
```

`x_profiles` deliberately survives a wipe: it maps a wallet to the X account that claimed it, and that is not session state.

## Research files

Three append-only CSVs under `data/`, served at `/api/session-log?file=…`:

| File | One row per | Answers |
|---|---|---|
| `book.csv` | interval | What is the senior claim worth, what backs it, what did it earn |
| `pools.csv` | pool, per interval | Where is each pool's leverage, and is its quoted price reachable |
| `collaterals.csv` | listed asset, per interval | Each asset's price, cover, cap, headroom and rent |
| `events.csv` | discrete event | Launches, route fills, netting, exits, shocks, errors |

Every row carries `writer` and `seq`, because three processes append concurrently and rows arrive out of order. Every sub-1e-6 price ships a `_wei` companion. A column that cannot be computed is blank — never zero, never a stale carry-forward.

`DELETE /api/session-log` truncates them back to headers, and a console **Deploy wipe** does it automatically alongside the database.

Schema changes migrate the files in place on the next write: old rows keep their values **by column name**, removed columns are dropped, and columns that did not exist then are blank rather than zero.

### Measuring leverage requires moving the price

The fork pins its Chainlink feed at the fork block. On an untouched session the collateral price never moves, and every leverage attribution divides by zero — `realized_leverage` and `tracking_error_pct` are blank because there is nothing to divide by, not because they are broken.

The console's **Collateral shock** panel drives the price through a `ShockableOracle` wrapper: step, grind, sine round trip, and gap presets. Every row written while a shock is applied carries `oracle_shock_pct` and `shock_path_id`, so a shocked session can never be mistaken for a live one.

`ShockableOracle` lives in `mocks/` and must never be pointed at on a live deployment: it has an owner who can move the price the whole protocol values itself against.

## Design notes worth knowing

- 2x means a **−50% collateral gap in one print** wipes the junior, and further drop is first-loss on the senior. That is the product. But a pool that has drifted to L = 2.3 is materially closer to that than the target implies — every published risk number is derived from live state, never from `targetL`.
- The routes are an **incentive, not a guarantee**. If nobody fills, a pool stays drifted. That is why the sell route opens at 2.20 rather than at a cliff, and why netting exists.
- Two-wallet wash can still game the recent-volume score that ranks where scarce senior sits. Same-wallet round trips cannot. That residual is accepted.
- The oracle heartbeat is 24h; reads fail closed after 25h.
- Test USDG/WETH are mock mintable 18-decimal tokens. Live USDG is 6-decimal — production must not use the mocks.
- `createLaunch` is permissionless; clones initialize in the same transaction, so there is no front-run window.
- Multi-collateral is **built**. Each listed asset carries its own feed, venue, collateral ratio, cap and rent surcharge; `Launch` needed no changes because every senior and collateral mutation already routed through `onlyPool` calls. See `LEVERA.md` §21 and `docs/protocol/multi-collateral.mdx`.
- Isolation contains a bad listing; it does not diversify beta. A broad selloff stresses every asset at once and the senior claim feels a share of it.
