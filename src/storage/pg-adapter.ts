import { Pool, type PoolClient } from "pg";
import type { DatabaseClient, QueryExecutor, QueryResult } from "./database";

export class PostgresAdapter implements DatabaseClient {
  private readonly pool: Pool;

  constructor(pool: Pool | string) {
    this.pool = typeof pool === "string" ? new Pool({ connectionString: pool }) : pool;
  }

  async query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>> {
    const result = await this.pool.query(sql, [...parameters]);
    return { rows: result.rows as Row[] };
  }

  async transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const result = await operation(new PgExecutor(client));
      await client.query("COMMIT");
      committed = true;
      return result;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async *iterate<Row>(
    sql: string,
    parameters: readonly unknown[],
    options: { batchSize?: number } = {},
  ): AsyncGenerator<Row> {
    const batchSize = options.batchSize ?? 128;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 10000)
      throw new Error("Invalid database cursor batch size");
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("DECLARE fileexpress_blob_cursor NO HOLD CURSOR FOR " + sql, [...parameters]);
      while (true) {
        const result = await client.query(`FETCH FORWARD ${batchSize} FROM fileexpress_blob_cursor`);
        const rows = result.rows as Row[];
        for (const row of rows) yield row;
        if (rows.length < batchSize) break;
      }
      await client.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
}

class PgExecutor implements QueryExecutor {
  constructor(private readonly client: PoolClient) {}

  async query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>> {
    const result = await this.client.query(sql, [...parameters]);
    return { rows: result.rows as Row[] };
  }
}
