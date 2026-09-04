// Shared chain constants and helpers for the testnet deploy tooling. Plain JS — no build step.
//
// CHANGES IN THIS FILE, AND WHY
// ------------------------------
// 1. `sendTx` (new): every state-changing call in this tooling now goes through it. It awaits a
//    RECEIPT and asserts `status === 1`. Previously every write was wrapped in `withRetry(...)`,
//    which only awaits the ContractTransactionResponse -- i.e. broadcast, not inclusion -- so a
//    reverted or dropped `addCollateral` / `setFactory` / `setCashPrice` left the script printing
//    success and publishing a deployment record that disagreed with the chain.
// 2. `withRetry` is now READ-ONLY by contract (docs updated to say so explicitly) and a new
//    `deployOnce` handles contract creation. Retrying a creation under `ethers.NonceManager` is
//    unsafe: `NonceManager.sendTransaction` increments its local nonce counter BEFORE the send
//    resolves (see ethers 6's own `signer-noncemanager.js`, which flags this with its own
//    "@TODO: ... don't increment if the tx was certainly not sent"). A retry after a timeout can
//    therefore reuse the wrong nonce while the original transaction is still in flight -- either
//    a duplicate contract or a permanent nonce gap that strands the rest of the deploy.
// 3. `requireChain` (new): asserts the connected chain id before any script signs a transaction.
//    `deploy.mjs` already checked this; `refresh-prices.mjs` did not, and sends owner-only
//    transactions.
// 4. `loadEnvFile` now handles CRLF line endings, an optional `export ` prefix, and values
//    containing `=`; it splits on the FIRST `=` and trims trailing whitespace before parsing,
//    instead of a greedy `(.*)\s*$` that silently captured trailing spaces or `\r` into the
//    value -- which turns a private key into something `ethers.Wallet` rejects with an opaque
//    "invalid BytesLike value". It also warns if the file is group/world readable.
// 5. `requireKey` (new): validates a private key's shape without ever logging it, so a malformed
//    key fails with a clear message instead of a confusing signature error three calls later.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(here, "..", "..");
export const testnetRoot = path.join(here, "..");

export const TESTNET_CHAIN_ID = 46630n;

// Loaded here, before TESTNET_RPC_URL/MAINNET_RPC_URL read process.env below -- every script that
// imports this module also calls loadEnvFile() itself, but ESM evaluates a module's imports (this
// file's whole top level, including those two consts) before the importing script's own top-level
// code runs. Calling it a second time downstream is harmless (loadEnvFile only fills keys that
// aren't already set), but without this call here, TESTNET_RPC_URL/MAINNET_RPC_URL always saw an
// empty process.env and silently fell back to the public RPC no matter what testnet/.env said.
loadEnvFile();

export const TESTNET_RPC_URL = process.env.TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
export const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

/// Robinhood MAINNET Chainlink aggregators. These are the real feeds the fork reads; testnet has
/// none of its own (probed: every mainnet address is empty code on 46630), so the mock oracles
/// are seeded from here instead — see lib/prices.mjs.
export const MAINNET_FEEDS = {
  ethUsd: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  usdgUsd: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
  cbbtcUsd: "0x0009cD492adf8167f9eEBf1293556A673530a21a",
};

export const DEPLOYED_TESTNET_PATH = path.join(repoRoot, "data", "deployment-testnet.json");

export function testnetProvider() {
  return new ethers.JsonRpcProvider(TESTNET_RPC_URL, undefined, { staticNetwork: true });
}

export function mainnetProvider() {
  return new ethers.JsonRpcProvider(MAINNET_RPC_URL, undefined, { staticNetwork: true });
}

/// Assert the provider is actually serving the expected chain BEFORE signing anything against it.
/// `deploy.mjs` already did this inline; every script that signs should, so it is centralised here.
export async function requireChain(provider, expected = TESTNET_CHAIN_ID) {
  const net = await provider.getNetwork();
  if (net.chainId !== expected) {
    throw new Error(
      `Refusing to sign: connected to chain ${net.chainId}, expected ${expected}. ` +
        "Check TESTNET_RPC_URL in testnet/.env.",
    );
  }
  return net;
}

/// Loads a foundry artifact compiled from contracts/src. Run `forge build` in contracts/ first.
export function artifact(name) {
  const p = path.join(repoRoot, "contracts", "out", `${name}.sol`, `${name}.json`);
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!a.bytecode || a.bytecode === "0x") throw new Error(`${name} has no bytecode — run \`forge build\` in contracts/`);
  return { abi: a.abi, bytecode: a.bytecode };
}

