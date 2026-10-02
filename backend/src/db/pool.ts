import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";

export function createPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    application_name: "gargantua-backend",
  });
}

export async function migrate(pool: Pool): Promise<void> {
  for (const migration of ["001_init.sql", "002_privy_solana.sql"]) {
    const sql = await readFile(resolve(process.cwd(), "sql", migration), "utf8");
    await pool.query(sql);
  }
}

export async function withTx<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(pool: Pool, sql: string, values: unknown[] = []): Promise<T | null> {
  const result: QueryResult<T> = await pool.query<T>(sql, values);
  return result.rows[0] ?? null;
}
