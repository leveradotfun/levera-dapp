# @levera/sdk

TypeScript SDK for the **Levera** launchpad stack on Robinhood Chain (testnet `46630`). One client for the whole deployment: two launchpads (WETH- and cbBTC-quoted), their bonding-curve / AMM coins, the Earn Pool behind them, the native-ETH zap, and the oracle-priced routers.

Built on ethers v6. Reads work with a provider alone; writes need a signer. Runs in Node and the browser (the default entry never imports Node builtins).

## Install

```bash
cd sdk && npm install && npm run build   # from this repo (no published package yet)
```

Peer dependency: `ethers ^6.17.0`.

## Quick start

```ts
import { LeveraSDK, usdCompact, parseQuoteAmount } from "@levera/sdk";
import { loadDeploymentFile } from "@levera/sdk/node"; // Node only — browser users pass the JSON directly

// The record testnet/deploy.mjs publishes. A redeploy is a file swap, not a code change.
const sdk = new LeveraSDK({
  deployment: loadDeploymentFile("../data/deployment-testnet.json"),
});
```

### Reads (no signer)

```ts
// Every coin across BOTH pads — listing only the WETH factory hides every cbBTC coin.
for (const coin of await sdk.allLaunchSummaries()) {
  console.log(coin.symbol, coin.graduated ? "[AMM]" : "[curve]", usdCompact(coin.marketCapUsd));
}

const coin = sdk.launch("0x…");
const out = await coin.quoteBuy(parseQuoteAmount("0.1", 18)); // live quote, on the coin's current venue
const summary = await coin.summary();                     // raised / target / mcap / TVL / senior
const fees = await coin.creatorFees();                    // pending + lifetime, USD-marked

const stats = await sdk.earnPool().stats();               // NAV, CR, funding rate, APY, utilization
const ethUsd = await sdk.oracle("weth").collateralPriceUsd();
const btcUsd = await sdk.oracle("cbbtc").collateralPriceUsd();
```

### Writes (connect a signer)

`sdk.connect(signer)` returns a NEW instance bound to the signer; the original stays read-only.

```ts
const wallet = sdk.connect(signer);

// Create a coin on the cbBTC pad with a 0.5 cbBTC dev buy.
const pad = wallet.launchpad("cbbtc");
await pad.createLaunch({
  name: "My Coin",
  symbol: "MINE",
  targetRaise: parseQuoteAmount("6.9", 8),          // quote units — cbBTC is 8 decimals
  devBuy: { quoteIn: parseQuoteAmount("0.5", 8) },  // approval to the FACTORY is handled for you
});

// Trade a coin. Approvals, venue choice, and the graduation race are all handled:
await wallet.launch(coinAddress).buy({ amountIn: parseQuoteAmount("0.1", 18) });
await wallet.launch(coinAddress).sell({ tokensIn: tokenAmount, slippageBps: 200n });
await wallet.launch(coinAddress).buyWithEth({ amountIn: parseEther("0.1") }); // native ETH via QuoteZap
await wallet.launch(coinAddress).sellForEth({ tokensIn: tokenAmount });       // native ETH out

// Earn Pool
await wallet.earnPool().mintWithEth(parseQuoteAmount("1", 18)); // 1 ETH of value
await wallet.earnPool().redeem(shares);
// USDG → quote (oracle-priced router)
await wallet.router("cbbtc").swapUsdgForCollateral(usdgAmount, minOut);
```

Every trade result carries the **filled** amounts parsed from the fill event, not the quoted ones:

```ts
const fill = await wallet.launch(coin).buy({ amountIn, slippageBps: 100n });
fill.route;      // "curve" | "pool"
fill.quoteAmount;  // actually spent (curve buys refund the overshoot)
fill.tokensOut;    // actually received
```

### Keeper actions (permissionless)

```ts
const coin = wallet.launch(address);
await coin.graduate();           // once the curve is filled
await coin.tryPair();            // pair against LYC when the queue can cover senior
await coin.protect();            // sell reserve down to the senior claim
await coin.harvest();            // settle booked trade fees into NAV / fee mints
```

## Design notes

- **One source of truth for addresses.** The SDK reads the deployment record `deploy.mjs` publishes; nothing is hardcoded. `normalizeDeployment` accepts older records (`usdc`→`usdg`, `hfyc`→`lyc`).
- **Quote units, not WAD.** Contract amounts are in the quote asset's own units (WETH 18dp, cbBTC 8dp). `parseQuoteAmount(amount, decimals)` / `formatQuoteAmount(…)` do the conversions; `LaunchMeta.quoteScale` (1 or 1e10) is what lifts quote amounts to USD-WAD — every USD helper here applies it for you.
- **Curve math mirrors Launch.sol** (`src/curve.ts`): `curveBuyQuote`, `poolSellQuote`, `previewCreatorBuy` (the 20% creator-cap check), `minOutFromQuote` (slippage). Same formulas the fill uses — the fee is read live from the contract, not a stale constant.
- **The graduation race is handled.** A coin can graduate between the phase read and your fill; the SDK retries curve-closed buys/sells against the pool instead of leaving the trade dead.
- **Typed contract methods.** Each wrapper declares its method interface, so a wrong call is a type error, and a CI drift check can diff selectors against `contracts/out` (all currently match the forge artifacts the apps use).

## Tests

```bash
npm run smoke    # read-only pass against the LIVE testnet deployment — no key needed
```

Covers: chain wiring, token/oracle reads, Earn Pool stats, both pads, summaries with quoteScale-aware USD math, live buy/sell quotes, creator fees, factory constants, and the curve preview math.

## Layout

```
src/
  sdk.ts         LeveraSDK — the client (pads, coins, pool, zap, routers, oracles)
  deployment.ts  deployment record types + normalizer
  launch.ts      Launch — quotes, trades, summaries, keeper actions
  launchpad.ts   Launchpad — createLaunch (dev buy + cap preview), enumeration
  earnPool.ts    EarnPool — mint / redeem / stats
  periphery.ts   QuoteZap (native ETH) + SwapRouter (USDG ↔ quote)
  oracle.ts      IPriceOracle reads + quote↔USD conversions
  curve.ts       bonding-curve & AMM math (mirrors Launch.sol)
  abis.ts        human-readable ABIs, selector-verified against forge output
  format.ts      formatting helpers
  node.ts        @levera/sdk/node — loadDeploymentFile (fs lives here, not in the browser entry)
```