/// Fills Foundry's `__$<hash>$__` library link placeholders with deployed library addresses.
///
/// A public library function (`OracleLib.read(...)`) compiles into a DELEGATECALL whose target
/// address is only known at deploy time, so the creation bytecode ships with placeholder
/// characters that are NOT hex — ethers rejects the whole blob with "invalid BytesLike value"
/// before anything reaches the chain. `bytecode.linkReferences` records the exact byte offset of
/// every 20-byte slot, keyed by source file and library name; `addresses` maps library name to
/// deployed address. Hash the UNLINKED bytecode (what the lock file pins) before calling this.
export function linkLibraries(bytecode, addresses) {
  const refs = bytecode?.linkReferences ?? {};
  const raw = bytecode?.object ?? bytecode;
  if (!Object.keys(refs).length) return raw;
  // Splice the hex STRING, not a Buffer: Buffer.from(hex) silently stops decoding at the first
  // non-hex placeholder character, truncating the blob mid-placeholder (observed: a 4,874-byte
  // contract decoded as 1,565 bytes) and every later write lands on a corrupted buffer.
  let hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  for (const libs of Object.values(refs)) {
    for (const [name, slots] of Object.entries(libs)) {
      const address = addresses[name];
      if (!address) throw new Error(`${name} is linked into this contract but no deployed address was supplied`);
      const clean = address.toLowerCase().replace(/^0x/, "");
      // Every slot, never just the first: a contract calls the library from many sites, and one
      // left-over placeholder is a DELEGATECALL to a junk address that reverts deep inside the
      // call (observed as "Panic due to OUT_OF_MEMORY" on the creation transaction itself).
      for (const slot of slots) {
        const at = slot.start * 2;
        const placeholder = hex.slice(at, at + 40);
        if (!/^__\$[0-9a-fA-F]+\$__$/.test(placeholder)) {
          throw new Error(`${name} link slot at byte ${slot.start} does not hold a Foundry placeholder`);
        }
        hex = hex.slice(0, at) + clean + hex.slice(at + 40);
      }
    }
  }
  return "0x" + hex;
}

const TRANSIENT = /429|rate limit|metadata is not found|missing revert data|timeout|socket hang up|ETIMEDOUT|ECONNRESET/i;

/// Retries a READ-ONLY thunk across the public RPC's rate-limit windows. The Robinhood endpoints
/// 429 in bursts; a deploy that dies halfway at contract 3 of 15 is worse than a slow one.
///
/// Do NOT pass a state-changing call here — a transaction send is not safe to retry blindly (see
/// the file header). Use `sendTx` for a single transaction or `deployOnce` for a contract creation.
export async function withRetry(label, fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.shortMessage ?? e?.message ?? e);
      if (i >= attempts || !TRANSIENT.test(msg)) throw e;
      const wait = 15_000 * i;
      console.log(`  .. ${label} hit upstream trouble (${msg.slice(0, 70)}) — retry ${i}/${attempts - 1} in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/// Send ONE state-changing transaction and wait for a successful receipt.
///
/// `fn` must return a ContractTransactionResponse (or TransactionResponse) from a single send —
/// not a retried one. This is the only sanctioned way for these scripts to write on-chain: it
/// proves inclusion AND success, which the previous `withRetry`-around-a-write pattern never did
/// for `setCashPrice`, `addCollateral`, `setFactory`, `setProtocolLockupDays`,
/// `setCreatorLockupDays`, the faucet mints, or the oracle refresh writes.
export async function sendTx(label, fn, { confirmations = 1 } = {}) {
  let tx;
  try {
    tx = await fn();
  } catch (e) {
    throw new Error(`${label}: send failed — ${e?.shortMessage ?? e?.message ?? e}`);
  }
  // Waiting for the receipt is retried (it is read-only polling); the send itself is not.
  const receipt = await withRetry(`${label} receipt`, () => tx.wait(confirmations));
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label}: transaction ${tx.hash} REVERTED on-chain (status ${receipt?.status})`);
  }
  console.log(`  ${label} ok  (${receipt.hash}, gas ${receipt.gasUsed})`);
  return receipt;
}

/// Deploy one contract and confirm it landed. Deliberately NOT retried at this layer: a contract
/// creation is not idempotent under `NonceManager` (see file header). On a transient failure the
/// caller should surface it and stop, rather than risk a duplicated or nonce-gapped deployment.
export async function deployOnce(label, factory, args) {
  const c = await factory.deploy(...args);
  const tx = c.deploymentTransaction();
  const receipt = await withRetry(`${label} receipt`, () => tx.wait(1));
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label}: creation reverted (tx ${tx.hash})`);
  }
  const address = await c.getAddress();
  // The receipt is proof the creation landed, but the edge endpoint load-balances replicas: the
  // node that served the receipt and the node the next read lands on can disagree for a few
  // seconds, and getCode answers successfully with "0x" on the lagging one. withRetry cannot see
  // that (nothing threw), so poll for the code to appear before declaring the deploy dead.
  const provider = factory.runner.provider;
  let code = "0x";
  for (let attempt = 0; ; attempt++) {
    code = await withRetry(`${label} code`, () => provider.getCode(address));
    if (code !== "0x" || attempt >= 5) break;
    const wait = 3_000 * (attempt + 1);
    console.log(`  .. ${label} receipt mined but code not visible yet — re-checking in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  if (code === "0x") throw new Error(`${label}: no code at ${address} after deployment`);
  console.log(`  -> ${address}  (${receipt.hash})`);
  return c;
}

/// Loads testnet/.env into process.env without overriding what the shell already set.
export function loadEnvFile() {
  const p = path.join(testnetRoot, ".env");
  if (!fs.existsSync(p)) return;

  try {
    const mode = fs.statSync(p).mode & 0o777;
    if (mode & 0o077) {
      console.warn(`WARNING: ${p} is group/world readable (mode ${mode.toString(8)}). Run: chmod 600 testnet/.env`);
    }
  } catch {
    /* stat failure is not fatal */
  }

  const raw = fs.readFileSync(p, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Allow an optional `export ` prefix; split on the FIRST '=' so a value may itself contain it.
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/// Fetch and shape-validate a private key from the environment, without ever logging it.
export function requireKey(name) {
  const key = process.env[name];
  if (!key) throw new Error(`${name} is not set (testnet/.env).`);
  const normalised = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error(`${name} is not a valid 32-byte hex private key (check for stray whitespace or CRLF in .env).`);
  }
  return normalised;
}
