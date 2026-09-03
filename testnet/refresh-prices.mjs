// Re-seed the testnet mock oracles from the real mainnet feeds.
//
// The mock oracles are snapshots, not feeds: without this script the testnet prices drift from
// the real market the moment the deploy is a day old. Run it whenever, or put it in a cron —
// it is one `setBothPrices` per oracle, and every read on the chain moves with the real market
// afterwards.
//
//   cd testnet && node refresh-prices.mjs
//
// Reads DEPLOYER_PRIVATE_KEY from .env: the oracles are Ownable and the deployer owns them.
// Honors the same price pins as deploy (TESTNET_ETH_USD etc.); without pins it reads live.
//
// CHANGES IN THIS SCRIPT, AND WHY
// --------------------------------
// deploy.mjs already got these three fixes; this script had regressed relative to it:
//   1. NO CHAIN-ID CHECK -> added (`requireChain`). This script signs owner-only transactions;
//      without the check it would happily send them to whatever TESTNET_RPC_URL points at.
//   2. NO RECEIPTS -> added (`sendTx`). `setPrice`/`setCashPrice` were awaited only to broadcast,
//      not inclusion, so a dropped or reverted update was reported as a success and the wrong
//      values were written into deployment-testnet.json.
//   3. PLAIN Wallet, NOT NonceManager -> switched. deploy.mjs's own comment explains why: this
//      RPC "twice handed back a nonce that had already been mined" under load, and this script
//      fires several transactions in a row.
//   4. TWO SEPARATE TRANSACTIONS PER ORACLE -> ONE. `setPrice` then `setCashPrice` left a window
//      where the chain held a fresh collateral mark against a stale cash mark -- every valuation
//      read inside that window was internally inconsistent, and the window was visible in the
//      mempool. `setBothPrices` marks both legs atomically.
import fs from "fs";
import { ethers } from "ethers";
import {
  DEPLOYED_TESTNET_PATH,
  artifact,
  testnetProvider,
  requireChain,
  requireKey,
  withRetry,
  sendTx,
  loadEnvFile,
} from "./lib/chain.mjs";
import { fetchPrices } from "./lib/prices.mjs";

loadEnvFile();

const fmt = (w) => ethers.formatUnits(w, 18);

async function main() {
  const key = requireKey("DEPLOYER_PRIVATE_KEY");

  const record = JSON.parse(await fs.promises.readFile(DEPLOYED_TESTNET_PATH, "utf8"));
  const { oracleEth, oracleCbbtc } = record;
  if (!oracleEth || !oracleCbbtc) throw new Error("deployment-testnet.json has no mock oracle addresses — run deploy.mjs first.");

  const provider = testnetProvider();
  await requireChain(provider);

  // Addresses from a JSON file are not proof of a contract. Check before sending owner calls.
  for (const [label, addr] of [["ETH oracle", oracleEth], ["cbBTC oracle", oracleCbbtc]]) {
    const code = await withRetry(`${label} code`, () => provider.getCode(addr));
    if (code === "0x") throw new Error(`${label} ${addr} has no code on chain ${await provider.getNetwork().then((n) => n.chainId)}.`);
  }

  console.log("Fetching real feed prices...");
  const prices = await fetchPrices();

  const deployer = new ethers.NonceManager(new ethers.Wallet(key, provider));
  await deployer.getNonce();
  const { abi } = artifact("MockPriceOracle");
  const readAbi = [...abi, "function price() view returns (uint256)", "function cashPrice() view returns (uint256)"];

  const confirmedPrices = {};
  for (const [label, address, wad, recordKey] of [
    ["ETH", oracleEth, prices.ethUsd, "ethUsd"],
    ["cbBTC", oracleCbbtc, prices.cbbtcUsd, "cbbtcUsd"],
  ]) {
    const c = new ethers.Contract(address, abi, deployer);
    const view = new ethers.Contract(address, readAbi, provider);
    const before = await view.price();
    const cashBefore = await view.cashPrice();

    await sendTx(`${label} setBothPrices`, () => c.setBothPrices(wad, prices.usdgUsd));

    // Read back rather than assume: the published record reports what the chain actually holds.
    const after = await view.price();
    const cashAfter = await view.cashPrice();
    if (after !== wad || cashAfter !== prices.usdgUsd) {
      throw new Error(`${label}: on-chain values (${after}/${cashAfter}) do not match what was sent.`);
    }
    confirmedPrices[recordKey] = fmt(after);
    confirmedPrices.usdgUsd = fmt(cashAfter);
    console.log(`${label} oracle: price ${fmt(before)} -> ${fmt(after)} | cash ${fmt(cashBefore)} -> ${fmt(cashAfter)}`);
  }

  // Keep the published record honest about what the chain is now marked at -- confirmed values,
  // not the values this script merely intended to send.
  record.seededPrices = confirmedPrices;
  record.seededSources = prices.sources;
  record.seededAt = new Date().toISOString();
  record.updatedAt = Date.now();
  await fs.promises.writeFile(DEPLOYED_TESTNET_PATH, JSON.stringify(record, null, 2));
  console.log(`\nUpdated ${DEPLOYED_TESTNET_PATH} (values verified on-chain).`);
}

main().catch((e) => {
  console.error(`Refresh failed: ${e?.shortMessage ?? e?.message ?? e}`);
  process.exit(1);
});
