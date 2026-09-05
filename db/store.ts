import { query, getPool } from "./pool";
import { ensureSchema, wipeDatabase } from "./migrate";

function norm(addr: string): string {
  return addr.toLowerCase();
}

export type LycNavSample = {
  t: number;
  nav: number;
  occ: number;
  cash: number;
  liab: number;
  util: number;
  pending: number;
};

export type PricePoint = { t: number; price: number };

export type LedgerRow = {
  launch: string;
  trader: string;
  spent: string;
  received: string;
  bought: string;
  sold: string;
  count: number;
};

export type TradeInput = {
  factory: string;
  launch: string;
  trader: string;
  side: "buy" | "sell";
  usdWad: string;
  tokenWad: string;
  phase?: string;
  t: number;
};

export type RebalanceEvent = {
  timestamp: number;
  skimUsd: string;
  newLoopLev: string;
  txHash: string;
};

export type XProfile = {
  id: string;
  name: string;
  username: string;
  profileImageUrl: string;
  connectedAt?: number;
  updatedAt: number;
};

const LYC_NAV_RETAIN_MS = 8 * 24 * 60 * 60 * 1000;
const PRICE_MAX = 4000;
const REBALANCE_MAX = 200;

/// One NAV bucket per factory per 5 minutes; both apps write the same shape. Old buckets fall off
/// behind the write so the 8-day window the APY math assumes is enforced at the store, not left
/// to whichever client happens to be open.
export async function upsertLycNavSample(factory: string, sample: LycNavSample): Promise<void> {
  await ensureSchema();
  const f = norm(factory);
  await query(
    `INSERT INTO lyc_nav (factory, t, nav, occ, cash, liab, util, pending)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (factory, t) DO UPDATE SET
       nav = EXCLUDED.nav, occ = EXCLUDED.occ, cash = EXCLUDED.cash,
       liab = EXCLUDED.liab, util = EXCLUDED.util, pending = EXCLUDED.pending`,
    [f, sample.t, sample.nav, sample.occ, sample.cash, sample.liab, sample.util, sample.pending],
  );
  await query(`DELETE FROM lyc_nav WHERE factory = $1 AND t < $2`, [f, sample.t - LYC_NAV_RETAIN_MS]);
}

export async function listLycNavSamples(factory: string): Promise<LycNavSample[]> {
  await ensureSchema();
  const rows = await query<LycNavSample>(
    `SELECT t, nav, occ, cash, liab, util, pending FROM lyc_nav WHERE factory = $1 ORDER BY t ASC`,
    [norm(factory)],
  );
  return rows.map((r) => ({
    t: Number(r.t),
    nav: Number(r.nav),
    occ: Number(r.occ),
    cash: Number(r.cash),
    liab: Number(r.liab),
    util: Number(r.util),
    pending: Number(r.pending),
  }));
}

