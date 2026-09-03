/// Wallet + Anvil sends that hang (Nitro `metadata is not found`, MetaMask waiting on
/// estimateGas) used to leave the UI on "Creating coin..." forever. Race the action
/// against a timer so the page unlocks.
export const TX_TIMEOUT_MS = 90_000;
export const TX_TIMEOUT_LONG_MS = 120_000;

export async function withTimeout<T>(
  p: Promise<T>,
  ms: number = TX_TIMEOUT_MS,
  label = "Transaction",
): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.round(ms / 1000)}s. Check MetaMask, then try again — this page is no longer waiting.`,
        ),
      );
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}
