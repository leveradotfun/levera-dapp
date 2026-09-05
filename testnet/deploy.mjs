// Deploy the Levera stack to Robinhood Chain TESTNET (chain 46630).
//
//   cd testnet && cp .env.example .env   # then add DEPLOYER_PRIVATE_KEY
//   npm install
//   node deploy.mjs
//
// This is the documented "mock prototype" path (docs/security/testnet.mdx), kept OUTSIDE
// contracts/ on purpose: nothing here changes protocol source, it only composes the contracts
// that `forge build` already compiled.
//
// What is deployed — the same shape the /ui console deploys on the local fork, so the apps can
// read the output unchanged:
//   MockWETH, MockUSDG (18-dec stand-ins; live USDG is 6-dec — do not copy these to mainnet)
//   MockPriceOracle (ETH)  seeded with the REAL ETH/USD price, cash = REAL USDG/USD
//   MockPriceOracle (cbBTC) seeded with the REAL CBBTC/USD price, cash = REAL USDG/USD
//   OracleSwapRouter x2 (fills from inventory; mints only the shortfall — see below)
//   EarnPool, Launch implementation, MemePairFactory, QuoteZap
//   LaunchpadFactory (WETH-quoted) and LaunchpadFactory (cbBTC-quoted, 8-dec)
//   BOTH launchpads authorised on the Earn Pool, both collaterals listed
//
// The mock oracles are snapshots of the real market at deploy time. Run `node refresh-prices.mjs`
// whenever you want them re-synced to the live feeds.
//
// CHANGES IN THIS SCRIPT, AND WHY
// --------------------------------
// 1. FAUCET-MINT ACCESS CONTROL. MockWETH/MockUSDG/MockERC20 used to expose a permissionless
//    `mint` — anyone could mint themselves unlimited testnet tokens, and for MockWETH specifically
//    that meant minting wrapped ETH with no backing and withdrawing real native ETH other users
//    (and the faucet pot) had deposited. `mint` is now gated by `MINTER_ROLE` (see
//    contracts/src/mocks/FaucetMintable.sol). The deployer holds it automatically from
//    construction; this script additionally grants it to the FAUCET address (if
//    `FAUCET_PRIVATE_KEY` is configured) and to both `OracleSwapRouter` instances, which need it
//    for their own mint-FALLBACK path (see point 2). Nobody else can mint anything.
// 2. Every state-changing call now goes through `sendTx`, which waits for a receipt and asserts
//    success — see lib/chain.mjs for why the previous `withRetry`-wrapped-write pattern could
//    report success on a transaction that reverted or was dropped.
// 3. Both legs of each oracle are now seeded in ONE transaction via `setBothPrices`, so there is
//    no window where the chain holds a fresh collateral mark against a stale cash mark.
// 4. BYTECODE PINNING. Before anything is deployed, every pinned contract's current
//    `contracts/out/` bytecode is checked against the committed `contracts/artifacts.lock.json`
//    (see lib/artifactHash.mjs). A local edit, a bad merge, or a stale/corrupt build that was
//    never reviewed now fails the deploy instead of shipping identically to reviewed source --
//    previously `artifact(name)` read whatever was on disk with no check at all. The hash each
//    contract actually deployed with is also recorded in data/deployment-testnet.json.
import fs from "fs";
import { ethers } from "ethers";
import {
  TESTNET_RPC_URL,
  DEPLOYED_TESTNET_PATH,
  artifact,
  testnetProvider,
  requireChain,
  requireKey,
  withRetry,
  sendTx,
  deployOnce,
  loadEnvFile,
  linkLibraries,
} from "./lib/chain.mjs";
import { fetchPrices } from "./lib/prices.mjs";
import { requireApprovedArtifacts, hashBytecode } from "./lib/artifactHash.mjs";

const WAD = 10n ** 18n;
const CAP_BPS = 5_000; // 50% per collateral — the fork deploy's split, not a protocol constant.

loadEnvFile();

const log = (m) => console.log(m);