export async function insertPricePoints(
  launch: string,
  factory: string,
  points: PricePoint[],
): Promise<void> {
  await ensureSchema();
  if (points.length === 0) return;
  const l = norm(launch);
  const f = norm(factory);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const p of points) {
      await client.query(
        `INSERT INTO price_points (launch, factory, t, price)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (launch, t) DO UPDATE SET price = EXCLUDED.price`,
        [l, f, p.t, p.price],
      );
    }
    await client.query(
      `DELETE FROM price_points WHERE launch = $1 AND t < (
         SELECT t FROM price_points WHERE launch = $1 ORDER BY t DESC OFFSET $2 LIMIT 1
       )`,
      [l, PRICE_MAX - 1],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function listPricePoints(launch: string): Promise<PricePoint[]> {
  await ensureSchema();
  const rows = await query<PricePoint>(
    `SELECT t, price FROM price_points WHERE launch = $1 ORDER BY t ASC LIMIT $2`,
    [norm(launch), PRICE_MAX],
  );
  return rows.map((r) => ({ t: Number(r.t), price: Number(r.price) }));
}

export async function applyTrade(t: TradeInput): Promise<LedgerRow> {
  await ensureSchema();
  const factory = norm(t.factory);
  const launch = norm(t.launch);
  const trader = norm(t.trader);
  const spent = t.side === "buy" ? t.usdWad : "0";
  const received = t.side === "sell" ? t.usdWad : "0";
  const bought = t.side === "buy" ? t.tokenWad : "0";
  const sold = t.side === "sell" ? t.tokenWad : "0";

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO trades (factory, launch, trader, side, usd_wad, token_wad, phase, t)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [factory, launch, trader, t.side, t.usdWad, t.tokenWad, t.phase ?? null, t.t],
    );
    const res = await client.query(
      `INSERT INTO ledger_totals (launch, trader, factory, spent, received, bought, sold, count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1)
       ON CONFLICT (launch, trader) DO UPDATE SET
         spent = trim_scale(ledger_totals.spent::numeric + EXCLUDED.spent::numeric)::text,
         received = trim_scale(ledger_totals.received::numeric + EXCLUDED.received::numeric)::text,
         bought = trim_scale(ledger_totals.bought::numeric + EXCLUDED.bought::numeric)::text,
         sold = trim_scale(ledger_totals.sold::numeric + EXCLUDED.sold::numeric)::text,
         count = ledger_totals.count + 1,
         factory = EXCLUDED.factory
       RETURNING launch, trader, spent, received, bought, sold, count`,
      [launch, trader, factory, spent, received, bought, sold],
    );
    await client.query("COMMIT");
    const row = res.rows[0];
    return {
      launch: row.launch,
      trader: row.trader,
      spent: String(row.spent),
      received: String(row.received),
      bought: String(row.bought),
      sold: String(row.sold),
      count: Number(row.count),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function listLedger(launch: string): Promise<LedgerRow[]> {
  await ensureSchema();
  const rows = await query<LedgerRow>(
    `SELECT launch, trader, spent, received, bought, sold, count
     FROM ledger_totals WHERE launch = $1`,
    [norm(launch)],
  );
  return rows.map((r) => ({
    launch: r.launch,
    trader: r.trader,
    spent: String(r.spent),
    received: String(r.received),
    bought: String(r.bought),
    sold: String(r.sold),
    count: Number(r.count),
  }));
}

export async function listLedgerByFactory(factory: string): Promise<LedgerRow[]> {
  await ensureSchema();
  const rows = await query<LedgerRow>(
    `SELECT launch, trader, spent, received, bought, sold, count
     FROM ledger_totals WHERE factory = $1`,
    [norm(factory)],
  );
  return rows.map((r) => ({
    launch: r.launch,
    trader: r.trader,
    spent: String(r.spent),
    received: String(r.received),
    bought: String(r.bought),
    sold: String(r.sold),
    count: Number(r.count),
  }));
}

export async function insertRebalance(
  factory: string,
  launch: string,
  event: RebalanceEvent,
): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO rebalances (factory, launch, timestamp, skim_usd, new_loop_lev, tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [norm(factory), norm(launch), event.timestamp, event.skimUsd, event.newLoopLev, event.txHash],
  );
  await query(
    `DELETE FROM rebalances WHERE launch = $1 AND id NOT IN (
       SELECT id FROM rebalances WHERE launch = $1 ORDER BY timestamp DESC LIMIT $2
     )`,
    [norm(launch), REBALANCE_MAX],
  );
}

export async function listRebalances(launch: string): Promise<RebalanceEvent[]> {
  await ensureSchema();
  const rows = await query<RebalanceEvent & { skim_usd: string; new_loop_lev: string; tx_hash: string }>(
    `SELECT timestamp, skim_usd, new_loop_lev, tx_hash
     FROM rebalances WHERE launch = $1 ORDER BY timestamp DESC LIMIT $2`,
    [norm(launch), REBALANCE_MAX],
  );
  return rows.map((r) => ({
    timestamp: Number(r.timestamp),
    skimUsd: r.skim_usd,
    newLoopLev: r.new_loop_lev,
    txHash: r.tx_hash,
  }));
}

export async function upsertXProfile(address: string, profile: XProfile): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO x_profiles (address, id, name, username, profile_image_url, connected_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (address) DO UPDATE SET
       id = EXCLUDED.id, name = EXCLUDED.name, username = EXCLUDED.username,
       profile_image_url = EXCLUDED.profile_image_url,
       connected_at = COALESCE(EXCLUDED.connected_at, x_profiles.connected_at),
       updated_at = EXCLUDED.updated_at`,
    [
      norm(address),
      profile.id,
      profile.name,
      profile.username,
      profile.profileImageUrl,
      profile.connectedAt ?? null,
      profile.updatedAt,
    ],
  );
}

export async function listXProfiles(): Promise<Record<string, XProfile>> {
  await ensureSchema();
  const rows = await query<{
    address: string;
    id: string;
    name: string;
    username: string;
    profile_image_url: string;
    connected_at: string | number | null;
    updated_at: string | number;
  }>(`SELECT address, id, name, username, profile_image_url, connected_at, updated_at FROM x_profiles`);
  const out: Record<string, XProfile> = {};
  for (const r of rows) {
    // Keys are normalized on write (norm()), but re-normalize on the way out too: every client
    // lookup is lowercase, so one mixed-case row here would silently become an unreadable (or
    // worse, wallet-ambiguous) entry.
    out[norm(r.address)] = {
      id: r.id,
      name: r.name,
      username: r.username,
      profileImageUrl: r.profile_image_url,
      connectedAt: r.connected_at == null ? undefined : Number(r.connected_at),
      updatedAt: Number(r.updated_at),
    };
  }
  return out;
}

export async function deleteXProfile(address: string): Promise<void> {
  await ensureSchema();
  await query(`DELETE FROM x_profiles WHERE address = $1`, [norm(address)]);
}

export async function wipeFactory(factory: string): Promise<void> {
  await ensureSchema();
  const f = norm(factory);
  await query(`DELETE FROM lyc_nav WHERE factory = $1`, [f]);
  await query(`DELETE FROM price_points WHERE factory = $1`, [f]);
  await query(`DELETE FROM ledger_totals WHERE factory = $1`, [f]);
  await query(`DELETE FROM trades WHERE factory = $1`, [f]);
  await query(`DELETE FROM rebalances WHERE factory = $1`, [f]);
}

/// Clean slate. Every table of session data, identity counters reset, schema ensured first so
/// this also works on a database that has never been migrated.
export async function wipeAllSessionData(): Promise<void> {
  await wipeDatabase();
}

// ---- faucet: one claim per address per asset per UTC day -----------------------------------

export type FaucetClaim = {
  address: string;
  asset: string;
  day: string; // UTC date, "2026-09-02"
  amount: string;
  tx: string;
  t: number;
};

export async function getFaucetClaim(address: string, asset: string, day: string): Promise<FaucetClaim | null> {
  await ensureSchema();
  const rows = await query<FaucetClaim>(
    `SELECT address, asset, day::text AS day, amount, tx, created_at AS t
     FROM faucet_claims WHERE address = $1 AND asset = $2 AND day = $3`,
    [norm(address), asset, day],
  );
  return rows[0] ?? null;
}

export async function recordFaucetClaim(claim: FaucetClaim): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO faucet_claims (address, asset, day, amount, tx, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (address, asset, day) DO NOTHING`,
    [norm(claim.address), claim.asset, claim.day, claim.amount, claim.tx, claim.t],
  );
}

