import { Pool, type PoolClient } from "pg";
import type { DatabaseClient, QueryExecutor, QueryResult } from "./database";

export class PostgresAdapter implements DatabaseClient {
  private readonly pool: Pool;
  constructor(pool: Pool | string) { this.pool = typeof pool === "string" ? new Pool({ connectionString: pool }) : pool; }
  async query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>> { const result = await this.pool.query(sql, [...parameters]); return { rows: result.rows as Row[] }; }
  async transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await operation(new PgExecutor(client)); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}
class PgExecutor implements QueryExecutor {
  constructor(private readonly client: PoolClient) {}
  async query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>> { const result = await this.client.query(sql, [...parameters]); return { rows: result.rows as Row[] }; }
}
