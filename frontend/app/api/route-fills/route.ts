import { insertRouteFills, routeFillSummary } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Route fills: the pool's de-risk/re-lev mechanism settling against its posted offers
// (SellRouteFilled / BuyRouteFilled). Written by whichever browser scans the chain (deduped by
// tx+log index), read back for the per-coin profit/subsidy split.
//
// Why profit and subsidy are stored separately: `_routePnlUsd` is one signed number, so net-zero
// is ambiguous between "no fills" and "profits offset by a stretched book paying heavily to
// de-risk" -- the second is the risk signal, and only the split tells them apart.

const LAUNCH_RE = /^0x[0-9a-f]{40}$/;

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
    if (body.fills.length > 500) return json({ error: "too many fills" }, 413);

    const rows = [];
    for (const raw of body.fills) {
      const f = raw as Record<string, unknown>;
      const side = f.side === "sell" || f.side === "buy" ? f.side : null;
      if (!side) return json({ error: "side must be sell|buy" }, 400);
      if (typeof f.txHash !== "string" || f.txHash.length !== 66) return json({ error: "bad tx" }, 400);
      const asBig = (v: unknown): string => {
        try { return BigInt(String(v ?? "0")).toString(); } catch { return "0"; }
      };
      rows.push({
        launch,
        collateral: typeof f.collateral === "string" ? f.collateral.slice(0, 42) : "",
        side,
        filler: typeof f.filler === "string" ? f.filler.toLowerCase().slice(0, 42) : "",
        usdIn: asBig(f.usdIn),
        ethOut: asBig(f.ethOut),
        priceWad: asBig(f.priceWad),
        pnlUsd: asBig(f.pnlUsd),
        txHash: f.txHash,
        logIndex: Number(f.logIndex ?? 0) | 0,
        t: Number(f.t ?? Date.now()),
      });
    }

    const written = await insertRouteFills(rows as Parameters<typeof insertRouteFills>[0]);
    return json({ ok: true, written });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
