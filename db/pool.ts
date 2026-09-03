import { Pool } from "pg";

const DEFAULT_URL = "postgresql://mac@127.0.0.1:5432/levera";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || DEFAULT_URL,
      max: 8,
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
