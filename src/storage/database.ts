import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type {
  BackendConfig,
  FileMeta,
  HealthStatus,
  ListOpts,
  PresignOpts,
  StorageBackend,
  StorageListPage,
  UploadResult,
} from "./types";
import { readNumberOption, readStringOption } from "./types";
import { chunksFromStream, healthResult } from "./utils";

export interface QueryResult<Row> {
  rows: Row[];
}
export interface QueryExecutor {
  query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>>;
}
export interface DatabaseClient {
  transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T>;
  query<Row>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<Row>>;
  iterate?<Row>(
    sql: string,
    parameters: readonly unknown[],
    options?: { batchSize?: number },
  ): AsyncIterable<Row>;
}

interface StoredRow {
  id: string;
  name: string;
  size: string | number;
  mime_type: string;
  checksum: string;
  tenant_id: string | null;
  owner_id: string | null;
  created_at: string | Date;
  expires_at: string | Date | null;
  metadata: Record<string, string> | string | null;
}

interface ChunkRow {
  sequence: number;
  content: Buffer | Uint8Array;
}

export class DatabaseBlobStorageBackend implements StorageBackend {
  private table = "fileexpress_objects";
  private chunkSize = 1024 * 1024;
  private downloadBatchSize = 128;
  private maxFileSize = Number.MAX_SAFE_INTEGER;
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
    this.downloadBatchSize = readNumberOption(config, "downloadBatchSize", this.downloadBatchSize);
    this.maxFileSize = config.maxFileSize ?? readNumberOption(config, "maxFileSize", Number.MAX_SAFE_INTEGER);
    this.signingSecret = readStringOption(config, "signingSecret", this.signingSecret);
    this.baseUrl = readStringOption(config, "baseUrl", this.baseUrl);
    if (!Number.isSafeInteger(this.chunkSize) || this.chunkSize <= 0 || this.chunkSize > 64 * 1024 * 1024)
      throw new Error("Invalid database chunk size");
    if (
      !Number.isSafeInteger(this.downloadBatchSize) ||
      this.downloadBatchSize <= 0 ||
      this.downloadBatchSize > 10000
    )
      throw new Error("Invalid database download batch size");
    if (!Number.isSafeInteger(this.maxFileSize) || this.maxFileSize < 0)
      throw new Error("Invalid database file size limit");
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, name TEXT NOT NULL, size BIGINT NOT NULL, mime_type TEXT NOT NULL, checksum TEXT NOT NULL, tenant_id TEXT, owner_id TEXT, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, metadata JSONB NOT NULL)`,
      [],
    );
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table}_chunks (object_id TEXT NOT NULL REFERENCES ${this.table}(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, content BYTEA NOT NULL, PRIMARY KEY(object_id, sequence))`,
      [],
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_search_idx ON ${this.table} USING GIN (to_tsvector('simple', name || ' ' || metadata::text))`,
      [],
    );
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const id = meta.id || randomUUID();
    if (id.includes("\0")) throw new Error("Invalid object identifier");
    return this.client.transaction(async (transaction) => {
      try {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
        await transaction.query(
          `INSERT INTO ${this.table} (id,name,size,mime_type,checksum,tenant_id,owner_id,created_at,expires_at,metadata) VALUES ($1,$2,0,$3,'',$4,$5,$6,$7,$8::jsonb)`,
          [
            id,
            meta.name,
            meta.mimeType,
            meta.tenantId ?? null,
            meta.ownerId ?? null,
            meta.createdAt,
            meta.expiresAt ?? null,
            JSON.stringify(meta.metadata),
          ],
        );
        const hash = createHash("sha256");
        let size = 0;
        let sequence = 0;
        for await (const chunk of chunksFromStream(stream, this.chunkSize)) {
          size += chunk.length;
          if (!Number.isSafeInteger(size) || size > this.maxFileSize)
            throw new Error("Stream exceeds configured size limit");
          if (sequence >= 2147483647) throw new Error("Database BLOB has too many chunks");
          await transaction.query(
            `INSERT INTO ${this.table}_chunks (object_id,sequence,content) VALUES ($1,$2,$3)`,
            [id, sequence, chunk],
          );
          hash.update(chunk);
          sequence += 1;
        }
        const checksum = hash.digest("hex");
        assertExpectedChecksum(meta.checksum, checksum);
        await transaction.query(`UPDATE ${this.table} SET size=$2, checksum=$3 WHERE id=$1`, [
          id,
          size,
          checksum,
        ]);
        return { id, backend: "db" as const, size, checksum };
      } catch (error) {
        throw new Error("Database BLOB upload rolled back", { cause: error });
      }
    });
  }

  async download(id: string): Promise<Readable> {
    const object = await this.client.query<{ present: boolean }>(
      `SELECT TRUE AS present FROM ${this.table} WHERE id=$1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [id],
    );
    if (!object.rows.length) throw new Error("Object not found");
    if (this.client.iterate) {
      const rows = this.client.iterate<ChunkRow>(
        `SELECT sequence,content FROM ${this.table}_chunks WHERE object_id=$1 ORDER BY sequence`,
        [id],
        { batchSize: this.downloadBatchSize },
      );
      return Readable.from(this.readChunks(rows));
    }
    const result = await this.client.query<ChunkRow>(
      `SELECT sequence,content FROM ${this.table}_chunks WHERE object_id=$1 ORDER BY sequence`,
      [id],
    );
    return Readable.from(this.readChunks(result.rows));
  }

  async delete(id: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE id=$1`, [id]);
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${this.table} WHERE id=$1 AND (expires_at IS NULL OR expires_at > NOW())) AS exists`,
      [id],
    );
    return result.rows[0]?.exists ?? false;
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    if (!Number.isSafeInteger(opts.expiresIn) || opts.expiresIn <= 0 || opts.expiresIn > 604800)
      throw new Error("Database URL expiry must be between 1 second and 7 days");
    const expires = Math.floor(Date.now() / 1000) + opts.expiresIn;
    const operation = opts.operation ?? "download";
    const signature = createHmac("sha256", this.signingSecret)
      .update(`${id}:${expires}:${operation}`)
      .digest("base64url");
    return `${this.baseUrl}/${encodeURIComponent(id)}?${new URLSearchParams({ expires: String(expires), operation, signature })}`;
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    return (await this.listPage(prefix, opts)).files;
  }

  async listPage(prefix: string, opts: ListOpts): Promise<StorageListPage> {
    const limit = boundedLimit(opts.limit, 100, 1000);
    const offset = cursorOffset(opts.cursor);
    const pattern = `${escapeLike(prefix)}%`;
    const result = await this.client.query<StoredRow>(
      `SELECT * FROM ${this.table} WHERE (name LIKE $1 ESCAPE '\\' OR id LIKE $1 ESCAPE '\\') AND ($2::text IS NULL OR tenant_id=$2) AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC,id ASC LIMIT $3 OFFSET $4`,
      [pattern, opts.tenantId ?? null, limit, offset],
    );
    const files = result.rows.map((row) => mapStoredRow(row));
    return { files, ...(files.length === limit ? { nextCursor: String(offset + files.length) } : {}) };
  }

  async search(tenantId: string, query: string, limit = 100): Promise<FileMeta[]> {
    const bounded = boundedLimit(limit, 100, 1000);
    const result = await this.client.query<StoredRow>(
      `SELECT * FROM ${this.table} WHERE tenant_id=$1 AND (expires_at IS NULL OR expires_at > NOW()) AND to_tsvector('simple',name || ' ' || metadata::text) @@ plainto_tsquery('simple',$2) ORDER BY created_at DESC,id ASC LIMIT $3`,
      [tenantId, query, bounded],
    );
    return result.rows.map((row) => mapStoredRow(row, tenantId));
  }

  async healthCheck(): Promise<HealthStatus> {
    return healthResult(this.name, "db", async () => {
      await this.client.query("SELECT 1", []);
    });
  }

  private async *readChunks(rows: Iterable<ChunkRow> | AsyncIterable<ChunkRow>): AsyncGenerator<Buffer> {
    let expected = 0;
    for await (const row of rows) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== expected)
        throw new Error("Database BLOB chunk sequence is corrupt");
      const content = Buffer.isBuffer(row.content)
        ? row.content
        : Buffer.from(row.content.buffer, row.content.byteOffset, row.content.byteLength);
      expected += 1;
      yield content;
    }
  }
}

function mapStoredRow(row: StoredRow, tenantId?: string): FileMeta {
  const size = Number(row.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid stored object size");
  return {
    id: row.id,
    name: row.name,
    size,
    mimeType: row.mime_type,
    checksum: row.checksum,
    backend: "db",
    ...(row.tenant_id || tenantId ? { tenantId: row.tenant_id ?? tenantId } : {}),
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    createdAt: isoDate(row.created_at),
    ...(row.expires_at ? { expiresAt: isoDate(row.expires_at) } : {}),
    metadata: storedMetadata(row.metadata),
  };
}

function isoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function storedMetadata(value: StoredRow["metadata"]): Record<string, string> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, item]): Array<[string, string]> =>
      typeof item === "string" ? [[key, item]] : [],
    ),
  );
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid list limit");
  return Math.min(limit, maximum);
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error("Invalid list cursor");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid list cursor");
  return offset;
}

function assertExpectedChecksum(expected: string | undefined, actual: string): void {
  if (!expected) return;
  if (
    !/^[a-f0-9]{64}$/i.test(expected) ||
    !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
  )
    throw new Error("Object checksum mismatch");
}
