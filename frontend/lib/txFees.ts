import { getProvider } from "./signers";
import { TARGETING_TESTNET } from "./chains";

const GWEI = 1_000_000_000n;
const PENDING_MSG =
  "A previous transaction from this wallet is still pending. Wait for it in MetaMask, or drop it (MetaMask → Settings → Advanced → Clear activity tab data), then try again.";

export type FeeOverrides = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export function isReplacementFeeError(err: unknown): boolean {
  const e = err as { code?: string; shortMessage?: string; message?: string; info?: { error?: { message?: string } } };
  const raw = `${e?.code ?? ""} ${e?.shortMessage ?? ""} ${e?.info?.error?.message ?? ""} ${e?.message ?? ""} ${String(err)}`;
  return /replacement fee too low|REPLACEMENT_UNDERPRICED/i.test(raw);
}

/// Anvil + MetaMask: a timed-out "Creating coin..." often already submitted a tx. The retry
/// reuses that nonce with the same gas and Anvil answers "replacement fee too low".
///
/// Floor high enough to beat a stuck sibling. Fork ETH is faucet-funded, so the extra gwei is free.
///
/// NONE of that holds on the Robinhood TESTNET: gas is real (if cheap -- ~0.01 gwei measured at
/// the time this was written), ETH is faucet-limited rather than infinite, and a 40-120 gwei
/// floor is 1,000-10,000x the network's actual price. That is exactly what MetaMask's own "High
/// site fee" warning was catching, and every extra click through that warning (or the interstitial
/// "Edit network fee" screen it offers) is friction a user experiences as "the site tried to send
/// this two or three times" even when it is a single transaction. On testnet this uses the
/// provider's own fee suggestion with a modest safety margin instead of a fork-scale floor.
export async function feeOverrides(mult = 3n): Promise<FeeOverrides> {
  const fee = await getProvider().getFeeData();
  if (TARGETING_TESTNET) {
    const tip = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n ? fee.maxPriorityFeePerGas : GWEI / 100n;
    const base = fee.maxFeePerGas && fee.maxFeePerGas > tip ? fee.maxFeePerGas : tip * 2n;
    // +50% over the network's own suggestion is plenty of headroom to land quickly on a chain
    // this cheap, without the multi-thousand-x markup a fork-calibrated floor would apply.
    return {
      maxPriorityFeePerGas: (tip * 3n) / 2n,
      maxFeePerGas: (base * 3n) / 2n,
    };
  }
  const tipFloor = (mult >= 8n ? 50n : 10n) * GWEI;
  const maxFloor = (mult >= 8n ? 120n : 40n) * GWEI;
  const tipRaw = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n ? fee.maxPriorityFeePerGas : 2n * GWEI;
  const maxRaw = fee.maxFeePerGas && fee.maxFeePerGas > tipRaw ? fee.maxFeePerGas : tipRaw * 2n;
  const tip = tipRaw * mult;
  const max = maxRaw * mult + tip;
  return {
    maxPriorityFeePerGas: tip > tipFloor ? tip : tipFloor,
    maxFeePerGas: max > maxFloor ? max : maxFloor,
  };
}

type PoolTx = { hash?: string };

function txsForAddress(
  bucket: Record<string, Record<string, PoolTx>> | undefined,
  address: string,
): PoolTx[] {
  if (!bucket) return [];
  const lower = address.toLowerCase();
  for (const [k, v] of Object.entries(bucket)) {
    if (k.toLowerCase() === lower && v) return Object.values(v);
  }
  return [];
}

export async function dropPendingFromAddress(address: string): Promise<void> {
  const p = getProvider();
  try {
    await p.send("anvil_removePoolTransactions", [address]);
    return;
  } catch {
    // older Anvil
  }
  try {
    const content = (await p.send("txpool_content", [])) as {
      pending?: Record<string, Record<string, PoolTx>>;
      queued?: Record<string, Record<string, PoolTx>>;
    };
    const txs = [...txsForAddress(content?.pending, address), ...txsForAddress(content?.queued, address)];
    for (const tx of txs) {
      if (!tx.hash) continue;
      try {
        await p.send("anvil_dropTransaction", [tx.hash]);
      } catch {
        // already mined or unknown hash
      }
    }
  } catch {
    // not Anvil / no txpool API
  }
}

export async function clearPendingNonce(address: string): Promise<void> {
  // This whole mechanism is Anvil-specific: `evm_mine` and `anvil_dropTransaction` are fork-only
  // RPC methods, and on testnet every call here fails immediately, silently, inside its own
  // try/catch. What is NOT silent is the final check that follows -- it reads whatever `pending`
  // was BEFORE that failed loop, which is stale, and throws "still pending" if a previous
  // transaction from this wallet simply hasn't confirmed yet. On a real chain that is the normal
  // case for two transactions submitted close together (an approve() right before the buy() that
  // needs it, say), not a stuck nonce -- and this used to throw an artificial error for it on
  // essentially every multi-step trade, which is exactly what looked like "the site tried to send
  // this two or three times": the thrown error sent the user back to retry, producing a genuine
  // second wallet prompt for what should have been one normal, if slightly delayed, confirmation.
  if (TARGETING_TESTNET) return;

  const p = getProvider();
  const latest = await p.getTransactionCount(address, "latest");
  let pending = await p.getTransactionCount(address, "pending");
  if (pending <= latest) return;

  for (let i = 0; i < 8; i++) {
    try {
      await p.send("evm_mine", []);
    } catch {
      break;
    }
    pending = await p.getTransactionCount(address, "pending");
    const nowLatest = await p.getTransactionCount(address, "latest");
    if (pending <= nowLatest) return;
    await new Promise((r) => setTimeout(r, 150));
  }

  // Mining didn't consume it (often a Nitro `metadata is not found` hang). Drop so the retry
  // can reuse the nonce instead of bidding against the stuck sibling.
  await dropPendingFromAddress(address);
  try {
    await p.send("evm_mine", []);
  } catch {
    // not Anvil
  }
  pending = await p.getTransactionCount(address, "pending");
  const nowLatest = await p.getTransactionCount(address, "latest");
  if (pending > nowLatest) throw new Error(PENDING_MSG);
}

export async function walletTxOverrides(
  address: string,
  gasLimit: bigint,
  mult = 3n,
): Promise<{ gasLimit: bigint } & FeeOverrides> {
  await clearPendingNonce(address);
  return { gasLimit, ...(await feeOverrides(mult)) };
}

export async function sendReplacing<T>(
  address: string,
  send: (overrides: { gasLimit: bigint } & FeeOverrides) => Promise<T>,
  gasLimit: bigint,
): Promise<T> {
  try {
    return await send(await walletTxOverrides(address, gasLimit, 3n));
  } catch (e) {
    if (!isReplacementFeeError(e)) throw e;
    await dropPendingFromAddress(address);
    return await send(await walletTxOverrides(address, gasLimit, 8n));
  }
}
