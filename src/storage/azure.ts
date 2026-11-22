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
import { bufferFromStream, chunksFromStream, healthResult } from "./utils";

export interface AzureBlobRecord {
  name: string;
  size: number;
  contentType?: string;
  etag?: string;
  createdAt?: string;
  metadata?: Record<string, string>;
  kind?: "blob" | "prefix";
}

export interface AzureListPage {
  records: AzureBlobRecord[];
  nextCursor?: string;
}

export interface AzureClientAdapter {
  upload(input: {
    container: string;
    name: string;
    body: Buffer;
    contentType: string;
    metadata: Record<string, string>;
    immutableUntil?: string;
    immutabilityPolicyMode?: "Locked" | "Unlocked";
  }): Promise<{ versionId?: string }>;
  download(container: string, name: string): Promise<Readable>;
  delete(container: string, name: string): Promise<void>;
  exists(container: string, name: string): Promise<boolean>;
  list(input: {
    container: string;
    prefix: string;
    limit: number;
    cursor?: string;
    hierarchical?: boolean;
  }): Promise<AzureBlobRecord[]>;
  listPage?(input: {
    container: string;
    prefix: string;
    limit: number;
    cursor?: string;
    hierarchical?: boolean;
  }): Promise<AzureListPage>;
  presign(input: {
    container: string;
    name: string;
    operation: "download" | "upload";
    expiresIn: number;
    contentType?: string;
  }): Promise<string>;
  probe(container: string): Promise<void>;
  stageBlock?(input: { container: string; name: string; blockId: string; body: Buffer }): Promise<void>;
  commitBlocks?(input: {
    container: string;
    name: string;
    blockIds: string[];
    contentType: string;
    metadata: Record<string, string>;
    immutableUntil?: string;
    immutabilityPolicyMode?: "Locked" | "Unlocked";
  }): Promise<{ versionId?: string }>;
}

export class AzureBlobStorageBackend implements StorageBackend {
  private container = "";
  private prefix = "";
  private blockSize = 8 * 1024 * 1024;
  private threshold = 32 * 1024 * 1024;
  private maxBufferedBytes = 64 * 1024 * 1024;
  private maxFileSize = Number.MAX_SAFE_INTEGER;
  private name = "azure";
  private immutableUntil: string | undefined;
  private immutabilityPolicyMode: "Locked" | "Unlocked" = "Unlocked";
  private cdnBaseUrl = "";
  private hierarchical = false;

  constructor(private readonly client: AzureClientAdapter) {}

