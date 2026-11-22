import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { BackendConfig, FileMeta, ListOpts, PresignOpts, StorageBackend, UploadResult } from "./types";
import { readNumberOption, readStringOption } from "./types";
import { bufferFromStream, chunksFromStream, healthResult } from "./utils";

export interface S3ObjectRecord {
  key: string;
  size: number;
  etag?: string;
  versionId?: string;
  lastModified?: string;
  metadata?: Record<string, string>;
}

export interface S3ClientAdapter {
  putObject(input: { bucket: string; key: string; body: Buffer; contentType: string; metadata: Record<string, string> }): Promise<{ versionId?: string }>;
  getObject(bucket: string, key: string): Promise<{ body: Readable; versionId?: string }>;
  deleteObject(bucket: string, key: string): Promise<void>;
  headObject(bucket: string, key: string): Promise<boolean>;
  listObjects(input: { bucket: string; prefix: string; limit: number; cursor?: string }): Promise<S3ObjectRecord[]>;
  headBucket(bucket: string): Promise<void>;
  presign(input: { bucket: string; key: string; operation: "download" | "upload"; expiresIn: number; contentType?: string }): Promise<string>;
  createMultipartUpload?(input: { bucket: string; key: string; contentType: string; metadata: Record<string, string> }): Promise<string>;
  uploadPart?(input: { bucket: string; key: string; uploadId: string; index: number; body: Buffer }): Promise<string>;
  completeMultipartUpload?(input: { bucket: string; key: string; uploadId: string; parts: Array<{ index: number; etag: string }> }): Promise<{ versionId?: string }>;
  abortMultipartUpload?(input: { bucket: string; key: string; uploadId: string }): Promise<void>;
}

export class S3StorageBackend implements StorageBackend {
  private bucket = "";
  private prefix = "";
  private partSize = 8 * 1024 * 1024;
  private multipartThreshold = 16 * 1024 * 1024;
  private name = "s3";

  constructor(private readonly client: S3ClientAdapter) {}

  async init(config: BackendConfig): Promise<void> {
    this.name = config.name;
    this.bucket = required(config.options.bucket, "S3 bucket");
    this.prefix = readStringOption(config, "prefix").replace(/^\/+|\/+$/g, "");
    this.partSize = readNumberOption(config, "partSize", this.partSize);
    this.multipartThreshold = readNumberOption(config, "multipartThreshold", this.multipartThreshold);
    if (this.partSize < 5 * 1024 * 1024) throw new Error("S3 multipart part size must be at least 5 MiB");
    if (metaSizeWillMultipart(0, this.multipartThreshold) && !this.client.createMultipartUpload) throw new Error("S3 multipart adapter is incomplete");
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const key = this.key(meta.id);
    const multipart = meta.size >= this.multipartThreshold;
    if (!multipart) {
      const body = await bufferFromStream(stream);
      const checksum = createHash("sha256").update(body).digest("hex");
      const result = await this.client.putObject({ bucket: this.bucket, key, body, contentType: meta.mimeType, metadata: meta.metadata });
      return { id: meta.id, backend: "s3", size: body.length, checksum, ...(result.versionId ? { versionId: result.versionId } : {}) };
    }
    const { createMultipartUpload, uploadPart, completeMultipartUpload, abortMultipartUpload } = this.client;
    if (!createMultipartUpload || !uploadPart || !completeMultipartUpload || !abortMultipartUpload) throw new Error("S3 multipart adapter is incomplete");
    const uploadId = await createMultipartUpload({ bucket: this.bucket, key, contentType: meta.mimeType, metadata: meta.metadata });
    const hash = createHash("sha256");
    const parts: Array<{ index: number; etag: string }> = [];
    let size = 0;
    try {
      let index = 1;
      for await (const body of chunksFromStream(stream, this.partSize)) {
        hash.update(body);
        size += body.length;
        const etag = await uploadPart({ bucket: this.bucket, key, uploadId, index, body });
        parts.push({ index, etag });
        index += 1;
      }
      const result = await completeMultipartUpload({ bucket: this.bucket, key, uploadId, parts });
      return { id: meta.id, backend: "s3", size, checksum: hash.digest("hex"), ...(result.versionId ? { versionId: result.versionId } : {}) };
    } catch (error) {
      await abortMultipartUpload({ bucket: this.bucket, key, uploadId }).catch(() => undefined);
      throw error;
    }
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
    if (!Number.isSafeInteger(opts.expiresIn) || opts.expiresIn <= 0 || opts.expiresIn > 604800) throw new Error("S3 URL expiry must be between 1 second and 7 days");
    return this.client.presign({ bucket: this.bucket, key: this.key(id), operation: opts.operation ?? "download", expiresIn: opts.expiresIn, ...(opts.contentType ? { contentType: opts.contentType } : {}) });
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    const tenantPrefix = opts.tenantId ? `${opts.tenantId}/${prefix}` : prefix;
    const records = await this.client.listObjects({ bucket: this.bucket, prefix: this.key(tenantPrefix), limit: Math.min(Math.max(opts.limit ?? 100, 1), 1000), ...(opts.cursor ? { cursor: opts.cursor } : {}) });
    return records.map((record) => ({
      id: this.unkey(record.key), name: this.unkey(record.key).split("/").pop() ?? record.key, size: record.size,
      mimeType: record.metadata?.mimeType ?? "application/octet-stream", checksum: record.etag?.replaceAll('"', ""),
      backend: "s3", ...(record.versionId ? { versionId: record.versionId } : {}), createdAt: record.lastModified ?? new Date(0).toISOString(), metadata: record.metadata ?? {},
    }));
  }

  async healthCheck() {
    return healthResult(this.name, "s3", () => this.client.headBucket(this.bucket));
  }

  private key(id: string): string {
    assertObjectId(id);
    return this.prefix ? `${this.prefix}/${id}` : id;
  }

  private unkey(key: string): string {
    return this.prefix && key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key;
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function assertObjectId(id: string): void {
  if (!id || id.includes("\0") || id.startsWith("/") || id.split("/").includes("..")) throw new Error("Invalid object identifier");
}

function metaSizeWillMultipart(size: number, threshold: number): boolean {
  return size >= threshold;
}
