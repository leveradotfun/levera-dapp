import { ethers } from "ethers";
import { ANVIL_RPC_URL } from "./chain";
import { RPC_URL } from "./chains";

// ---- a shock absorber between this app and a rate-limited public RPC ------------------------
//
// The shared testnet endpoint drops connections when a page burst-feeds it ~100 POSTs (one
// explore refresh is that big), and ethers only retries HTTP 429 -- a dropped connection rejects
// straight through to the caller. At best that printed coins that blink out of the explore grid;
// at worst every read on the page failed while the contracts sat there perfectly fine.
//
// The wrapper below gives every ethers HTTP request (1) a small concurrency cap so the app cannot
// stampede the endpoint, and (2) bounded retry with jittered backoff on dropped connections,
// 429s and transient 5xx. Transaction broadcasts are exempt: a broadcast that was actually mined
// must not be re-sent on a dropped response.
//
// The cap was 4, which turned out to be the binding constraint on page load rather than a safety
// margin. One cold explore load is ~330 requests and a steady refresh ~210; at 4 in flight and a
// ~0.4s round trip the pipe delivers ~10/s against ~14/s of demand, so the queue never drained and
// the grid sat on "Loading…" for ~29s. At 12 the same load renders in ~9s.
//
// Measured against the shared testnet RPC before raising it: 1,303 requests over 68s of sustained
// polling at 12 in flight, zero dropped connections, coin count stable. The retry-with-backoff
// below is still the safety net -- if a future endpoint does start dropping bursts, lower this
// first, because it is the knob that trades latency for burst size.
const RPC_MAX_CONCURRENT = 12;
let rpcInFlight = 0;
const rpcQueue: Array<() => void> = [];

async function withRpcSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (rpcInFlight >= RPC_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => rpcQueue.push(resolve));
  }
  rpcInFlight++;
  try {
    return await fn();
  } finally {
    rpcInFlight--;
    rpcQueue.shift()?.();
  }
}

const rpcDefaultGetUrl = ethers.FetchRequest.createGetUrlFunc();
ethers.FetchRequest.registerGetUrl(async (req) => {
  const body: string = typeof req.body === "string" ? req.body : "";
  const isBroadcast = body.includes("eth_sendRawTransaction");
  return withRpcSlot(async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const resp = await rpcDefaultGetUrl(req);
        // OK, redirects and ordinary errors pass through; only worth retrying throttling and
        // transient server failures.
        if (resp.statusCode === 200 || (resp.statusCode >= 300 && resp.statusCode < 500 && resp.statusCode !== 429)) {
          return resp;
        }
        lastError = new Error(`rpc responded ${resp.statusCode}`);
      } catch (e) {
        lastError = e;
      }
      if (isBroadcast) break;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 250));
    }
    throw lastError;
  });
});

// A single shared provider avoids each caller opening its own connection.
let _provider: ethers.JsonRpcProvider | null = null;
export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    // `staticNetwork` stops ethers from latching onto the first chain id it sees and then
    // throwing NETWORK_ERROR ("network changed: 31337 => 4663") on every subsequent call, forever,
    // once the local node is restarted on a different chain -- which is routine here, because the
    // node switches between a plain anvil and a Robinhood mainnet fork. Without it, the only cure
    // is a full page reload, and the page just quietly stops updating until someone does.
    //
    // Skipping the check is safe: the RPC itself is the authority on what chain it is serving, and
    // `resetProvider()` below re-detects whenever the deployment actually changes.
    // batchMaxCount: 1 -- the shared testnet endpoint (Cloudflare in front of a Nitro node)
    // silently DROPS batched JSON-RPC POSTs (ethers bundles up to 100 calls into one request;
    // every batch died as an opaque "Failed to fetch" while the identical single calls
    // succeeded). One call per request, with the concurrency cap and retry above absorbing the
    // difference. On the local fork batching was a micro-optimisation at best.
    _provider = new ethers.JsonRpcProvider(ANVIL_RPC_URL, undefined, { staticNetwork: true, batchMaxCount: 1, batchStallTime: 0 });
    // ethers polls for transaction receipts on a timer, defaulting to 4s. Anvil mines instantly,
    // so that default means every tx.wait() sits idle for up to 4 seconds AFTER its transaction is
    // already mined -- and because sends from the shared deployer key are serialized by
    // withSignerLock, that dead time is additive: funding 100 wallets (three sends each) spent
    // minutes waiting on receipts for blocks that already existed, at roughly one transaction per
    // ten seconds. Polling fast is free against a local node and makes the whole app feel live --
    // but 100ms against the shared testnet RPC is one user hammering a public endpoint, so remote
    // targets keep a polite cadence.
    _provider.pollingInterval = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost") ? 100 : 4000;
  }
  return _provider;
}

/// Drops the cached provider so the next call re-detects the chain. Call this after a redeploy or
/// a node restart -- the managed signers go with it, since each holds a reference to the old one
/// and would otherwise keep talking through it.
export function resetProvider() {
  _provider = null;
  signerCache.clear();
}

// Cache one NonceManager-wrapped signer per private key so nonces are tracked locally and
// incremented after every send, instead of each call creating a fresh ethers.Wallet that
// re-fetches "pending" nonce from the network -- the bug that caused rapid sequential sends
// from the same account (the deployer, reused across the whole deploy sequence and every
// mint/fund call in the simulator) to race and reuse a nonce, producing "nonce too low".
const signerCache = new Map<string, ethers.NonceManager>();

export function getManagedSigner(privateKey: string): ethers.NonceManager {
  const existing = signerCache.get(privateKey);
  if (existing) return existing;
  const wallet = new ethers.Wallet(privateKey, getProvider());
  const managed = new ethers.NonceManager(wallet);
  signerCache.set(privateKey, managed);
  return managed;
}

// Call this after anything that invalidates cached nonces, e.g. the user restarting Anvil
// (which resets the whole chain back to nonce 0 for every account) or a "Redeploy" click.
export function resetAllManagedSigners() {
  for (const signer of signerCache.values()) signer.reset();
}

// Serializes every multi-step send-and-wait operation against a given private key, one at a time.
// NonceManager's own nonce ALLOCATION is race-free (it increments synchronously before the first
// await), but the deployer key here is shared across several independent, concurrently-polling
// callers -- the autopilot's wallet funding loop, the keeper, LYC top-ups -- each of which
// does several sequential sends (approve, then the actual
// call) as one logical unit. Two of those units interleaving on the wire produced a real, confusing
// bug: an ethers CALL_EXCEPTION whose reported transaction (empty calldata, a plain value transfer)
// didn't match the approve() call it was supposedly thrown from at all -- it was actually a
// DIFFERENT concurrent operation's transaction, misattributed by the JS engine's async stack
// unwinding once the promises interleaved. A lock per key makes each such unit atomic relative to
// every other caller of the same key, so this class of misattribution (and the underlying nonce
// contention) can't happen -- not just papering over the symptom with a timeout.
const keyLocks = new Map<string, Promise<unknown>>();

export async function withSignerLock<T>(privateKey: string, fn: () => Promise<T>): Promise<T> {
  const prior = keyLocks.get(privateKey) ?? Promise.resolve();
  const run = prior.then(fn);
  // store a settled-either-way marker so a failed fn() doesn't wedge the queue for later callers
  keyLocks.set(
    privateKey,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}
