-- HoodFrenzy durable store. Replaces browser localStorage for protocol/research data.
-- UI chrome (grid/table, filters, sidebar) stays in the browser.
--
-- Applied automatically by `db/migrate.ts:ensureSchema()` before the first query, so a fresh clone
-- or a dropped database is a non-event rather than an opaque 500 mid-session. Every statement is
-- idempotent; keep it that way.

-- LYC NAV history, keyed by factory so a wipe/redeploy starts a new series. 5-min buckets written
-- by both apps (console bot runs and the public Earn page) and read back for the 24h/7d APY.
-- (Formerly hfyc_nav -- renamed alongside the client, which had been POSTing /api/lyc-nav to a
-- route that never existed, leaving this table empty and the APY chart session-only.)
CREATE TABLE IF NOT EXISTS lyc_nav (
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

-- Content-addressed blob store behind the same-origin /api/ipfs gateway: caches pinned cids and
-- holds uploads when Pinata is unconfigured. Not Arweave -- the old name was aspirational.
CREATE TABLE IF NOT EXISTS content_blobs (
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

-- Last-known analytics payload (the /analytics page's own computed JSON). Written at most once
-- a minute by the page itself, anchor-checked against the chain server-side, so a refresh paints
-- real numbers instantly and live reads replace them seconds later. One row, monotonically newer.
CREATE TABLE IF NOT EXISTS analytics_cache (
  id         text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at bigint NOT NULL
);
