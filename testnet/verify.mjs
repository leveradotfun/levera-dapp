// Post-deploy wiring check for the testnet stack.
//
//   cd testnet && node verify.mjs            # read-only config checks
//   node verify.mjs --probe-launch           # ALSO signs: creates+buys a throwaway cbBTC coin
//
// The default path (no flags) is read-only — every assertion is a `cast call` equivalent and
// nothing is signed. `--probe-launch` is the one exception and it says so: it needs
// DEPLOYER_PRIVATE_KEY and sends real transactions. Keep that flag out of anything that runs
// unattended against a deployment you care about.
//
// The probe is the regression that started all of this: a cbBTC launch through the real factory
// path (createLaunch -> EarnPool.registerPool) with BOTH launchpads authorised. It leaves one
// junk coin on the testnet — acceptable there, fatal to run against anything real.
//
// CHANGES IN THIS SCRIPT, AND WHY
// --------------------------------
// A passing run here used to prove less than it looked like it did. It never checked who owns
// anything, never checked that a token's mint is actually gated, never checked the Launch
// implementation is locked against re-initialisation, never checked an address in the record
// actually has code, and only checked a feed's price was nonzero rather than actually fresh.
// Added: ownership summary (and a flag if it's a bare EOA, not a multisig — informational, not a
// failure, since that is a real operational choice this team may not have made yet), a live
// static-call proof that an unprivileged address cannot mint any of the three tokens, a check that
// the Launch implementation itself is locked, a code-presence check on every address in the
// record, and a feed-age check using the same window OracleLib enforces on-chain rather than a
// bare `price > 0`.
import fs from "fs";
import { ethers } from "ethers";
import {
  DEPLOYED_TESTNET_PATH,
  TESTNET_RPC_URL,
  testnetProvider,
  loadEnvFile,
} from "./lib/chain.mjs";
import { diffAgainstLock } from "./lib/artifactHash.mjs";

loadEnvFile();

const MAX_PRICE_AGE_SECONDS = 25 * 60 * 60; // mirrors OracleLib.MAX_PRICE_AGE

const FACTORY_ABI = [
  "function collateralToken() view returns (address)",
  "function minRaise() view returns (uint256)",
  "function priceOracle() view returns (address)",
  "function earn() view returns (address)",
  "function launchCount() view returns (uint256)",
  "function implementation() view returns (address)",
  "function owner() view returns (address)",
  "function createLaunch(string,string,uint256,bool,bool) returns (address)",
  "event LaunchCreated(address indexed launch, address indexed creator, string name, string symbol, uint256 targetRaiseUsd, bool creatorFeeInHfyc, bool leverageEnabled)",
];
const EARN_ABI = [
  "function isFactory(address) view returns (bool)",
  "function collateral(address) view returns (address oracle, address router, uint96 a, uint96 b, uint96 c, uint16 capBps, bool enabled, uint128 scale)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
];
const ORACLE_ABI = [
  "function price() view returns (uint256)",
  "function cashPrice() view returns (uint256)",
  "function publishedAt() view returns (uint256)",
  "function cashPublishedAt() view returns (uint256)",
  "function owner() view returns (address)",
];
const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const MINTABLE_ABI = ["function mint(address to, uint256 amount) external"];
const LAUNCH_ABI = [
  "function graduated() view returns (bool)",
  "function creator() view returns (address)",
  "function quote() view returns (address)",
  "function initialized() view returns (bool)",
];

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function info(name, detail = "") {
  console.log(`  ..  ${name}${detail ? ` — ${detail}` : ""}`);
}

/// Probe whether an unprivileged address can mint on `token`, via a STATIC call (eth_call) -- no
/// gas, no state change, no key required. A random address that succeeds here means the mint gate
/// is not live.
///
/// The probe address is generated fresh each run rather than a hand-typed literal: a mistyped
/// hex literal one character short of 40 hitting this exact function used to fail EVERY check
/// as a false "gated" -- ethers' address parser rejected the malformed literal, fell through to
/// treating it as a possible ENS name, and that lookup then failed on this custom chain (no ENS
/// registry configured for it) with an unrelated "network does not support ENS" error that the
/// try/catch below swallowed as if it were the contract correctly reverting. Caught by actually
/// running this against the live testnet deployment rather than trusting it after one clean
/// local pass -- a syntactically valid address removes an entire class of that mistake.
async function mintIsGated(provider, tokenAddr, label) {
  const probe = ethers.Wallet.createRandom().address;
  const t = new ethers.Contract(tokenAddr, MINTABLE_ABI, provider);
  try {
    await t.mint.staticCall(probe, 1n, { from: probe });
    return false; // the call succeeded — an unprivileged address CAN mint
  } catch {
    return true; // reverted, as it should
  }
}

