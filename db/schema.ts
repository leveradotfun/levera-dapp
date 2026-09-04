/// The schema, as a JS string constant rather than a file `migrate.ts` reads at runtime.
///
/// WHY THIS EXISTS, NOT A PLAIN readFile("schema.sql")
/// -----------------------------------------------------
/// db/ is reached from frontend/ (and ui/) through a symlink to this sibling directory, which
/// means Next's own output-file-tracing root has to be set to the monorepo root, not frontend/
/// itself, for the rest of db/ to be traced into the deployed bundle at all. Vercel's own builder
/// assumes the Next app root IS the repo root and re-roots the trace output to /vercel/path0
/// accordingly -- a documented conflict in monorepo setups (vercel/next.js#46697, #47293) that
/// silently drops `outputFileTracingIncludes` entries like a plain schema.sql file. The build
/// succeeds, the deploy succeeds, and only a later runtime read discovers the file never made it:
/// `ENOENT: no such file or directory, open '/vercel/path0/frontend/db/schema.sql'`.
///
/// A real `import` has none of this ambiguity -- webpack/Next's tracer follows the module graph
/// unconditionally, which is exactly what already makes db/pool.ts and every other db/*.ts module
/// reach the deployed bundle correctly. Keep schema.sql alongside this file for humans (`psql -f
/// db/schema.sql`, reading the shape of the store at a glance) -- but this is what the app itself
/// reads, and the two must be kept in sync by hand when the schema changes.
export const SCHEMA_SQL = `
-- HoodFrenzy durable store. Replaces browser localStorage for protocol/research data.
-- UI chrome (grid/table, filters, sidebar) stays in the browser.
--
-- Applied automatically by \`db/migrate.ts:ensureSchema()\` before the first query, so a fresh clone
-- or a dropped database is a non-event rather than an opaque 500 mid-session. Every statement is
-- idempotent; keep it that way.

CREATE TABLE IF NOT EXISTS hfyc_nav (
  factory   text NOT NULL,
  t         bigint NOT NULL,
  nav       double precision NOT NULL,
  occ       double precision NOT NULL,
  cash      double precision NOT NULL,
  liab      double precision NOT NULL,
  util      double precision NOT NULL,
  pending   double precision NOT NULL,
  PRIMARY KEY (factory, t)
);

CREATE TABLE IF NOT EXISTS price_points (
  launch    text NOT NULL,
  factory   text NOT NULL DEFAULT '',
  t         bigint NOT NULL,
  price     double precision NOT NULL,
  PRIMARY KEY (launch, t)
);

CREATE INDEX IF NOT EXISTS price_points_factory ON price_points (factory);

CREATE TABLE IF NOT EXISTS ledger_totals (
  launch    text NOT NULL,
  trader    text NOT NULL,
  factory   text NOT NULL DEFAULT '',
  spent     text NOT NULL DEFAULT '0',
  received  text NOT NULL DEFAULT '0',
  bought    text NOT NULL DEFAULT '0',
  sold      text NOT NULL DEFAULT '0',
  count     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (launch, trader)
);

CREATE INDEX IF NOT EXISTS ledger_totals_factory ON ledger_totals (factory);

CREATE TABLE IF NOT EXISTS trades (
  id        bigserial PRIMARY KEY,
  factory   text NOT NULL DEFAULT '',
  launch    text NOT NULL,
  trader    text NOT NULL,
  side      text NOT NULL CHECK (side IN ('buy', 'sell')),
  usd_wad   text NOT NULL,
  token_wad text NOT NULL,
  phase     text,
  t         bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS trades_launch_trader ON trades (launch, trader);
CREATE INDEX IF NOT EXISTS trades_factory ON trades (factory);

CREATE TABLE IF NOT EXISTS rebalances (
  id            bigserial PRIMARY KEY,
  factory       text NOT NULL DEFAULT '',
  launch        text NOT NULL,
  timestamp     bigint NOT NULL,
  skim_usd      text NOT NULL,
  new_loop_lev  text NOT NULL,
  tx_hash       text NOT NULL
);

CREATE INDEX IF NOT EXISTS rebalances_launch ON rebalances (launch, timestamp DESC);
CREATE INDEX IF NOT EXISTS rebalances_factory ON rebalances (factory);

CREATE TABLE IF NOT EXISTS x_profiles (
  address           text PRIMARY KEY,
  id                text NOT NULL DEFAULT '',
  name              text NOT NULL DEFAULT '',
  username          text NOT NULL,
  profile_image_url text NOT NULL DEFAULT '',
  connected_at      bigint,
  updated_at        bigint NOT NULL
);

-- Per-collateral state, sampled alongside the book.
--
-- The senior claim is one unit across every asset, but the risk machinery is per asset: each has
-- its own feed, its own collateral ratio, its own cap and its own price for renting senior. A
-- single aggregate row stops meaning anything the moment there are two, so each asset gets its own.
CREATE TABLE IF NOT EXISTS collateral_samples (
  factory        text NOT NULL,
  token          text NOT NULL,
  t              bigint NOT NULL,
  symbol         text NOT NULL DEFAULT '',
  price_usd      double precision,
  oracle_live    boolean NOT NULL DEFAULT true,
  pooled         double precision NOT NULL DEFAULT 0,
  idle           double precision NOT NULL DEFAULT 0,
  senior_usd     double precision NOT NULL DEFAULT 0,
  collateral_cr  double precision,
  headroom_usd   double precision NOT NULL DEFAULT 0,
  cap_bps        integer NOT NULL DEFAULT 0,
  routing_apr    double precision NOT NULL DEFAULT 0,
  funding_apr    double precision NOT NULL DEFAULT 0,
  enabled        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (factory, token, t)
);

CREATE INDEX IF NOT EXISTS collateral_samples_token ON collateral_samples (token, t DESC);

-- Which collateral a launch is levered against. Written once at registration; every per-pool
-- reading is meaningless without it once there is more than one asset.
ALTER TABLE price_points  ADD COLUMN IF NOT EXISTS collateral text NOT NULL DEFAULT '';
ALTER TABLE trades        ADD COLUMN IF NOT EXISTS collateral text NOT NULL DEFAULT '';
ALTER TABLE ledger_totals ADD COLUMN IF NOT EXISTS collateral text NOT NULL DEFAULT '';
ALTER TABLE rebalances    ADD COLUMN IF NOT EXISTS collateral text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS faucet_claims (
  address    text NOT NULL,
  asset      text NOT NULL,
  day        date NOT NULL,
  amount     text NOT NULL,
  tx         text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  PRIMARY KEY (address, asset, day)
);

CREATE TABLE IF NOT EXISTS arweave_blobs (
  id           text PRIMARY KEY,
  data         bytea NOT NULL,
  content_type text NOT NULL,
  created_at   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS token_metadata (
  launch     text PRIMARY KEY,
  image_url  text,
  website    text,
  telegram   text,
  discord    text,
  twitter    text,
  description text,
  created_at bigint NOT NULL
);

-- On-platform social graph: wallet -> wallet follows. Deliberately independent of x_profiles --
-- identity here is the address, not the X account, so a wallet that never connected Twitter can
-- still follow and be followed.
CREATE TABLE IF NOT EXISTS follows (
  follower   text NOT NULL,
  target     text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (follower, target)
);

CREATE INDEX IF NOT EXISTS follows_target   ON follows (target);
CREATE INDEX IF NOT EXISTS follows_follower ON follows (follower);
`;