// ---- content blobs: the image store behind the /api/ipfs gateway ----------------------------
// Content-addressed (`ipfs-<cid>` for pinned uploads, `ipfs-<sha256>` for local fallbacks), so
// repeat uploads dedupe on the primary key and serving is cache-forever safe.

export async function saveContentBlob(id: string, data: Buffer, contentType: string): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO content_blobs (id, data, content_type, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING`,
    [id, data, contentType, Date.now()],
  );
}

export async function getContentBlob(id: string): Promise<{ data: Buffer; contentType: string } | null> {
  await ensureSchema();
  const rows = await query<{ data: Buffer; content_type: string }>(
    `SELECT data, content_type FROM content_blobs WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  return { data: rows[0].data as Buffer, contentType: rows[0].content_type };
}

// ---- token metadata (image + social links, creator-signed) ---------------------------------

export type TokenMetadata = {
  launch: string;
  imageUrl: string | null;
  website: string | null;
  telegram: string | null;
  discord: string | null;
  twitter: string | null;
  description: string | null;
  createdAt: number;
};

export async function upsertTokenMetadata(meta: Omit<TokenMetadata, "createdAt"> & { createdAt?: number }): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO token_metadata (launch, image_url, website, telegram, discord, twitter, description, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (launch) DO UPDATE SET
        image_url = EXCLUDED.image_url,
        website = EXCLUDED.website,
        telegram = EXCLUDED.telegram,
        discord = EXCLUDED.discord,
        twitter = EXCLUDED.twitter,
        description = EXCLUDED.description`,
    [
      norm(meta.launch),
      meta.imageUrl ?? null,
      meta.website ?? null,
      meta.telegram ?? null,
      meta.discord ?? null,
      meta.twitter ?? null,
      meta.description ?? null,
      meta.createdAt ?? Date.now(),
    ],
  );
}

export async function getTokenMetadata(launch: string): Promise<TokenMetadata | null> {
  await ensureSchema();
  const rows = await query<{
    launch: string;
    image_url: string | null;
    website: string | null;
    telegram: string | null;
    discord: string | null;
    twitter: string | null;
    description: string | null;
    created_at: string | number;
  }>(`SELECT launch, image_url, website, telegram, discord, twitter, description, created_at FROM token_metadata WHERE launch = $1`, [
    norm(launch),
  ]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    launch: r.launch,
    imageUrl: r.image_url,
    website: r.website,
    telegram: r.telegram,
    discord: r.discord,
    twitter: r.twitter,
    description: r.description,
    createdAt: Number(r.created_at),
  };
}

export async function listTokenMetadata(launches: string[]): Promise<Record<string, TokenMetadata>> {
  if (launches.length === 0) return {};
  await ensureSchema();
  const norms = launches.map(norm);
  const placeholders = norms.map((_, i) => `$${i + 1}`).join(",");
  const rows = await query<{
    launch: string;
    image_url: string | null;
    website: string | null;
    telegram: string | null;
    discord: string | null;
    twitter: string | null;
    description: string | null;
    created_at: string | number;
  }>(`SELECT launch, image_url, website, telegram, discord, twitter, description, created_at FROM token_metadata WHERE launch IN (${placeholders})`, norms);
  const out: Record<string, TokenMetadata> = {};
  for (const r of rows) {
    out[r.launch] = {
      launch: r.launch,
      imageUrl: r.image_url,
      website: r.website,
      telegram: r.telegram,
      discord: r.discord,
      twitter: r.twitter,
      description: r.description,
      createdAt: Number(r.created_at),
    };
  }
  return out;
}

// ---- follows: the on-platform social graph --------------------------------------------------
// Identity is the wallet address (identity != X account), so follows work for everyone.

export type FollowCounts = { followers: number; following: number };

export async function followCounts(target: string): Promise<FollowCounts> {
  await ensureSchema();
  const rows = await query<{ followers: string; following: string }>(
    `SELECT
       (SELECT count(*) FROM follows WHERE target = $1)   AS followers,
       (SELECT count(*) FROM follows WHERE follower = $1) AS following`,
    [norm(target)],
  );
  const r = rows[0];
  return { followers: Number(r?.followers ?? 0), following: Number(r?.following ?? 0) };
}

export async function isFollowing(follower: string, target: string): Promise<boolean> {
  await ensureSchema();
  const rows = await query<{ follower: string }>(
    `SELECT follower FROM follows WHERE follower = $1 AND target = $2 LIMIT 1`,
    [norm(follower), norm(target)],
  );
  return rows.length > 0;
}

export async function addFollow(follower: string, target: string, t: number): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO follows (follower, target, created_at) VALUES ($1,$2,$3)
     ON CONFLICT (follower, target) DO NOTHING`,
    [norm(follower), norm(target), t],
  );
}