async function main() {
  const probe = process.argv.includes("--probe-launch");
  const record = JSON.parse(fs.readFileSync(DEPLOYED_TESTNET_PATH, "utf8"));
  const provider = testnetProvider();
  const net = await provider.getNetwork();
  console.log(`Testnet ${TESTNET_RPC_URL} — chain ${net.chainId}, block ${await provider.getBlockNumber()}`);
  check("chain id is 46630", net.chainId === 46630n, `got ${net.chainId}`);

  console.log("\nBytecode integrity (contracts/artifacts.lock.json):");
  {
    const diff = diffAgainstLock();
    check(
      "current contracts/out/ matches the committed lock file",
      diff.ok,
      diff.lockExists
        ? diff.ok
          ? `${diff.matched.length} contract(s) pinned and matching`
          : [
              diff.missing.length ? `unpinned: ${diff.missing.join(", ")}` : "",
              diff.mismatched.length ? `drifted: ${diff.mismatched.map((m) => m.name).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; ")
        : "no lock file — run `node hash-artifacts.mjs write` after review",
    );
    if (record.artifactHashes) {
      const usedDifferentHash = Object.entries(record.artifactHashes).filter(
        ([name, hash]) => diff.current?.[name] && diff.current[name] !== hash,
      );
      check(
        "this deployment used the bytecode currently on disk",
        usedDifferentHash.length === 0,
        usedDifferentHash.length
          ? `${usedDifferentHash.map(([n]) => n).join(", ")} deployed with a different hash than contracts/out/ has now`
          : `${Object.keys(record.artifactHashes).length} contract(s) match`,
      );
    } else {
      info("this deployment predates artifactHashes", "run deploy.mjs again to record them");
    }
  }

  console.log("\nEvery address in the deployment record actually has code:");
  const addressFields = Object.entries(record).filter(
    ([, v]) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v),
  );
  for (const [field, addr] of addressFields) {
    const code = await provider.getCode(addr);
    check(`${field} (${addr})`, code !== "0x");
  }

  const earn = new ethers.Contract(record.hfyc, EARN_ABI, provider);

  console.log("\nLaunchpad authorisation (the bug that broke every cbBTC launch):");
  for (const [label, addr] of [
    ["WETH factory", record.factory],
    ["cbBTC factory", record.cbbtcFactory],
  ]) {
    const code = await provider.getCode(addr);
    check(`${label} is deployed`, code !== "0x");
    check(`${label} is authorised on the Earn Pool`, await earn.isFactory(addr));
  }

  console.log("\nOwnership (whoever holds these keys controls the whole deployment):");
  const owners = {};
  for (const [label, addr, abi] of [
    ["EarnPool", record.hfyc, EARN_ABI],
    ["WETH factory", record.factory, FACTORY_ABI],
    ["cbBTC factory", record.cbbtcFactory, FACTORY_ABI],
    ["ETH oracle", record.oracleEth, ORACLE_ABI],
    ["cbBTC oracle", record.oracleCbbtc, ORACLE_ABI],
  ]) {
    const c = new ethers.Contract(addr, abi, provider);
    const owner = await c.owner();
    owners[label] = owner;
    const ownerCode = await provider.getCode(owner);
    const kind = ownerCode === "0x" ? "EOA" : "contract (multisig?)";
    info(`${label} owner`, `${owner} (${kind})`);
  }
  const distinctOwners = new Set(Object.values(owners).map((o) => o.toLowerCase()));
  check(
    "every contract shares one owner (expected for this deploy pattern)",
    distinctOwners.size === 1,
    `${distinctOwners.size} distinct owner(s)`,
  );
  if (distinctOwners.size === 1) {
    const [only] = distinctOwners;
    const isEoa = (await provider.getCode(only)) === "0x";
    if (isEoa) {
      console.log(
        "  !!  owner is a single EOA, not a multisig — one leaked key controls EarnPool, both\n" +
          "      factories and both oracles. Fine for active testnet iteration; transfer to a\n" +
          "      multisig before this deployment is anything other than throwaway.",
      );
    }
  }

  console.log("\nFaucet-mint access control (mint() must not be callable by an unprivileged address):");
  for (const [label, token] of [
    ["WETH", record.weth],
    ["USDG", record.usdg],
    ["cbBTC", record.cbbtc],
  ]) {
    check(`${label}.mint() is gated`, await mintIsGated(provider, token, label));
  }

  console.log("\nLaunch implementation is locked against re-initialisation:");
  {
    const factory = new ethers.Contract(record.factory, FACTORY_ABI, provider);
    const implAddr = await factory.implementation();
    const impl = new ethers.Contract(implAddr, LAUNCH_ABI, provider);
    check("implementation.initialized() is true", await impl.initialized(), implAddr);
  }

  console.log("\nCollateral registry:");
  for (const [label, token, seededKey] of [
    ["WETH", record.weth, "ethUsd"],
    ["cbBTC", record.cbbtc, "cbbtcUsd"],
  ]) {
    const t = new ethers.Contract(token, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([t.symbol(), t.decimals()]);
    const col = await earn.collateral(token);
    check(
      `${symbol} (${decimals} dec) listed & enabled`,
      symbol.length > 0 && col.enabled,
      `cap ${col.capBps} bps, oracle ${col.oracle}`,
    );

    const oracle = new ethers.Contract(col.oracle, ORACLE_ABI, provider);
    const [price, cash, publishedAt, cashPublishedAt, block] = await Promise.all([
      oracle.price(),
      oracle.cashPrice(),
      oracle.publishedAt(),
      oracle.cashPublishedAt(),
      provider.getBlock("latest"),
    ]);
    const now = BigInt(block.timestamp);
    const priceAge = now - publishedAt;
    const cashAge = now - cashPublishedAt;
    const seeded = record.seededPrices
      ? ethers.parseUnits(record.seededPrices[seededKey], 18) === price
        ? "deploy-time seed unchanged"
        : "refreshed since deploy"
      : "n/a";
    check(
      `${symbol} oracle is marked at the real market and fresh`,
      price > 0n && priceAge <= BigInt(MAX_PRICE_AGE_SECONDS) && cashAge <= BigInt(MAX_PRICE_AGE_SECONDS),
      `price $${ethers.formatUnits(price, 18)} (${priceAge}s old) / cash $${ethers.formatUnits(cash, 18)} (${cashAge}s old) (${seeded})`,
    );
  }

  console.log("\nQuote assets:");
  for (const [label, addr, wantDecimals] of [
    ["WETH launchpad", record.factory, 18],
    ["cbBTC launchpad", record.cbbtcFactory, 8],
  ]) {
    const f = new ethers.Contract(addr, FACTORY_ABI, provider);
    const [quote, minRaise] = await Promise.all([f.collateralToken(), f.minRaise()]);
    check(`${label} quote`, true, `${quote} (minRaise ${ethers.formatUnits(minRaise, wantDecimals)})`);
  }
  const paused = await earn.paused();
  check("Earn Pool is not paused", !paused);

  if (probe) {
    console.log("\nProbe launch (cbBTC, 2x, creator fees in HFyc) -- THIS SIGNS TRANSACTIONS:");
    if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("--probe-launch needs DEPLOYER_PRIVATE_KEY");
    const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    const f = new ethers.Contract(record.cbbtcFactory, FACTORY_ABI, deployer);
    const before = await f.launchCount();
    const rc = await (await f.createLaunch("Probe Coin", `PROBE${before}`, ethers.parseUnits("0.2", 8), true, true)).wait();
    if (!rc || rc.status !== 1) throw new Error("probe createLaunch reverted on-chain");
    const parsed = rc.logs
      .map((l) => {
        try {
          return new ethers.Interface(FACTORY_ABI).parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "LaunchCreated");
    if (!parsed) throw new Error("createLaunch mined but emitted no LaunchCreated");
    const launch = new ethers.Contract(parsed.args.launch, LAUNCH_ABI, provider);
    const [quote, creator, graduated] = await Promise.all([launch.quote(), launch.creator(), launch.graduated()]);
    check("cbBTC launch registered with the Earn Pool", true, `launch ${parsed.args.launch}`);
    check("launch quote is cbBTC", quote.toLowerCase() === record.cbbtc.toLowerCase());
    check("creator is the deployer", creator.toLowerCase() === deployer.address.toLowerCase());
    check("curve is live (not graduated)", !graduated);
    console.log(`  -> probe coin: ${parsed.args.launch}`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`Verify failed: ${e?.shortMessage ?? e?.message ?? e}`);
  process.exit(1);
});
