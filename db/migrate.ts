import { query } from "./pool";
import { SCHEMA_SQL } from "./schema";

/// Schema management, run automatically rather than by hand.
///
/// The manual `psql -f db/schema.sql` step is a footgun on a research repo: a fresh clone, a
/// dropped database, or a schema change that landed in git but not in the local Postgres all fail
/// the same way -- at the first write, mid-session, as an opaque 500 from an API route. By then
/// whatever the session was measuring is already lost.
///
/// So the apps call `ensureSchema()` before their first query and it becomes a non-event. It is
/// idempotent (`CREATE TABLE IF NOT EXISTS` throughout) and cached per process, so the cost after
/// the first call is a boolean check.
///
/// Reads the schema from schema.ts (a JS string constant), not schema.sql off disk -- see
/// schema.ts's own comment for why a runtime file read doesn't survive a Vercel deploy of this
/// monorepo.

let ready: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      // A transaction-mode pooler (Supabase's Supavisor, PgBouncer) hands out a real backend
      // connection only per-transaction, and does not reliably support the multi-statement DDL
      // block below -- it can hang until Postgres's own statement_timeout kills it, rather than
      // erroring cleanly, which is what made every route calling this (i.e. all of them) appear
      // to hang forever behind a pooled DATABASE_URL. A plain SELECT has none of that risk, so
      // check first and only pay for the DDL block on a genuinely fresh database -- normally
      // never in production, since the schema is expected to already be applied once by hand
      // (Supabase SQL Editor, a direct connection) rather than raced by concurrent cold starts.
      const rows = await query<{ exists: string | null }>(`SELECT to_regclass('public.hfyc_nav') AS exists`);
      if (rows[0]?.exists) return;
      await query(SCHEMA_SQL);
    })().catch((e) => {
      // Do not cache a failure: a database that was not up yet should succeed on the next attempt
      // rather than poisoning the process until it restarts.
      ready = null;
      throw e;
    });
  }
  return ready;
}

/// Every table that holds session data, in an order safe to truncate together.
///
/// `x_profiles` is deliberately absent. It is the one table that is not session state -- it maps a
/// wallet to the X account that claimed it, and wiping it on every redeploy would make people
/// reconnect their identity because somebody restarted a fork.
export const SESSION_TABLES = [
  "hfyc_nav",
  "price_points",
  "ledger_totals",
  "trades",
  "rebalances",
  "collateral_samples",
] as const;

/// Drop every row of session data and reset identity counters.
///
/// This is what a new deployment runs. Wiping only the *previous* factory's rows was not enough:
/// the factory address is read from a local file that the wipe itself deletes, so a wipe after a
/// crash, on a fresh clone, or on the second redeploy in a row would leave earlier sessions' rows
/// behind — and two incompatible books in one series is worse than no series at all.
export async function wipeDatabase(): Promise<void> {
  await ensureSchema();
  await query(`TRUNCATE ${SESSION_TABLES.join(", ")} RESTART IDENTITY`);
}

export async function tableCounts(): Promise<Record<string, number>> {
  await ensureSchema();
  const out: Record<string, number> = {};
  for (const t of SESSION_TABLES) {
    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}