export async function removeFollow(follower: string, target: string): Promise<void> {
  await ensureSchema();
  await query(`DELETE FROM follows WHERE follower = $1 AND target = $2`, [norm(follower), norm(target)]);
}

export type FollowListEntry = {
  address: string;
  xName: string;
  xUsername: string;
  xImageUrl: string;
};

/// The wallets behind a profile's follower/following count, newest first. The X enrichment is a
/// LEFT JOIN, so a wallet that never connected Twitter still lists -- just under its bare address.
export async function listFollows(address: string, kind: "followers" | "following"): Promise<FollowListEntry[]> {
  await ensureSchema();
  const rows = await query<{
    address: string;
    name: string;
    username: string;
    profile_image_url: string;
  }>(
    kind === "followers"
      ? `SELECT f.follower AS address, x.name, x.username, x.profile_image_url
           FROM follows f LEFT JOIN x_profiles x ON x.address = f.follower
          WHERE f.target = $1 ORDER BY f.created_at DESC`
      : `SELECT f.target AS address, x.name, x.username, x.profile_image_url
           FROM follows f LEFT JOIN x_profiles x ON x.address = f.target
          WHERE f.follower = $1 ORDER BY f.created_at DESC`,
    [norm(address)],
  );
  return rows.map((r) => ({
    address: r.address,
    xName: r.name ?? "",
    xUsername: r.username ?? "",
    xImageUrl: r.profile_image_url ?? "",
  }));
}

