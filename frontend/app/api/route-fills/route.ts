import { ethers } from "ethers";
import { promises as fs } from "fs";
import path from "path";
import { insertRouteFills, routeFillSummary, existingRouteFillKeys } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Route fills: the pool's de-risk/re-lev mechanism settling against its posted offers
// (SellRouteFilled / BuyRouteFilled). Written by whichever browser scans the chain (deduped by
// tx+log index), read back for the per-coin profit/subsidy split.
//
// Why profit and subsidy are stored separately: `_routePnlUsd` is one signed number, so net-zero
// is ambiguous between "no fills" and "profits offset by a stretched book paying heavily to
// de-risk" -- the second is the risk signal, and only the split tells them apart.
//
// The scanning browser is untrusted: this endpoint is reachable by anyone, so it must never
// persist a POSTed number on faith. Every fill is re-derived from the chain itself (see
// `verifyRouteFillLog`) -- the client's `usdIn`/`ethOut`/`priceWad`/`pnlUsd` are only ever a hint
// for which log to look at, never the value that gets written.

const LAUNCH_RE = /^0x[0-9a-f]{40}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

/// Verification talks to the chain DIRECTLY, not through `NEXT_PUBLIC_RPC_URL`.
///
/// That variable points at this app's own `/api/rpc/testnet` proxy in production, so using it
/// here would make one POST fan out into a serverless invocation per fill against our own
/// endpoint before reaching the upstream provider -- paying twice for every check and burning
/// the provider's per-minute allowance on a path anyone can call. `ROUTE_VERIFY_RPC_URL` lets a
/// deployment point verification at the upstream directly; the public endpoint is the fallback.
const RPC_URL =
  process.env.ROUTE_VERIFY_RPC_URL ??
  process.env.TESTNET_RPC_PROXY_URL ??
  "https://rpc.testnet.chain.robinhood.com";

/// A batch is one scanner's newly-seen fills, not a backfill. The old 500 ceiling was sized
/// before each entry cost a receipt fetch; anything near it now is either a replay (already
/// filtered by `existingRouteFillKeys`) or abuse.
const MAX_FILLS_PER_POST = 50;

/// Where the deployment record lives, so `launch` can be checked against the factory that
/// actually created it rather than trusted as any 40-hex string.
const TESTNET_PATH = path.join(process.cwd(), "..", "data", "deployment-testnet.json");
const SHARED_PATH = path.join(process.cwd(), "..", "data", "deployment.json");

/// The EarnPool for this deployment, or null when no record is readable. Cached for the life of
/// the lambda: it only changes on a redeploy, which replaces the lambda anyway.
let earnAddress: string | null | undefined;
async function earnPoolAddress(): Promise<string | null> {
  if (earnAddress !== undefined) return earnAddress;
  for (const p of [TESTNET_PATH, SHARED_PATH]) {
    try {
      const raw = JSON.parse(await fs.readFile(p, "utf8")) as { lyc?: string };
      if (raw?.lyc) return (earnAddress = raw.lyc.toLowerCase());
    } catch {
      // Try the next record.
    }
  }
  return (earnAddress = null);
}

// Minimal, positional decoding -- same event shape the scanner itself reads (see
// `lib/launchStats.ts`'s `routeFills` construction): arg0 filler, arg1/arg2 the two token legs
// (named differently per side but stored under the same `usdIn`/`ethOut` keys either way),
// arg3 priceWad, arg4 the signed pnlUsd.
const ROUTE_FILL_ABI = [
  "event SellRouteFilled(address indexed filler, uint256 usdgIn, uint256 ethOut, uint256 priceWad, int256 pnlUsd)",
  "event BuyRouteFilled(address indexed filler, uint256 ethIn, uint256 usdgOut, uint256 priceWad, int256 pnlUsd)",
];
const ROUTE_FILL_EVENT_NAME: Record<"sell" | "buy", string> = {
  sell: "SellRouteFilled",
  buy: "BuyRouteFilled",
};

type VerifiedFill = {
  filler: string;
  usdIn: string;
  ethOut: string;
  priceWad: string;
  pnlUsd: string;
  /// The BLOCK's timestamp, not the poster's clock. `t` orders the ledger and drives what the
  /// per-coin panel shows, so it has to come from the chain like every other stored value --
  /// otherwise it is the one field a caller can still choose freely.
  t: number;
};

