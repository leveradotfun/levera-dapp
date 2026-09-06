import type { ReactNode } from "react";
// A minimal, dependency-free toast store. Plain functions (not a React context) so code outside
// components can push a toast straight from a catch block without threading a hook through every
// call site.

export type ToastKind = "success" | "error" | "info";
/// `message` is the title line ("Swap confirmed", "Minted LYC"); `detail` is an optional second
/// line with the specifics ("0.5 ETH → 128,400 RHDOGE") -- a one-line "Minted LYC" on its own
/// tells you nothing you didn't already know you were about to do.
export type ToastItem = { id: number; kind: ToastKind; message: string; detail?: ReactNode; timestamp: number };

let idCounter = 0;
let toasts: ToastItem[] = [];
const listeners = new Set<(items: ToastItem[]) => void>();

function emit() {
  for (const l of listeners) l(toasts);
}

export function pushToast(kind: ToastKind, message: string, detail?: ReactNode, durationMs = 6000): number {
  const item: ToastItem = { id: ++idCounter, kind, message, detail, timestamp: Date.now() };
  toasts = [...toasts, item];
  emit();
  if (durationMs > 0) setTimeout(() => dismissToast(item.id), durationMs);
  return item.id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(listener: (items: ToastItem[]) => void) {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

// ---- humanized errors -------------------------------------------------------------------------
// Maps the revert strings this app actually produces to plain English. Without this a failed trade
// shows the raw ethers dump -- `execution reverted: "slippage" (action="estimateGas", data="0x08c3
// 79a000000000...` -- which is both unreadable and, rendered inline, tall enough to stretch the
// trade card it appears in.

const KNOWN_REASONS: [RegExp, string][] = [
  [/already graduated/i, "This coin has already graduated — trade it on the live market instead."],
  [/curveclosed/i, "This coin graduated to the live market just as your trade landed — retry and it'll fill there instead."],
  [/not graduated/i, "This coin hasn't graduated yet — trade it on the bonding curve instead."],
  [/sold out, call graduate/i, "The curve is sold out — waiting on graduation before more buys."],
  [/slippage/i, "Price moved more than your slippage tolerance allowed — try again or raise the tolerance."],
  [/zero in/i, "Enter an amount greater than zero."],
  [/invalid amount/i, "That amount isn't valid — check your balance."],
  [/no backing/i, "This market has no backing left to price against — trading is paused."],
  [/no pool tokens/i, "The market has no tokens left to sell you."],
  [/stale price|conf too wide/i, "The price feed is stale or too uncertain right now — try again shortly."],
  [/insufficient funds for intrinsic transaction cost|insufficient funds for gas/i, "This wallet has no ETH left for gas."],
  [/erc20insufficientbalance|insufficient balance/i, "Not enough balance for this trade."],
  [/erc20insufficientallowance|insufficient allowance/i, "Approval didn't go through — try again."],
  [/replacement fee too low|REPLACEMENT_UNDERPRICED/i, "A previous transaction is still pending. Wait for it in MetaMask, or clear activity (Settings → Advanced → Clear activity tab data), then retry."],
  [/already being created/i, "A coin is already being created. Finish or reject that MetaMask prompt first."],
  [/previous transaction from this wallet is still pending/i, "A previous transaction from this wallet is still pending. Wait for it in MetaMask, or clear activity (Settings → Advanced → Clear activity tab data), then retry."],
  [/nonce/i, "Network hiccup (nonce out of sync) — try again in a moment."],
  [/action_rejected|user denied|user rejected/i, "Transaction cancelled."],
  [/network|timeout|fetch failed|could not detect network/i, "Network hiccup — check Anvil is running and try again."],
  [/metadata is not found/i, "Anvil's fork is stuck talking to Robinhood RPC. Restart ./contracts/anvil-fork.sh, then wipe & deploy."],
  [/missing revert data/i, "The fork rejected this tx (often a new wallet or createLaunch). Restart ./contracts/anvil-fork.sh if it keeps happening."],
  [/not enough idle cash/i, "LYC cash is still in paired ETH. Run Protect on a stretched coin to free USDG, then redeem."],
  [/peel quietest first/i, "LYC exits peel the quietest 2x coins first."],
  [/not enough liquidity/i, "Not enough LYC liquidity in idle cash or quiet 2x pools to cover this exit."],
  [/not pairable/i, "This coin is not ready to pair — it must be graduated and still unlevered."],
  [/leverage in band/i, "Leverage is inside 1.5–2.5x, so protect() will not sell ETH yet."],
  [/leverage off/i, "This coin was launched without 2x and cannot pair against LYC."],
  [/not more active/i, "LYC senior only moves from quieter coins toward louder ones."],
  [/already at 2x/i, "This coin is already at its 2x target."],
  [/3ee5aeb5|reentrancyguardreentrantcall/i, "Redeem hit a reentrancy lock while peeling a 2x pool. Redeploy the updated LYC, then retry."],
  [/timed out after/i, "That transaction didn't confirm in time. The page is unlocked — check MetaMask and try again."],
];

export function humanizeError(err: unknown, fallback = "Something went wrong."): string {
  const e = err as {
    code?: string;
    shortMessage?: string;
    reason?: string;
    info?: { error?: { message?: string } };
    message?: string;
  };
  const blob = [e?.code, e?.shortMessage, e?.reason, e?.info?.error?.message, e?.message, String(err)]
    .filter(Boolean)
    .join("\n");

  for (const [pattern, friendly] of KNOWN_REASONS) {
    if (pattern.test(blob)) return friendly;
  }
  // Fall back to a short single-line excerpt rather than the full multi-line ethers dump.
  const raw = e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(err);
  return raw.split("\n")[0].trim().slice(0, 140) || fallback;
}

export function toastError(err: unknown, fallback = "Something went wrong.") {
  console.error(err);
  pushToast("error", "Transaction failed", humanizeError(err, fallback));
  import("./sessionLog")
    .then((m) => m.logError(fallback.replace(/\.$/, ""), err))
    .catch(() => {});
}

export function toastSuccess(message: string, detail?: ReactNode) {
  pushToast("success", message, detail);
}

export function toastInfo(message: string, detail?: ReactNode) {
  pushToast("info", message, detail);
}
