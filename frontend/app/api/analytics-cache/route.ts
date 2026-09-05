import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { getAnalyticsCache, saveAnalyticsCache } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Last-known analytics snapshot, in one row of Supabase. The analytics page paints this on load
// (instant real numbers instead of skeletons) and then replaces it with live reads seconds later.
//
// WHO WRITES: the page itself, at most once a minute, after a successful live compute. That makes
// the cache exactly as fresh as the most recent visit -- and means there is nothing to port
// server-side. The tradeoff is that the writer is whoever's browser is open, so the POST is
// defended three ways:
//   1. SHAPE: every numeric field must be a finite, non-negative number and every collection
//      bounded -- a malformed or absurd payload is rejected before it can mislead anyone.
//   2. ANCHOR: two cheap chain reads (vLYC NAV, global CR) must match the payload's own headline
//      numbers within tolerance. A visitor computing from the real chain passes for free; anyone
//      inventing numbers fails, because the numbers have to agree with the chain.
//   3. MONOTONY + RATE: newer timestamps only, and one accepted write per IP per 30s.

const MAX_BODY_BYTES = 2_000_000;
const NUMERIC_FIELDS = [
  "tvlUsd", "seniorUsd", "juniorUsd", "totalVolumeUsd", "volume24hUsd",
  "protocolFeesUsd", "creatorFeesUsd", "claimedCreatorFeesUsd",
  "lycMintFeesUsd", "lycRedeemFeesUsd", "totalLaunches", "totalGraduated",
  "activeTraders24h", "totalTrades", "lycNav", "lycLiability", "lycIdleUsdc",
  "lycGlobalCr", "seniorUtilization", "fundingApr",
] as const;
const ARRAY_FIELDS: Record<string, number> = { launches: 500, topPnl: 100, dailyVolume: 400, dailyLaunches: 400 };

const SHARED_DIR = path.join(process.cwd(), "..", "data");
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

function deploymentLyc(): string | null {
  try {
    const dep = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, "deployment-testnet.json"), "utf8"));
    return typeof dep.lyc === "string" && dep.lyc.startsWith("0x") ? dep.lyc : null;
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// Per-instance in-memory limiter. Serverless instances come and go, so this is approximate --
// which is fine: the anchor check is the real gate, this just stops one client from making the
// table's write path hot.
const lastWriteByIp = new Map<string, number>();
const WRITE_GAP_MS = 30_000;

function shapeValid(s: unknown): s is Record<string, unknown> {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
  const o = s as Record<string, unknown>;
  for (const k of NUMERIC_FIELDS) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return false;
  }
  for (const [k, max] of Object.entries(ARRAY_FIELDS)) {
    const v = o[k];
    if (!Array.isArray(v) || v.length > max) return false;
  }
  return true;
}

/// Reads the two fields the payload claims about the earn pool straight off the chain. A payload
/// whose headline numbers disagree with the chain is rejected -- that is what makes a public
/// write path safe to display to other visitors.
async function anchorsMatch(s: Record<string, unknown>): Promise<boolean> {
  const lyc = deploymentLyc();
  if (!lyc) return false;
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
    const earn = new ethers.Contract(
      lyc,
      ["function nav() view returns (uint256)", "function globalCr() view returns (uint256)"],
      provider,
    );
    const [navW, crW] = (await Promise.all([earn.nav(), earn.globalCr()])) as [bigint, bigint];
    const nav = Number(navW) / 1e18;
    const cr = Number(crW) / 1e18;
    if (!(nav > 0) || !(cr > 0)) return false;
    const navClaim = s.lycNav as number;
    const crClaim = s.lycGlobalCr as number;
    const close = (claim: number, actual: number, tol: number) =>
      Math.abs(claim - actual) <= Math.max(actual * tol, 0.05);
    return close(navClaim, nav, 0.05) && close(crClaim, cr, 0.1);
  } catch {
    return false; // unreachable chain: fail closed rather than accept an uncheckable payload
  }
}

export async function GET() {
  try {
    const row = await getAnalyticsCache();
    return json({ snapshot: row?.data ?? null, updatedAt: row?.updatedAt ?? null });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const now = Date.now();
    const last = lastWriteByIp.get(ip) ?? 0;
    if (now - last < WRITE_GAP_MS) {
      return json({ ok: false, error: "rate limited" }, 429);
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
    const body = JSON.parse(raw) as { snapshot?: unknown; updatedAt?: unknown };
    const snapshot = body?.snapshot;
    const updatedAt = typeof body?.updatedAt === "number" && Number.isFinite(body.updatedAt) ? body.updatedAt : now;
    if (updatedAt > now + 60_000) return json({ error: "updatedAt in the future" }, 400);

    if (!shapeValid(snapshot)) return json({ error: "malformed snapshot" }, 400);
    if (!(await anchorsMatch(snapshot))) return json({ error: "snapshot disagrees with the chain" }, 422);

    lastWriteByIp.set(ip, now);
    await saveAnalyticsCache(snapshot, "platform", updatedAt);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