/// Trending launches for the marquee bar: last known implied price (usd/token), the price at the
/// start of the 24h window (or listing price for younger coins), and 24h USD volume — all off
/// the `trades` table, which every swap already feeds. A coin with no trades in the window is
/// not trending, by definition.
export type TrendingRow = {
  launch: string;
  volume24h: number;
  priceUsd: number;
  change24h: number;
  imageUrl: string | null;
};

export async function listTrending(cutoffMs: number, limit = 24): Promise<TrendingRow[]> {
  await ensureSchema();
  const rows = await query<{ launch: string; vol24: string; p_start: string; p_now: string; image_url: string | null }>(
    `WITH agg AS (
       SELECT launch,
              COALESCE(SUM(usd_wad::numeric) FILTER (WHERE t >= $1), 0) AS vol24
       FROM trades GROUP BY launch HAVING MAX(t) >= $1
     ),
     firstp AS (
       SELECT DISTINCT ON (launch) launch,
              (usd_wad::numeric / NULLIF(token_wad::numeric, 0)) AS p_start
       FROM trades WHERE t >= $1 AND token_wad::numeric > 0 ORDER BY launch, t ASC
     ),
     lastp AS (
       SELECT DISTINCT ON (launch) launch,
              (usd_wad::numeric / NULLIF(token_wad::numeric, 0)) AS p_now
       FROM trades WHERE token_wad::numeric > 0 ORDER BY launch, t DESC
     )
     SELECT a.launch, a.vol24, f.p_start, l.p_now, m.image_url
     FROM agg a
     JOIN lastp l USING (launch)
     JOIN firstp f USING (launch)
     LEFT JOIN token_metadata m ON m.launch = a.launch
     WHERE f.p_start > 0
     ORDER BY a.vol24 DESC
     LIMIT $2`,
    [cutoffMs, limit],
  );
  return rows.map((r) => {
    const pStart = Number(r.p_start);
    const pNow = Number(r.p_now);
    return {
      launch: r.launch,
      volume24h: Number(r.vol24) / 1e18,
      priceUsd: pNow / 1e18,
      change24h: pStart > 0 ? ((pNow - pStart) / pStart) * 100 : 0,
      imageUrl: r.image_url,
    };
  });
}
