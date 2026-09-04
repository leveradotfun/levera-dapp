/// Read-only smoke test against the live testnet deployment. No key, no transactions — every
/// write path is only exercised for argument encoding via `staticCall`-style reads. Run:
///
///   npm run build && npm run smoke
///
import { loadDeploymentFile } from "../dist/node.js";
import { LeveraSDK, usd, usdCompact, formatWad, formatQuoteAmount, WAD } from "../dist/index.js";

const DEPLOYMENT = new URL("../../data/deployment-testnet.json", import.meta.url).pathname;

let failures = 0;
function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const deployment = loadDeploymentFile(DEPLOYMENT);
const sdk = new LeveraSDK({ deployment });

console.log(`Levera SDK smoke test — ${deployment.network ?? "unknown"} (chain ${deployment.chainId})\n`);

// 1. chain wiring
const net = await sdk.provider.getNetwork();
check("provider reaches the chain", Number(net.chainId) === deployment.chainId, `chainId=${Number(net.chainId)}`);

// 2. tokens + oracle
const [wethSymbol, usdgSymbol, wethDecimals, usdgDecimals] = await Promise.all([
  sdk.weth().symbol(),
  sdk.usdg().symbol(),
  sdk.weth().decimals(),
  sdk.usdg().decimals(),
]);
check("WETH token reads", ["WETH", "mWETH"].includes(wethSymbol) && wethDecimals === 18, `${wethSymbol} ${wethDecimals}dp`);
check("USDG token reads", usdgDecimals === 18, `${usdgSymbol} ${usdgDecimals}dp (testnet mock is 18; live is 6)`);

const ethPrice = await sdk.oracle("weth").collateralPriceUsd();
check("ETH oracle price", ethPrice > 0n, `${usd(ethPrice)}`);

if (deployment.cbbtcOracle) {
  const btcPrice = await sdk.oracle("cbbtc").collateralPriceUsd();
  check("cbBTC oracle price", btcPrice > 0n, `${usd(btcPrice)}`);
  const btcDecimals = await sdk.cbbtc().decimals();
  check("cbBTC decimals", btcDecimals === 8, `${btcDecimals}dp`);
}

// 3. earn pool
const stats = await sdk.earnPool().stats();
check("EarnPool stats", stats.totalAssetsUsd > 0n || stats.poolCount > 0n, `nav=${usd(stats.navUsd)} apy=${formatWad(stats.apyWad, 2)}% pools=${stats.poolCount}`);
check("EarnPool oracle live", stats.oracleLive, `cr=${formatWad(stats.globalCrWad, 3)}`);

// 4. launches across BOTH pads
const launchpads = sdk.launchpads.map((p) => p.id);
check("both launchpads present", launchpads.includes("weth") && launchpads.includes("cbbtc"), launchpads.join(", "));

const all = await sdk.allLaunchAddresses();
console.log(`\n  ${all.length} launch(es) across ${launchpads.length} pads`);

if (all.length > 0) {
  const summaries = await sdk.allLaunchSummaries();
  check("summaries resolve", summaries.length > 0);

  for (const s of summaries.slice(0, 4)) {
    const phase = s.graduated ? "AMM" : "curve";
    console.log(
      `   • ${s.symbol.padEnd(8)} ${phase.padEnd(5)} raised ${usdCompact(s.raisedUsd)} of ${usdCompact(s.targetUsd)}` +
        ` (${s.pctToGraduation.toFixed(1)}%)  mcap ${usdCompact(s.marketCapUsd)}  quote ${s.meta.quoteSymbol}`
    );
    check(
      `${s.symbol}: USD math respects quoteScale`,
      s.meta.quoteDecimals === 8 ? s.meta.quoteScale === 10n ** 10n : s.meta.quoteScale === 1n,
      `scale=${s.meta.quoteScale} decimals=${s.meta.quoteDecimals}`
    );
    check(`${s.symbol}: raised consistent`, s.raisedUsd <= s.targetUsd * 2n || s.graduated, `${usd(s.raisedUsd)}`);
  }

  // 5. live quotes on the first coin
  const coin = sdk.launch(all[0]);
  const meta = await coin.meta();
  const buyAmount = 10n ** BigInt(meta.quoteDecimals); // one whole quote token
  const tokensOut = await coin.quoteBuy(buyAmount);
  check("quoteBuy returns tokens", tokensOut > 0n, `1 ${meta.quoteSymbol} → ${formatWad(tokensOut, 2)} tokens`);
  const spot = await coin.spotPriceQuote();
  check("spot price reads", spot >= 0n, `spot=${spot.toString()} quote-WAD/token`);

  // sell quote of what we would have bought
  const quoteBack = await coin.quoteSell(tokensOut);
  check("quoteSell round-trips", quoteBack > 0n && quoteBack < buyAmount, `${formatQuoteAmount(quoteBack, meta.quoteDecimals)} ${meta.quoteSymbol} back (fee 1%)`);

  // 6. creator fee view + summary of creator
  const fees = await coin.creatorFees();
  check("creatorFees read", fees.inHfyc === true || fees.pendingQuote >= 0n, `inHfyc=${fees.inHfyc} pending=${formatQuoteAmount(fees.pendingQuote, meta.quoteDecimals)}`);

  const creator = meta.creator;
  const own = await sdk.launchSummariesByCreator(creator);
  check("launchesByCreator", Array.isArray(own), `${own.length} coin(s) by creator`);
} else {
  console.log("  (no launches yet — create one from the app, then re-run)");
}

// 7. factory view paths (minRaise / cap)
const pad = sdk.launchpad("weth");
const padMeta = await pad.meta();
check("factory minRaise", padMeta.minRaise === 10n ** 17n, `minRaise=${formatWad(padMeta.minRaise)} WETH`);
check("factory creator cap", padMeta.creatorBuyCapBps === 2000n, `${padMeta.creatorBuyCapBps} bps`);

// 8. pure math sanity (no chain): fresh-curve dev-buy preview
const { previewCreatorBuy, TOTAL_FEE_BPS, parseQuoteAmount } = await import("../dist/index.js");
const target6900 = parseQuoteAmount("6.9", 18);
const small = previewCreatorBuy(target6900, parseQuoteAmount("0.1", 18), 2000n, TOTAL_FEE_BPS);
const fat = previewCreatorBuy(target6900, parseQuoteAmount("1", 18), 2000n, TOTAL_FEE_BPS);
check(
  "previewCreatorBuy math",
  small.tokensOut > 0n && !small.exceedsCap && fat.exceedsCap,
  `0.1 ETH → ${formatWad(small.tokensOut, 0)} (under cap) · 1 ETH → ${formatWad(fat.tokensOut, 0)} (cap ${formatWad(fat.capTokens, 0)}, correctly flagged)`
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
