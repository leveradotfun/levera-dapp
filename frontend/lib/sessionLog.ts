import { CsvFile } from "./csvSchema";

/// The public app's half of the research log.
///
/// It writes to the same three files as the console, and every row is stamped `writer=frontend`.
/// Three processes append here concurrently -- this app, the console, and the keeper -- so without
/// that stamp and a per-writer sequence their rows interleave into something no analysis can pull
/// apart afterwards, and rows with no attribution at all simply cannot be assigned to a run.
///
/// Snapshots are the console's job. This app records the discrete things a person does: minting,
/// exiting, launching a coin, and anything that failed.
export const WRITER = "frontend";

const SESSION_KEY = "sessionLog:frontendSession";
const SEQ_KEY = "sessionLog:frontendSeq";

function sessionId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `fe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function nextSeq(): number {
  if (typeof window === "undefined") return 0;
  const n = Number(window.localStorage.getItem(SEQ_KEY) || "0") + 1;
  window.localStorage.setItem(SEQ_KEY, String(n));
  return n;
}

function envelope() {
  return {
    timestamp: new Date().toISOString(),
    writer: WRITER,
    seq: nextSeq(),
    session_id: sessionId(),
  };
}

async function post(file: CsvFile, row: Record<string, string | number | null | undefined>) {
  try {
    await fetch("/api/session-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, rows: [row] }),
    });
  } catch (e) {
    console.error("session log write failed", e);
  }
}

export async function logError(action: string, err: unknown, launchAddress?: string) {
  const message = err instanceof Error ? err.message : String(err);
  const e = err as {
    code?: string;
    shortMessage?: string;
    receipt?: { hash?: string };
    transaction?: { hash?: string };
    transactionHash?: string;
    reason?: string;
  };
  const enriched = (e?.shortMessage ? `${e.shortMessage} | ${message}` : message).slice(0, 500);
  await post("events", {
    ...envelope(),
    event_type: "ERROR",
    launch_address: launchAddress ?? "",
    error_action: action,
    error_message: e?.reason && !enriched.includes(e.reason) ? `${enriched} [reason=${e.reason}]` : enriched,
    error_code: e?.code ?? "",
    error_tx_hash: e?.receipt?.hash ?? e?.transaction?.hash ?? e?.transactionHash ?? "",
  });
}

export async function logLaunch(row: {
  launchAddress: string;
  launchSpotEth: string;
  launchSpotEthWei: string;
  listingSpotEth: string;
  listingSpotEthWei: string;
  priceAfterCreatorBuyEth: string;
  priceAfterCreatorBuyEthWei: string;
  creatorBuyEth: string;
  creatorBuyImpactPct: string;
}) {
  await post("events", {
    ...envelope(),
    event_type: "LAUNCH",
    launch_address: row.launchAddress,
    launch_spot_eth: row.launchSpotEth,
    launch_spot_eth_wei: row.launchSpotEthWei,
    listing_spot_eth: row.listingSpotEth,
    listing_spot_eth_wei: row.listingSpotEthWei,
    price_after_creator_buy_eth: row.priceAfterCreatorBuyEth,
    price_after_creator_buy_eth_wei: row.priceAfterCreatorBuyEthWei,
    creator_buy_eth: row.creatorBuyEth,
    creator_buy_impact_pct: row.creatorBuyImpactPct,
  });
}

export async function logLycRedeem(row: {
  kind: "cash" | "in-kind" | "pro-rata";
  shares: string;
  usdOut: string;
  peeled: string[];
}) {
  await post("events", {
    ...envelope(),
    event_type: "REDEEM",
    redeem_kind: row.kind,
    redeem_shares: row.shares,
    redeem_usdg_out: row.usdOut,
    redeem_peeled_pools: row.peeled.join(" "),
  });
}

export async function logLycMint(row: { usdValue: string; shares: string; paidInEth: boolean }) {
  await post("events", {
    ...envelope(),
    event_type: "MINT",
    redeem_shares: row.shares,
    redeem_usdg_out: row.usdValue,
    redeem_kind: row.paidInEth ? "eth" : "cash",
  });
}
