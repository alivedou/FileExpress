import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { BackendConfig, FileMeta, ListOpts, PresignOpts, StorageBackend, UploadResult } from "./types";
import { readNumberOption, readStringOption } from "./types";
import { bufferFromStream, chunksFromStream, healthResult } from "./utils";

export interface AzureBlobRecord {
  name: string;
  size: number;
  contentType?: string;
  etag?: string;
  createdAt?: string;
  metadata?: Record<string, string>;
}

export interface AzureClientAdapter {
  upload(input: { container: string; name: string; body: Buffer; contentType: string; metadata: Record<string, string>; immutableUntil?: string }): Promise<{ versionId?: string }>;
  download(container: string, name: string): Promise<Readable>;
  delete(container: string, name: string): Promise<void>;
  exists(container: string, name: string): Promise<boolean>;
  list(input: { container: string; prefix: string; limit: number; cursor?: string; hierarchical?: boolean }): Promise<AzureBlobRecord[]>;
  presign(input: { container: string; name: string; operation: "download" | "upload"; expiresIn: number; contentType?: string }): Promise<string>;
  probe(container: string): Promise<void>;
  stageBlock?(input: { container: string; name: string; blockId: string; body: Buffer }): Promise<void>;
  commitBlocks?(input: { container: string; name: string; blockIds: string[]; contentType: string; metadata: Record<string, string>; immutableUntil?: string }): Promise<{ versionId?: string }>;
}

export class AzureBlobStorageBackend implements StorageBackend {
  private container = "";
  private prefix = "";
  private blockSize = 8 * 1024 * 1024;
  private threshold = 32 * 1024 * 1024;
  private name = "azure";
  private immutableUntil: string | undefined;
  private cdnBaseUrl = "";
  private hierarchical = false;

  constructor(private readonly client: AzureClientAdapter) {}

  async init(config: BackendConfig): Promise<void> {
    this.name = config.name;
    this.container = required(config.options.container, "Azure container");
    this.prefix = readStringOption(config, "prefix").replace(/^\/+|\/+$/g, "");
    this.blockSize = readNumberOption(config, "blockSize", this.blockSize);
    this.threshold = readNumberOption(config, "multipartThreshold", this.threshold);
    this.immutableUntil = readStringOption(config, "immutableUntil") || undefined;
    this.cdnBaseUrl = readStringOption(config, "cdnBaseUrl").replace(/\/$/, "");
    this.hierarchical = config.options.hierarchical === true;
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const name = this.key(meta.id);
    const common = { container: this.container, name, contentType: meta.mimeType, metadata: { ...meta.metadata, mimeType: meta.mimeType }, ...(this.immutableUntil ? { immutableUntil: this.immutableUntil } : {}) };
    if (meta.size < this.threshold || !this.client.stageBlock || !this.client.commitBlocks) {
      const body = await bufferFromStream(stream);
      const result = await this.client.upload({ ...common, body });
      return { id: meta.id, backend: "azure", size: body.length, checksum: createHash("sha256").update(body).digest("hex"), ...(result.versionId ? { versionId: result.versionId } : {}) };
    }
    const hash = createHash("sha256");
    const blockIds: string[] = [];
    let size = 0;
    let index = 0;
    for await (const body of chunksFromStream(stream, this.blockSize)) {
      const blockId = Buffer.from(`${randomUUID()}-${String(index).padStart(6, "0")}`).toString("base64");
      await this.client.stageBlock({ container: this.container, name, blockId, body });
      blockIds.push(blockId);
      hash.update(body);
      size += body.length;
      index += 1;
    }
    const result = await this.client.commitBlocks({ ...common, blockIds });
    return { id: meta.id, backend: "azure", size, checksum: hash.digest("hex"), ...(result.versionId ? { versionId: result.versionId } : {}) };
  }

  async download(id: string): Promise<Readable> {
    return this.client.download(this.container, this.key(id));
  }

  async delete(id: string): Promise<void> {
    await this.client.delete(this.container, this.key(id));
  }

  async exists(id: string): Promise<boolean> {
    return this.client.exists(this.container, this.key(id));
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    if (opts.expiresIn <= 0) throw new Error("Azure URL expiry must be positive");
    const signed = await this.client.presign({ container: this.container, name: this.key(id), operation: opts.operation ?? "download", expiresIn: opts.expiresIn, ...(opts.contentType ? { contentType: opts.contentType } : {}) });
    if (!this.cdnBaseUrl || (opts.operation ?? "download") !== "download") return signed;
    const target = new URL(signed);
    const cdn = new URL(this.cdnBaseUrl);
    return `${cdn.origin}${target.pathname}${target.search}`;
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    const scoped = opts.tenantId ? `${opts.tenantId}/${prefix}` : prefix;
    const records = await this.client.list({ container: this.container, prefix: this.key(scoped), limit: Math.min(Math.max(opts.limit ?? 100, 1), 5000), ...(opts.cursor ? { cursor: opts.cursor } : {}), hierarchical: this.hierarchical });
    return records.map((record) => ({ id: this.unkey(record.name), name: this.unkey(record.name).split("/").pop() ?? record.name, size: record.size, mimeType: record.contentType ?? "application/octet-stream", checksum: record.etag, backend: "azure", createdAt: record.createdAt ?? new Date(0).toISOString(), metadata: record.metadata ?? {} }));
  }

  async healthCheck() {
    return healthResult(this.name, "azure", () => this.client.probe(this.container));
  }

  private key(id: string): string {
    if (!id || id.includes("\0") || id.startsWith("/") || id.split("/").includes("..")) throw new Error("Invalid object identifier");
    return this.prefix ? `${this.prefix}/${id}` : id;
  }

  private unkey(name: string): string {
    return this.prefix && name.startsWith(`${this.prefix}/`) ? name.slice(this.prefix.length + 1) : name;
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}