/// Fetches `txHash`'s own receipt, finds the log at `logIndex`, and confirms it is a genuine
/// `SellRouteFilled`/`BuyRouteFilled` emitted BY `launch` -- returning the values decoded straight
/// off it. Returns null on any mismatch (wrong contract, wrong event, log doesn't exist, tx not
/// yet mined) rather than throwing, so a single bad entry in a batch fails closed as "reject",
/// not "500".
async function verifyRouteFillLog(
  provider: ethers.JsonRpcProvider,
  receipts: Map<string, ethers.TransactionReceipt | null>,
  blockTimes: Map<number, number>,
  launch: string,
  side: "sell" | "buy",
  txHash: string,
  logIndex: number,
): Promise<VerifiedFill | null> {
  try {
    // One receipt per TRANSACTION, not per fill. A single tx can carry several route logs (a
    // filler clearing multiple offers), and re-fetching it once per log multiplied the upstream
    // cost of a batch by exactly the thing the batch exists to amortise.
    let receipt = receipts.get(txHash);
    if (receipt === undefined) {
      receipt = await provider.getTransactionReceipt(txHash);
      receipts.set(txHash, receipt);
    }
    if (!receipt || receipt.status !== 1) return null;
    const log = receipt.logs.find((l) => l.index === logIndex);
    if (!log || log.address.toLowerCase() !== launch.toLowerCase()) return null;

    const iface = new ethers.Interface(ROUTE_FILL_ABI);
    const parsed = iface.parseLog(log);
    if (!parsed || parsed.name !== ROUTE_FILL_EVENT_NAME[side]) return null;

    let t = blockTimes.get(receipt.blockNumber);
    if (t === undefined) {
      const block = await provider.getBlock(receipt.blockNumber);
      if (!block) return null;
      t = Number(block.timestamp) * 1000;
      blockTimes.set(receipt.blockNumber, t);
    }

    return {
      filler: (parsed.args[0] as string).toLowerCase(),
      usdIn: (parsed.args[1] as bigint).toString(),
      ethOut: (parsed.args[2] as bigint).toString(),
      priceWad: (parsed.args[3] as bigint).toString(),
      pnlUsd: (parsed.args[4] as bigint).toString(),
      t,
    };
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export async function GET(req: Request) {
  try {
    const launch = (new URL(req.url).searchParams.get("launch") ?? "").toLowerCase();
    if (!LAUNCH_RE.test(launch)) return json({ error: "launch required" }, 400);
    const summary = await routeFillSummary(launch);
    return json({
      profitUsd: summary.profitUsd,
      subsidyUsd: summary.subsidyUsd,
      netUsd: summary.netUsd,
      fills: summary.fills,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { launch?: string; fills?: unknown[] };
    const launch = (body.launch ?? "").toLowerCase();
    if (!LAUNCH_RE.test(launch)) return json({ error: "launch required" }, 400);
    if (!Array.isArray(body.fills)) return json({ error: "fills array required" }, 400);
    if (body.fills.length > MAX_FILLS_PER_POST) return json({ error: "too many fills" }, 413);

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });

    // `launch` has to be a pool this deployment's EarnPool actually registered. Without it, the
    // address is just any 40-hex string: anyone could deploy a contract that emits a
    // `SellRouteFilled` with a fabricated pnl and file rows under it, and every check below would
    // pass because the log genuinely came from the address they named. Real launches were never
    // forgeable this way -- you cannot make a real `Launch` emit a fake event -- so this bounds
    // the table to addresses the protocol vouches for (SECURITY-GUIDELINES.md rule 3: validate
    // membership against a trusted registry, not just the shape of the input).
    // Fail-OPEN when no deployment record is readable (a local checkout without one), rather than
    // refusing every ingest. This guard is defence in depth, not the thing keeping the numbers
    // honest -- `verifyRouteFillLog` already re-derives every stored value from the chain, and a
    // real launch was never forgeable. The record is a build artifact, so an attacker cannot make
    // it unreadable to slip past this.
    const earn = await earnPoolAddress();
    if (earn) {
      const isPool: boolean = await new ethers.Contract(
        earn,
        ["function isPool(address) view returns (bool)"],
        provider,
      ).isPool(launch);
      if (!isPool) return json({ error: "launch is not a registered pool" }, 400);
    }

    // Shape-check the whole batch BEFORE any chain call, so a malformed request costs nothing
    // upstream.
    const parsed: Array<{ side: "sell" | "buy"; txHash: string; logIndex: number; collateral: string }> = [];
    for (const raw of body.fills) {
      const f = raw as Record<string, unknown>;
      const side = f.side === "sell" || f.side === "buy" ? f.side : null;
      if (!side) return json({ error: "side must be sell|buy" }, 400);
      if (typeof f.txHash !== "string" || !TX_HASH_RE.test(f.txHash)) return json({ error: "bad tx" }, 400);
      const logIndex = Number(f.logIndex ?? -1);
      if (!Number.isInteger(logIndex) || logIndex < 0) return json({ error: "bad log index" }, 400);
      parsed.push({
        side,
        txHash: f.txHash.toLowerCase(),
        logIndex,
        collateral: typeof f.collateral === "string" ? f.collateral.slice(0, 42) : "",
      });
    }

    // Skip what we already hold. The insert dedupes on (tx_hash, log_index) regardless, but that
    // fires in Postgres AFTER verification -- so without this, re-POSTing a known batch cost a
    // receipt fetch per fill and wrote nothing. On an endpoint anyone can call, that asymmetry is
    // the whole vulnerability: cheap to send, expensive to serve.
    const known = await existingRouteFillKeys(parsed);
    const fresh = parsed.filter((p) => !known.has(`${p.txHash}:${p.logIndex}`));
    if (fresh.length === 0) return json({ ok: true, written: 0, skipped: parsed.length });

    const receipts = new Map<string, ethers.TransactionReceipt | null>();
    const blockTimes = new Map<number, number>();
    const rows = [];
    for (const p of fresh) {
      // The only values ever written are what `verifyRouteFillLog` decodes straight off the
      // chain -- the body's usdIn/ethOut/priceWad/pnlUsd/filler/t are never read. A poster naming
      // a real tx+log that doesn't match `launch`/`side` is rejected outright.
      const verified = await verifyRouteFillLog(
        provider, receipts, blockTimes, launch, p.side, p.txHash, p.logIndex,
      );
      if (!verified) return json({ error: "fill does not match an on-chain route event" }, 400);

      rows.push({
        launch,
        collateral: p.collateral,
        side: p.side,
        filler: verified.filler,
        usdIn: verified.usdIn,
        ethOut: verified.ethOut,
        priceWad: verified.priceWad,
        pnlUsd: verified.pnlUsd,
        txHash: p.txHash,
        logIndex: p.logIndex,
        t: verified.t,
      });
    }

    const written = await insertRouteFills(rows as Parameters<typeof insertRouteFills>[0]);
    return json({ ok: true, written });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
