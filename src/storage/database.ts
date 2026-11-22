import { createHash, createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { BackendConfig, FileMeta, ListOpts, PresignOpts, StorageBackend, UploadResult } from "./types";
import { readNumberOption, readStringOption } from "./types";
import { chunksFromStream, healthResult } from "./utils";

export interface QueryResult<Row> { rows: Row[] }
export interface QueryExecutor { query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>> }
export interface DatabaseClient {
  transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T>;
  query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>>;
}
interface StoredRow { id: string; name: string; size: string | number; mime_type: string; checksum: string; tenant_id: string | null; owner_id: string | null; created_at: string; expires_at: string | null; metadata: Record<string, string> }

export class DatabaseBlobStorageBackend implements StorageBackend {
  private table = "fileexpress_objects";
  private chunkSize = 1024 * 1024;
  private signingSecret = "database-development-secret";
  private baseUrl = "/api/storage/db";
  private name = "db";

  constructor(private readonly client: DatabaseClient) {}

  async init(config: BackendConfig): Promise<void> {
    this.name = config.name;
    const requested = readStringOption(config, "table", this.table);
    if (!/^[a-z_][a-z0-9_]*$/i.test(requested)) throw new Error("Invalid database table name");
    this.table = requested;
    this.chunkSize = readNumberOption(config, "chunkSize", this.chunkSize);
    this.signingSecret = readStringOption(config, "signingSecret", this.signingSecret);
    this.baseUrl = readStringOption(config, "baseUrl", this.baseUrl);
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, name TEXT NOT NULL, size BIGINT NOT NULL, mime_type TEXT NOT NULL, checksum TEXT NOT NULL, tenant_id TEXT, owner_id TEXT, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, metadata JSONB NOT NULL)`, []);
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table}_chunks (object_id TEXT NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, content BYTEA NOT NULL, PRIMARY KEY(object_id, sequence))`, []);
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_search_idx ON ${this.table} USING GIN (to_tsvector('simple', name || ' ' || metadata::text))`, []);
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const id = meta.id || randomUUID();
    return this.client.transaction(async (transaction) => {
      await transaction.query(`INSERT INTO ${this.table} (id,name,size,mime_type,checksum,tenant_id,owner_id,created_at,expires_at,metadata) VALUES ($1,$2,0,$3,'',$4,$5,$6,$7,$8::jsonb)`, [id, meta.name, meta.mimeType, meta.tenantId ?? null, meta.ownerId ?? null, meta.createdAt, meta.expiresAt ?? null, JSON.stringify(meta.metadata)]);
      const hash = createHash("sha256");
      let size = 0;
      let sequence = 0;
      try {
        for await (const chunk of chunksFromStream(stream, this.chunkSize)) {
          await transaction.query(`INSERT INTO ${this.table}_chunks (object_id,sequence,content) VALUES ($1,$2,$3)`, [id, sequence, chunk]);
          hash.update(chunk);
          size += chunk.length;
          sequence += 1;
        }
        const checksum = hash.digest("hex");
        await transaction.query(`UPDATE ${this.table} SET size=$2, checksum=$3 WHERE id=$1`, [id, size, checksum]);
        return { id, backend: "db" as const, size, checksum };
      } catch (error) {
        throw new Error("Database BLOB upload rolled back", { cause: error });
      }
    });
  }

  async download(id: string): Promise<Readable> {
    const result = await this.client.query<{ sequence: number; content: Buffer }>(`SELECT sequence,content FROM ${this.table}_chunks WHERE object_id=$1 ORDER BY sequence`, [id]);
    if (!result.rows.length) throw new Error("Object not found");
    return Readable.from(result.rows.map((row) => row.content));
  }

  async delete(id: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE id=$1`, [id]);
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.client.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${this.table} WHERE id=$1) AS exists`, [id]);
    return result.rows[0]?.exists ?? false;
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + opts.expiresIn;
    const operation = opts.operation ?? "download";
    const signature = createHmac("sha256", this.signingSecret).update(`${id}:${expires}:${operation}`).digest("base64url");
    return `${this.baseUrl}/${encodeURIComponent(id)}?${new URLSearchParams({ expires: String(expires), operation, signature })}`;
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const offset = Number.parseInt(opts.cursor ?? "0", 10) || 0;
    const result = await this.client.query<StoredRow>(`SELECT * FROM ${this.table} WHERE (name LIKE $1 OR id LIKE $1) AND ($2::text IS NULL OR tenant_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [`${prefix}%`, opts.tenantId ?? null, limit, offset]);
    return result.rows.map((row) => ({ id: row.id, name: row.name, size: Number(row.size), mimeType: row.mime_type, checksum: row.checksum, backend: "db", ...(row.tenant_id ? { tenantId: row.tenant_id } : {}), ...(row.owner_id ? { ownerId: row.owner_id } : {}), createdAt: row.created_at, ...(row.expires_at ? { expiresAt: row.expires_at } : {}), metadata: row.metadata }));
  }

  async search(tenantId: string, query: string, limit = 100): Promise<FileMeta[]> {
    const result = await this.client.query<StoredRow>(`SELECT * FROM ${this.table} WHERE tenant_id=$1 AND to_tsvector('simple',name || ' ' || metadata::text) @@ plainto_tsquery('simple',$2) ORDER BY created_at DESC LIMIT $3`, [tenantId, query, limit]);
    return result.rows.map((row) => ({ id: row.id, name: row.name, size: Number(row.size), mimeType: row.mime_type, checksum: row.checksum, backend: "db", tenantId, createdAt: row.created_at, metadata: row.metadata }));
  }

  async healthCheck() {
    return healthResult(this.name, "db", async () => { await this.client.query("SELECT 1", []); });
  }
}