/// NonceManager that re-syncs when the edge rejects a nonce. The Goldsky endpoint load-balances
/// replicas whose views of this account's count disagree — the same send sequence that mined two
/// transactions fine has had the third answered "nonce has already been used" for a nonce nothing
/// ever mined. On any nonce-related rejection: drop the cached count, let the next send re-read
/// it fresh, and retry once with the same tx (the manager overwrites tx.nonce itself).
class SelfHealingNonceManager extends ethers.NonceManager {
  async sendTransaction(tx) {
    try {
      return await super.sendTransaction(tx);
    } catch (e) {
      const msg = String(e?.shortMessage ?? e?.message ?? e);
      if (!/nonce/i.test(msg)) throw e;
      console.log(`  .. nonce rejected (${msg.slice(0, 70)}) — re-syncing count and retrying once`);
      this.reset();
      return await super.sendTransaction(tx);
    }
  }
}

async function main() {
  const key = requireKey("DEPLOYER_PRIVATE_KEY");

  const provider = testnetProvider();
  await requireChain(provider);

  // NonceManager: the public RPC lags under rate limiting and twice handed back a nonce that had
  // already been mined ("nonce has already been used" mid-deploy). Tracking the nonce locally and
  // incrementing after every send removes the round trip that keeps going stale.
  const deployer = new SelfHealingNonceManager(new ethers.Wallet(key, provider));
  const deployerAddress = await deployer.getAddress();
  // Prime the manager against a load-balanced edge serving stale counts: getNonce("pending")
  // caches one provider read for the whole run, and if that read comes back BEHIND what is
  // already mined, the first send reuses a spent nonce and the deploy dies at contract #1.
  // Bump the manager's delta so the cached read lands on max(pending, mined) before anything
  // is signed. getNonce("latest") bypasses the cache, so it is always a fresh provider read.
  const primedPending = await deployer.getNonce("pending");
  const minedCount = await deployer.getNonce("latest");
  for (let i = primedPending; i < minedCount; i++) deployer.increment();
  const balance = await withRetry("balanceOf(deployer)", () => provider.getBalance(deployerAddress));
  log(`Testnet ${TESTNET_RPC_URL}`);
  log(`Deployer ${deployerAddress} — ${ethers.formatEther(balance)} ETH native`);
  if (balance < ethers.parseEther("0.002")) {
    throw new Error(
      "Deployer looks unfunded (< 0.002 ETH). The full stack is ~15 deployments but testnet gas is near-free (~0.0003 ETH total); use the faucet: https://faucet.testnet.chain.robinhood.com",
    );
  }

  // The dedicated faucet signer, if configured (frontend/app/api/faucet/route.ts). It is granted
  // MINTER_ROLE below and nothing else -- it never becomes an owner of anything in this stack.
  let faucetAddress = null;
  if (process.env.FAUCET_PRIVATE_KEY) {
    faucetAddress = new ethers.Wallet(requireKey("FAUCET_PRIVATE_KEY")).address;
    log(`Faucet   ${faucetAddress} — will be granted MINTER_ROLE on the token contracts`);
  } else {
    log("No FAUCET_PRIVATE_KEY set -- skipping faucet role grant (only the deployer can mint).");
  }

  log("\nChecking every contract's bytecode against contracts/artifacts.lock.json...");
  requireApprovedArtifacts(); // throws with a clear message if anything is unpinned or drifted
  log("  ok -- every pinned contract matches the committed lock file.");

  log("\nFetching real feed prices to seed the mock oracles...");
  const prices = await fetchPrices({ log });

  const artifactHashes = {};
  // Filled in once OracleLib is deployed (below). OracleLib itself links nothing, so the empty
  // map at its own deploy is correct.
  const libraryAddresses = {};
  const deploy = async (name, args = [], label) => {
    log(`\nDeploying ${label ?? name}...`);
    const { abi, bytecode } = artifact(name);
    artifactHashes[name] = hashBytecode(bytecode);
    const linked = linkLibraries(bytecode, libraryAddresses);
    const f = new ethers.ContractFactory(abi, linked, deployer);
    return deployOnce(label ?? name, f, args);
  };

  // The block the stack starts at. Published with the addresses so the apps can bound every
  // `eth_getLogs` to this deployment's own history: on a chain 111M blocks deep, a scan from
  // genesis is by far the most expensive request the frontend makes, and nothing these contracts
  // emitted can predate the block they were created in. Read BEFORE the first deployment so it is
  // always a lower bound, never a block that already contains launch events.
  const deployBlock = await withRetry("blockNumber(deploy start)", () => provider.getBlockNumber());
  log(`Deploy starts at block ${deployBlock}`);

  // The shared fail-closed oracle reads live in an external library (a size win: Launch sits on
  // the EIP-170 cap, and one shared OracleLib dedupes those bytes out of every consumer). Every
  // public library call compiles to a DELEGATECALL whose target is a link placeholder in the
  // creation bytecode, so the library must be deployed FIRST and its address patched into
  // EarnPool, Launch, LaunchpadFactory and OracleSwapRouter before those can be created at all.
  const oracleLib = await deploy("OracleLib");
  libraryAddresses.OracleLib = await oracleLib.getAddress();

  const weth = await deploy("MockWETH");
  const wethAddress = await weth.getAddress();
  const usdg = await deploy("MockUSDG");
  const usdgAddress = await usdg.getAddress();

  // One oracle per collateral, both seeded with the real market (see lib/prices.mjs). The
  // launchpad snapshots targetRaiseUsd off the WETH one; the Earn Pool reads each collateral's
  // own oracle from its registry, which is what makes an 8-dec cbBTC and an 18-dec WETH
  // co-exist behind one book.
  const ethOracle = await deploy("MockPriceOracle", [prices.ethUsd], "MockPriceOracle (ETH)");
  const ethOracleAddress = await ethOracle.getAddress();
  const btcOracle = await deploy("MockPriceOracle", [prices.cbbtcUsd], "MockPriceOracle (cbBTC)");
  const btcOracleAddress = await btcOracle.getAddress();
  // MockPriceOracle defaults cash to $1.00; wire the real USDG/USD mark into both so a depeg
  // shows up in cover instead of being assumed away, both legs in one transaction each.
  await sendTx("setBothPrices(ETH)", () => ethOracle.setBothPrices(prices.ethUsd, prices.usdgUsd));
  await sendTx("setBothPrices(cbBTC)", () => btcOracle.setBothPrices(prices.cbbtcUsd, prices.usdgUsd));

  const router = await deploy("OracleSwapRouter", [wethAddress, usdgAddress, ethOracleAddress], "OracleSwapRouter (WETH)");
  const routerAddress = await router.getAddress();

  const earn = await deploy("EarnPool", [usdgAddress, ethOracleAddress, wethAddress, routerAddress], "EarnPool (HFyc)");
  const earnAddress = await earn.getAddress();

  const implementation = await deploy("Launch");
  const implementationAddress = await implementation.getAddress();
  const pairFactory = await deploy("MemePairFactory");
  const pairFactoryAddress = await pairFactory.getAddress();

  const factory = await deploy(
    "LaunchpadFactory",
    [implementationAddress, wethAddress, usdgAddress, routerAddress, ethOracleAddress, earnAddress, pairFactoryAddress],
    "LaunchpadFactory (WETH)",
  );
  const factoryAddress = await factory.getAddress();

  log("\nListing WETH as a quote asset...");
  await sendTx("addCollateral(WETH)", () => earn.addCollateral(wethAddress, ethOracleAddress, routerAddress, CAP_BPS));

  // cbBTC: 8 decimals, priced at the real BTC mark. The token is a stand-in (no official cbBTC
  // exists on 46630); the decimals are the part that matters for correctness.
  const cbbtc = await deploy("MockERC20", ["Coinbase Wrapped BTC", "cbBTC", 8], "cbBTC (stand-in)");
  const cbbtcAddress = await cbbtc.getAddress();
  const btcRouter = await deploy("OracleSwapRouter", [cbbtcAddress, usdgAddress, btcOracleAddress], "OracleSwapRouter (cbBTC)");
  const btcRouterAddress = await btcRouter.getAddress();

  log("\nListing cbBTC as a quote asset...");
  await sendTx("addCollateral(cbBTC)", () => earn.addCollateral(cbbtcAddress, btcOracleAddress, btcRouterAddress, CAP_BPS));

  const cbbtcFactory = await deploy(
    "LaunchpadFactory",
    [implementationAddress, cbbtcAddress, usdgAddress, btcRouterAddress, btcOracleAddress, earnAddress, pairFactoryAddress],
    "LaunchpadFactory (cbBTC)",
  );
  const cbbtcFactoryAddress = await cbbtcFactory.getAddress();

  const quoteZap = await deploy("QuoteZap", [wethAddress]);
  const quoteZapAddress = await quoteZap.getAddress();

  // XZap: one-transaction xTOKEN exits into any listed asset (quote, USDG, the other
  // collateral, native ETH). Stateless periphery like QuoteZap -- reads the collateral venues
  // off the Earn Pool registry, holds nothing between calls.
  const xzap = await deploy("XZap", [earnAddress, wethAddress]);
  const xzapAddress = await xzap.getAddress();

  // BOTH launchpads, not one. A launchpad is bound to one quote asset at construction, so two
  // quote assets means two factories — and whichever was left unauthorised reverted `factory
  // only` on every launch it tried to register. That exact bug is why this registry exists.
  log("\nAuthorizing both launchpads with the Earn Pool...");
  await sendTx("setFactory(WETH)", () => earn.setFactory(factoryAddress, true));
  await sendTx("setFactory(cbBTC)", () => earn.setFactory(cbbtcFactoryAddress, true));
  // Authorising a factory is not by itself proof that the implementation address it hands
  // registerPool is genuine -- the pool checks the implementation's own bytecode against this
  // owner-curated set. Forgetting this tx means every createLaunch reverts "untrusted
  // implementation" (caught by verify.mjs --probe-launch on the first deployment that did).
  await sendTx("setTrustedImplementation", () => earn.setTrustedImplementation(implementationAddress, true));

  // Faucet-mint access control. Each token's MINTER_ROLE, granted only to:
  //   - the deployer (automatic, from FaucetMintable's constructor)
  //   - each OracleSwapRouter, which mints only the SHORTFALL when its own inventory runs out
  //     (see OracleSwapRouter._payOut) -- both legs it can be asked to pay, so both routers need
  //     the role on BOTH tokens they trade
  //   - the faucet signer, if configured -- so the public faucet endpoint can mint drips
  // Nobody else can mint anything on this deployment.
  const MINTER_ROLE = await weth.MINTER_ROLE();
  log("\nGranting MINTER_ROLE on the token contracts...");
  await sendTx("weth.grantRole(router)", () => weth.grantRole(MINTER_ROLE, routerAddress));
  await sendTx("usdg.grantRole(router)", () => usdg.grantRole(MINTER_ROLE, routerAddress));
  await sendTx("cbbtc.grantRole(btcRouter)", () => cbbtc.grantRole(MINTER_ROLE, btcRouterAddress));
  await sendTx("usdg.grantRole(btcRouter)", () => usdg.grantRole(MINTER_ROLE, btcRouterAddress));
  if (faucetAddress) {
    await sendTx("weth.grantRole(faucet)", () => weth.grantRole(MINTER_ROLE, faucetAddress));
    await sendTx("usdg.grantRole(faucet)", () => usdg.grantRole(MINTER_ROLE, faucetAddress));
    await sendTx("cbbtc.grantRole(faucet)", () => cbbtc.grantRole(MINTER_ROLE, faucetAddress));
  }

  // A SECOND faucet wallet, if the deployed frontend's own faucet key differs from the one in
  // this .env — which is exactly the production setup: Vercel holds its own FAUCET_PRIVATE_KEY,
  // and its address only gets roles if it is named here. Forgetting this is what broke token
  // claims on app.levera.fun after every redeploy: ETH claims still worked (they are plain
  // transfers), but every token mint reverted for lack of MINTER_ROLE. The address is public —
  // set FAUCET_EXTRA_ADDRESS in testnet/.env to the frontend deployment's faucet wallet.
  const extraFaucet = process.env.FAUCET_EXTRA_ADDRESS;
  if (extraFaucet && /^0x[0-9a-fA-F]{40}$/.test(extraFaucet)) {
    log(`\nGranting MINTER_ROLE to the extra (frontend) faucet ${extraFaucet}...`);
    await sendTx("weth.grantRole(extra faucet)", () => weth.grantRole(MINTER_ROLE, extraFaucet));
    await sendTx("usdg.grantRole(extra faucet)", () => usdg.grantRole(MINTER_ROLE, extraFaucet));
    await sendTx("cbbtc.grantRole(extra faucet)", () => cbbtc.grantRole(MINTER_ROLE, extraFaucet));
  }

  log("\nMinting starter balances to the deployer (mock tokens — this is a prototype)...");
  // 1 BILLION of each, so the deployer can never be stranded: every bot top-up, faucet
  // backstop and seed comes out of this pile, and the mocks are mintable anyway -- these are
  // placeholders with testnet value only.
  await sendTx("mint USDG", () => usdg.mint(deployerAddress, 1_000_000_000n * WAD));
  await sendTx("mint WETH", () => weth.mint(deployerAddress, 1_000_000_000n * WAD));
  await sendTx("mint cbBTC", () => cbbtc.mint(deployerAddress, ethers.parseUnits("1000000000", 8)));

  const addresses = {
    network: "robinhood-testnet",
    chainId: 46630,
    deployBlock,
    rpcUrl: TESTNET_RPC_URL,
    explorer: "https://explorer.testnet.chain.robinhood.com",
    feed: ethOracleAddress, // what the /ui console's oracle panel expects: the price the app reads
    oracleEth: ethOracleAddress,
    oracleCbbtc: btcOracleAddress,
    pairFactory: pairFactoryAddress,
    quoteZap: quoteZapAddress,
    xzap: xzapAddress,
    oracleLib: libraryAddresses.OracleLib,
    cbbtc: cbbtcAddress,
    cbbtcOracle: btcOracleAddress,
    cbbtcRouter: btcRouterAddress,
    cbbtcFactory: cbbtcFactoryAddress,
    weth: wethAddress,
    usdg: usdgAddress,
    oracle: ethOracleAddress,
    router: routerAddress,
    lyc: earnAddress,
    factory: factoryAddress,
    launch: "",
    faucet: faucetAddress,
    // Which reviewed, lock-file-pinned bytecode each contract deployed with -- so "what's live"
    // can be checked against "what was reviewed" at any later point via `node verify.mjs` or
    // `node hash-artifacts.mjs check`, without having to trust that nobody redeployed in between.
    artifactHashes,
    seededPrices: {
      ethUsd: ethers.formatUnits(prices.ethUsd, 18),
      usdgUsd: ethers.formatUnits(prices.usdgUsd, 18),
      cbbtcUsd: ethers.formatUnits(prices.cbbtcUsd, 18),
    },
    seededAt: new Date().toISOString(),
  };

  fs.writeFileSync(DEPLOYED_TESTNET_PATH, JSON.stringify({ ...addresses, updatedAt: Date.now() }, null, 2));
  log(`\nPublished ${DEPLOYED_TESTNET_PATH}`);
  log("\nNext: `node verify.mjs` to check the wiring, then point the frontend at testnet (see README.md).");
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((e) => {
  console.error(`Deploy failed: ${e?.shortMessage ?? e?.message ?? e}`);
  process.exit(1);
});
