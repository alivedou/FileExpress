import { createHash, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { withStorageLock } from "./concurrency";
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

export interface S3ObjectRecord {
  key: string;
  size: number;
  etag?: string;
  versionId?: string;
  lastModified?: string;
  metadata?: Record<string, string>;
  isLatest?: boolean;
  isDeleteMarker?: boolean;
}

export interface S3ListPage {
  records: S3ObjectRecord[];
  nextCursor?: string;
}

export interface S3ClientAdapter {
  putObject(input: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<{ versionId?: string }>;
  getObject(bucket: string, key: string, versionId?: string): Promise<{ body: Readable; versionId?: string }>;
  deleteObject(bucket: string, key: string, versionId?: string): Promise<void>;
  headObject(bucket: string, key: string): Promise<boolean>;
  listObjects(input: {
    bucket: string;
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<S3ObjectRecord[]>;
  listObjectsPage?(input: {
    bucket: string;
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<S3ListPage>;
  headBucket(bucket: string): Promise<void>;
  presign(input: {
    bucket: string;
    key: string;
    operation: "download" | "upload";
    expiresIn: number;
    contentType?: string;
    versionId?: string;
  }): Promise<string>;
  createMultipartUpload?(input: {
    bucket: string;
    key: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<string>;
  uploadPart?(input: {
    bucket: string;
    key: string;
    uploadId: string;
    index: number;
    body: Buffer;
    checksum?: string;
  }): Promise<string>;
  completeMultipartUpload?(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: Array<{ index: number; etag: string }>;
  }): Promise<{ versionId?: string }>;
  abortMultipartUpload?(input: { bucket: string; key: string; uploadId: string }): Promise<void>;
}

export class S3StorageBackend implements StorageBackend {
  private bucket = "";
  private prefix = "";
  private partSize = 8 * 1024 * 1024;
  private multipartThreshold = 16 * 1024 * 1024;
  private maxFileSize = Number.MAX_SAFE_INTEGER;
  private name = "s3";

  constructor(private readonly client: S3ClientAdapter) {}

  async init(config: BackendConfig): Promise<void> {
    this.name = config.name;
    this.bucket = required(config.options.bucket, "S3 bucket");
    this.prefix = readStringOption(config, "prefix").replace(/^\/+|\/+$/g, "");
    assertObjectId(this.prefix || "root");
    this.partSize = readNumberOption(config, "partSize", this.partSize);
    this.multipartThreshold = readNumberOption(config, "multipartThreshold", this.multipartThreshold);
    this.maxFileSize = config.maxFileSize ?? readNumberOption(config, "maxFileSize", Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(this.partSize) || this.partSize < 5 * 1024 * 1024)
      throw new Error("S3 multipart part size must be at least 5 MiB");
    if (!Number.isSafeInteger(this.multipartThreshold) || this.multipartThreshold < 0)
      throw new Error("Invalid S3 multipart threshold");
    if (!Number.isSafeInteger(this.maxFileSize) || this.maxFileSize < 0)
      throw new Error("Invalid S3 file size limit");
    if (this.multipartThreshold <= this.maxFileSize && !hasMultipartSupport(this.client))
      throw new Error("S3 multipart adapter is incomplete");
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const key = this.key(meta.id);
    return withStorageLock(`s3:${this.bucket}/${key}`, () => this.uploadLocked(stream, meta, key));
  }

  async download(id: string): Promise<Readable> {
    return (await this.client.getObject(this.bucket, this.key(id))).body;
  }

  async delete(id: string): Promise<void> {
    await this.client.deleteObject(this.bucket, this.key(id));
  }

  async exists(id: string): Promise<boolean> {
    return this.client.headObject(this.bucket, this.key(id));
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    if (!Number.isSafeInteger(opts.expiresIn) || opts.expiresIn <= 0 || opts.expiresIn > 604800)
      throw new Error("S3 URL expiry must be between 1 second and 7 days");
    return this.client.presign({
      bucket: this.bucket,
      key: this.key(id),
      operation: opts.operation ?? "download",
      expiresIn: opts.expiresIn,
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
      ...(opts.versionId ? { versionId: opts.versionId } : {}),
    });
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    return (await this.listPage(prefix, opts)).files;
  }

  async listPage(prefix: string, opts: ListOpts): Promise<StorageListPage> {
    assertListPrefix(prefix);
    const tenantPrefix = opts.tenantId ? `${opts.tenantId}/${prefix}` : prefix;
    const input = {
      bucket: this.bucket,
      prefix: this.listKey(tenantPrefix),
      limit: boundedLimit(opts.limit),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    };
    const page = this.client.listObjectsPage
      ? await this.client.listObjectsPage(input)
      : { records: await this.client.listObjects(input), nextCursor: undefined };
    if (!this.client.listObjectsPage && page.records.length === input.limit)
      throw new Error("S3 adapter cannot guarantee complete pagination");
    const files: FileMeta[] = page.records
      .filter((record) => this.ownsKey(record.key) && !record.isDeleteMarker)
      .map((record) => {
        const id = this.unkey(record.key);
        const metadata = record.metadata ?? {};
        return {
          id,
          name: id.split("/").pop() ?? record.key,
          size: record.size,
          mimeType: metadata.mimeType ?? "application/octet-stream",
          ...(metadata.sha256 || record.etag
            ? { checksum: metadata.sha256 ?? record.etag?.replaceAll('"', "") }
            : {}),
          backend: "s3",
          ...(record.versionId ? { versionId: record.versionId } : {}),
          ...(metadata.tenantId || opts.tenantId ? { tenantId: metadata.tenantId ?? opts.tenantId } : {}),
          createdAt: record.lastModified ?? new Date(0).toISOString(),
          metadata,
        };
      });
    return { files, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async healthCheck(): Promise<HealthStatus> {
    return healthResult(this.name, "s3", () => this.client.headBucket(this.bucket));
  }

  private async uploadLocked(stream: Readable, meta: FileMeta, key: string): Promise<UploadResult> {
    const iterator = chunksFromStream(stream, this.partSize)[Symbol.asyncIterator]();
    const buffered: Buffer[] = [];
    let bufferedSize = 0;
    try {
      while (bufferedSize < this.multipartThreshold) {
        const next = await iterator.next();
        if (next.done) {
          const body = Buffer.concat(buffered, bufferedSize);
          return await this.putSmall(key, body, meta);
        }
        buffered.push(next.value);
        bufferedSize += next.value.length;
        this.assertSize(bufferedSize);
      }
      if (this.multipartThreshold === 0 && buffered.length === 0) {
        const first = await iterator.next();
        if (first.done) return await this.putSmall(key, Buffer.alloc(0), meta);
        buffered.push(first.value);
        bufferedSize = first.value.length;
        this.assertSize(bufferedSize);
      }
      return await this.putMultipart(key, meta, buffered, iterator);
    } catch (error) {
      stream.destroy();
      await iterator.return?.(undefined).catch(() => undefined);
      throw error;
    }
  }

  private async putSmall(key: string, body: Buffer, meta: FileMeta): Promise<UploadResult> {
    const checksum = createHash("sha256").update(body).digest("hex");
    assertExpectedChecksum(meta.checksum, checksum);
    const result = await this.client.putObject({
      bucket: this.bucket,
      key,
      body,
      contentType: meta.mimeType,
      metadata: objectMetadata(meta, checksum),
    });
    return {
      id: meta.id,
      backend: "s3",
      size: body.length,
      checksum,
      ...(result.versionId ? { versionId: result.versionId } : {}),
    };
  }

  private async putMultipart(
    key: string,
    meta: FileMeta,
    initial: Buffer[],
    iterator: AsyncIterator<Buffer>,
  ): Promise<UploadResult> {
    const createMultipartUpload = this.client.createMultipartUpload?.bind(this.client);
    const uploadPart = this.client.uploadPart?.bind(this.client);
    const completeMultipartUpload = this.client.completeMultipartUpload?.bind(this.client);
    const abortMultipartUpload = this.client.abortMultipartUpload?.bind(this.client);
    if (!createMultipartUpload || !uploadPart || !completeMultipartUpload || !abortMultipartUpload)
      throw new Error("S3 multipart adapter is incomplete");
    const uploadId = await createMultipartUpload({
      bucket: this.bucket,
      key,
      contentType: meta.mimeType,
      metadata: objectMetadata(meta),
    });
    const hash = createHash("sha256");
    const parts: Array<{ index: number; etag: string }> = [];
    let size = 0;
    const uploadBody = async (body: Buffer): Promise<void> => {
      const index = parts.length + 1;
      if (index > 10000) throw new Error("S3 multipart upload exceeds 10000 parts");
      size += body.length;
      this.assertSize(size);
      hash.update(body);
      const checksum = createHash("sha256").update(body).digest("base64");
      const etag = await uploadPart({ bucket: this.bucket, key, uploadId, index, body, checksum });
      parts.push({ index, etag });
    };
    try {
      for (const body of initial) await uploadBody(body);
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        await uploadBody(next.value);
      }
      const checksum = hash.digest("hex");
      assertExpectedChecksum(meta.checksum, checksum);
      const result = await completeMultipartUpload({ bucket: this.bucket, key, uploadId, parts });
      return {
        id: meta.id,
        backend: "s3",
        size,
        checksum,
        ...(result.versionId ? { versionId: result.versionId } : {}),
      };
    } catch (error) {
      await abortMultipartUpload({ bucket: this.bucket, key, uploadId }).catch(() => undefined);
      throw error;
    }
  }

  private assertSize(size: number): void {
    if (!Number.isSafeInteger(size) || size > this.maxFileSize)
      throw new Error("Stream exceeds configured size limit");
  }

  private key(id: string): string {
    assertObjectId(id);
    return this.prefix ? `${this.prefix}/${id}` : id;
  }

  private listKey(id: string): string {
    assertListPrefix(id);
    return this.prefix ? `${this.prefix}/${id}` : id;
  }

  private ownsKey(key: string): boolean {
    return this.prefix ? key.startsWith(`${this.prefix}/`) : true;
  }

  private unkey(key: string): string {
    return this.prefix ? key.slice(this.prefix.length + 1) : key;
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function assertObjectId(id: string): void {
  const segments = id.split("/");
  if (
    !id ||
    id.includes("\0") ||
    id.includes("\\") ||
    id.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("Invalid object identifier");
}

function assertListPrefix(id: string): void {
  if (id.includes("\0") || id.includes("\\") || id.startsWith("/")) throw new Error("Invalid list prefix");
  const segments = id.split("/");
  if (
    segments.some(
      (segment, index) => segment === "." || segment === ".." || (!segment && index < segments.length - 1),
    )
  )
    throw new Error("Invalid list prefix");
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid list limit");
  return Math.min(limit, 1000);
}

function hasMultipartSupport(client: S3ClientAdapter): boolean {
  return Boolean(
    client.createMultipartUpload &&
    client.uploadPart &&
    client.completeMultipartUpload &&
    client.abortMultipartUpload,
  );
}

function objectMetadata(meta: FileMeta, checksum?: string): Record<string, string> {
  return {
    ...meta.metadata,
    mimeType: meta.mimeType,
    ...(meta.tenantId ? { tenantId: meta.tenantId } : {}),
    ...(checksum ? { sha256: checksum } : {}),
  };
}

function assertExpectedChecksum(expected: string | undefined, actual: string): void {
  if (!expected) return;
  if (
    !/^[a-f0-9]{64}$/i.test(expected) ||
    expected.length !== actual.length ||
    !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
  )
    throw new Error("Object checksum mismatch");
}
