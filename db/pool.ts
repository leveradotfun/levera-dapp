import { Pool } from "pg";

const DEFAULT_URL = "postgresql://mac@127.0.0.1:5432/levera";

let pool: Pool | null = null;

/// A hosted Postgres (Supabase, Neon, RDS, ...) requires TLS and presents a cert most Node trust
/// stores don't chain to a known root -- `pg` throws SELF_SIGNED_CERT_IN_CHAIN without an explicit
/// ssl option. Localhost never needs this (no TLS listener there at all), so gate on the host
/// rather than making every environment configure it by hand.
function sslFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  const isLocal = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(connectionString);
  return isLocal ? undefined : { rejectUnauthorized: false };
}

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || DEFAULT_URL;
    pool = new Pool({
      connectionString,
      max: 8,
      ssl: sslFor(connectionString),
    });
  }
  return pool;
}

export async function query<T extends object = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}