  async init(config: BackendConfig): Promise<void> {
    this.name = config.name;
    this.container = required(config.options.container, "Azure container");
    this.prefix = readStringOption(config, "prefix").replace(/^\/+|\/+$/g, "");
    assertObjectId(this.prefix || "root");
    this.blockSize = readNumberOption(config, "blockSize", this.blockSize);
    this.threshold = readNumberOption(config, "multipartThreshold", this.threshold);
    this.maxBufferedBytes = readNumberOption(config, "maxBufferedBytes", this.maxBufferedBytes);
    this.maxFileSize = config.maxFileSize ?? readNumberOption(config, "maxFileSize", Number.MAX_SAFE_INTEGER);
    this.immutableUntil = readStringOption(config, "immutableUntil") || undefined;
    const policyMode = readStringOption(config, "immutabilityPolicyMode", "Unlocked");
    if (policyMode !== "Locked" && policyMode !== "Unlocked")
      throw new Error("Invalid Azure immutability policy mode");
    this.immutabilityPolicyMode = policyMode;
    this.cdnBaseUrl = readStringOption(config, "cdnBaseUrl").replace(/\/$/, "");
    this.hierarchical = config.options.hierarchical === true;
    if (!Number.isSafeInteger(this.blockSize) || this.blockSize <= 0)
      throw new Error("Invalid Azure block size");
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 0)
      throw new Error("Invalid Azure multipart threshold");
    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 0)
      throw new Error("Invalid Azure buffer limit");
    if (!Number.isSafeInteger(this.maxFileSize) || this.maxFileSize < 0)
      throw new Error("Invalid Azure file size limit");
    if (this.immutableUntil && !Number.isFinite(new Date(this.immutableUntil).getTime()))
      throw new Error("Invalid Azure immutability expiry");
    if (this.cdnBaseUrl) validateCdnBaseUrl(this.cdnBaseUrl);
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const name = this.key(meta.id);
    return withStorageLock(`azure:${this.container}/${name}`, () => this.uploadLocked(stream, meta, name));
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
    if (!Number.isSafeInteger(opts.expiresIn) || opts.expiresIn <= 0 || opts.expiresIn > 604800)
      throw new Error("Azure URL expiry must be between 1 second and 7 days");
    const signed = await this.client.presign({
      container: this.container,
      name: this.key(id),
      operation: opts.operation ?? "download",
      expiresIn: opts.expiresIn,
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    });
    if (!this.cdnBaseUrl || (opts.operation ?? "download") !== "download") return signed;
    const target = new URL(signed);
    if (target.protocol !== "https:" && target.protocol !== "http:")
      throw new Error("Invalid Azure signed URL");
    const cdn = new URL(this.cdnBaseUrl);
    cdn.pathname = `${cdn.pathname.replace(/\/$/, "")}${target.pathname}`;
    cdn.search = target.search;
    return cdn.toString();
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    return (await this.listPage(prefix, opts)).files;
  }

  async listPage(prefix: string, opts: ListOpts): Promise<StorageListPage> {
    const page = await this.listEntryPage(prefix, opts);
    const files: FileMeta[] = page.records
      .filter((record) => record.kind !== "prefix")
      .map((record) => {
        const id = this.unkey(record.name);
        const metadata = record.metadata ?? {};
        return {
          id,
          name: id.split("/").pop() ?? record.name,
          size: record.size,
          mimeType: record.contentType ?? metadata.mimeType ?? "application/octet-stream",
          ...(metadata.sha256 || record.etag ? { checksum: metadata.sha256 ?? record.etag } : {}),
          backend: "azure",
          ...(metadata.tenantId || opts.tenantId ? { tenantId: metadata.tenantId ?? opts.tenantId } : {}),
          createdAt: record.createdAt ?? new Date(0).toISOString(),
          metadata,
        };
      });
    return { files, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async listEntries(prefix: string, opts: ListOpts): Promise<AzureBlobRecord[]> {
    return (await this.listEntryPage(prefix, opts)).records;
  }

  private async listEntryPage(prefix: string, opts: ListOpts): Promise<AzureListPage> {
    assertListPrefix(prefix);
    const scoped = opts.tenantId ? `${opts.tenantId}/${prefix}` : prefix;
    const input = {
      container: this.container,
      prefix: this.listKey(scoped),
      limit: boundedLimit(opts.limit),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      hierarchical: this.hierarchical,
    };
    const page = this.client.listPage
      ? await this.client.listPage(input)
      : { records: await this.client.list(input), nextCursor: undefined };
    if (!this.client.listPage && page.records.length === input.limit)
      throw new Error("Azure adapter cannot guarantee complete pagination");
    return {
      records: page.records.filter((record) => this.ownsName(record.name)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    return healthResult(this.name, "azure", () => this.client.probe(this.container));
  }

  private async uploadLocked(stream: Readable, meta: FileMeta, name: string): Promise<UploadResult> {
    if (!this.client.stageBlock || !this.client.commitBlocks) {
      const body = await bufferFromStream(stream, Math.min(this.maxBufferedBytes, this.maxFileSize));
      return this.putSmall(name, body, meta);
    }
    const iterator = chunksFromStream(stream, this.blockSize)[Symbol.asyncIterator]();
    const buffered: Buffer[] = [];
    let bufferedSize = 0;
    try {
      while (bufferedSize < this.threshold) {
        const next = await iterator.next();
        if (next.done) return await this.putSmall(name, Buffer.concat(buffered, bufferedSize), meta);
        buffered.push(next.value);
        bufferedSize += next.value.length;
        this.assertSize(bufferedSize);
      }
      if (this.threshold === 0 && buffered.length === 0) {
        const first = await iterator.next();
        if (first.done) return await this.putSmall(name, Buffer.alloc(0), meta);
        buffered.push(first.value);
        bufferedSize = first.value.length;
        this.assertSize(bufferedSize);
      }
      return await this.putBlocks(name, meta, buffered, iterator);
    } catch (error) {
      stream.destroy();
      await iterator.return?.(undefined).catch(() => undefined);
      throw error;
    }
  }

  private async putSmall(name: string, body: Buffer, meta: FileMeta): Promise<UploadResult> {
    const checksum = createHash("sha256").update(body).digest("hex");
    assertExpectedChecksum(meta.checksum, checksum);
    const result = await this.client.upload({ ...this.common(name, meta, checksum), body });
    return {
      id: meta.id,
      backend: "azure",
      size: body.length,
      checksum,
      ...(result.versionId ? { versionId: result.versionId } : {}),
    };
  }

  private async putBlocks(
    name: string,
    meta: FileMeta,
    initial: Buffer[],
    iterator: AsyncIterator<Buffer>,
  ): Promise<UploadResult> {
    if (!this.client.stageBlock || !this.client.commitBlocks)
      throw new Error("Azure block adapter is incomplete");
    const hash = createHash("sha256");
    const blockIds: string[] = [];
    let size = 0;
    const stage = async (body: Buffer): Promise<void> => {
      if (blockIds.length >= 50000) throw new Error("Azure block upload exceeds 50000 blocks");
      const blockId = createHash("sha256").update(`${name}\0${blockIds.length}`).digest("base64");
      size += body.length;
      this.assertSize(size);
      hash.update(body);
      await this.client.stageBlock?.({ container: this.container, name, blockId, body });
      blockIds.push(blockId);
    };
    for (const body of initial) await stage(body);
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      await stage(next.value);
    }
    const checksum = hash.digest("hex");
    assertExpectedChecksum(meta.checksum, checksum);
    const result = await this.client.commitBlocks({ ...this.common(name, meta, checksum), blockIds });
    return {
      id: meta.id,
      backend: "azure",
      size,
      checksum,
      ...(result.versionId ? { versionId: result.versionId } : {}),
    };
  }

  private common(
    name: string,
    meta: FileMeta,
    checksum?: string,
  ): {
    container: string;
    name: string;
    contentType: string;
    metadata: Record<string, string>;
    immutableUntil?: string;
    immutabilityPolicyMode: "Locked" | "Unlocked";
  } {
    return {
      container: this.container,
      name,
      contentType: meta.mimeType,
      metadata: {
        ...meta.metadata,
        mimeType: meta.mimeType,
        ...(meta.tenantId ? { tenantId: meta.tenantId } : {}),
        ...(checksum ? { sha256: checksum } : {}),
      },
      ...(this.immutableUntil ? { immutableUntil: this.immutableUntil } : {}),
      immutabilityPolicyMode: this.immutabilityPolicyMode,
    };
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

  private ownsName(name: string): boolean {
    return this.prefix ? name.startsWith(`${this.prefix}/`) : true;
  }

  private unkey(name: string): string {
    return this.prefix ? name.slice(this.prefix.length + 1) : name;
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
  return Math.min(limit, 5000);
}

function assertExpectedChecksum(expected: string | undefined, actual: string): void {
  if (!expected) return;
  if (
    !/^[a-f0-9]{64}$/i.test(expected) ||
    !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
  )
    throw new Error("Object checksum mismatch");
}

function validateCdnBaseUrl(value: string): void {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Azure CDN base URL");
}
