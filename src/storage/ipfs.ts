import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import {
  createIpfsMappingRoot,
  deleteIpfsMapping,
  ensureIpfsMappingRoot,
  listIpfsMappings,
  readIpfsMapping,
  withIpfsMappingLock,
  writeIpfsMapping,
} from "./ipfs-mapping";
import type {
  BackendConfig,
  FileMeta,
  ListOpts,
  PresignOpts,
  StorageBackend,
  StorageListPage,
  UploadResult,
} from "./types";
import { readNumberOption, readStringOption } from "./types";
import { healthResult } from "./utils";

export interface IpfsPin {
  cid: string;
  name: string;
  size: number;
  createdAt: string;
  requestid?: string;
  metadata?: Record<string, string>;
}
export interface IpfsPinPage {
  pins: IpfsPin[];
  nextCursor?: string;
}
export interface IpfsClientAdapter {
  add(input: {
    content: Readable;
    name: string;
    pin: boolean;
    metadata?: Record<string, string>;
  }): Promise<{ cid: string; size: number }>;
  cat(cid: string): Promise<Readable>;
  unpin(cid: string): Promise<void>;
  stat(cid: string): Promise<boolean>;
  pins(input: { prefix: string; limit: number; cursor?: string }): Promise<IpfsPin[]>;
  pinsPage?(input: { prefix: string; limit: number; cursor?: string }): Promise<IpfsPinPage>;
  gatewayUrl(cid: string): string;
  version(): Promise<void>;
}

export class IpfsStorageBackend implements StorageBackend {
  private gateway = "";
  private signingProxyUrl = "";
  private legacyGatewaySigning = false;
  private signingSecret = "ipfs-development-secret";
  private name = "ipfs";
  private maxFileSize = Number.MAX_SAFE_INTEGER;
  private mappingRoot = "";
  private readonly locations = new Map<string, string>();

  constructor(private readonly client: IpfsClientAdapter) {}

  async init(config: BackendConfig): Promise<void> {
    this.name = config.name;
    this.gateway = readStringOption(config, "gateway", this.client.gatewayUrl("")).replace(/\/+$/, "");
    this.signingProxyUrl = readStringOption(config, "signingProxyUrl");
    this.legacyGatewaySigning = config.options.gatewayEnforcesSignatures === true;
    this.signingSecret = readStringOption(config, "signingSecret", this.signingSecret);
    this.maxFileSize = config.maxFileSize ?? readNumberOption(config, "maxFileSize", Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(this.maxFileSize) || this.maxFileSize < 0)
      throw new Error("Invalid IPFS file size limit");
    this.mappingRoot = createIpfsMappingRoot(readStringOption(config, "mappingRoot"), config.name);
    await ensureIpfsMappingRoot(this.mappingRoot);
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    assertObjectId(meta.id);
    return withIpfsMappingLock(this.mappingRoot, meta.id, async () => {
      const previous = await readIpfsMapping(this.mappingRoot, meta.id);
      const previousCid = previous?.cid ?? this.locations.get(meta.id);
      const hash = createHash("sha256");
      const maxFileSize = this.maxFileSize;
      let size = 0;
      const source = stream as AsyncIterable<unknown>;
      const content = Readable.from(
        (async function* () {
          for await (const value of source) {
            const chunk = byteChunk(value);
            hash.update(chunk);
            size += chunk.length;
            if (!Number.isSafeInteger(size) || size > maxFileSize)
              throw new Error("Stream exceeds configured size limit");
            yield chunk;
          }
        })(),
      );
      let added: { cid: string; size: number };
      try {
        added = await this.client.add({
          content,
          name: meta.id,
          pin: true,
          metadata: {
            ...meta.metadata,
            mimeType: meta.mimeType,
            ...(meta.tenantId ? { tenantId: meta.tenantId } : {}),
          },
        });
      } catch (error) {
        content.destroy();
        stream.destroy();
        throw error;
      }
      const checksum = hash.digest("hex");
      if (meta.checksum && !equalSha256(meta.checksum, checksum)) {
        if (previousCid !== added.cid) await this.client.unpin(added.cid).catch(() => undefined);
        throw new Error("Object checksum mismatch");
      }
      const storedMeta: FileMeta = { ...meta, size, checksum, backend: "ipfs", versionId: added.cid };
      try {
        await writeIpfsMapping(this.mappingRoot, {
          id: meta.id,
          cid: added.cid,
          meta: storedMeta,
          checksum,
          size,
        });
      } catch (error) {
        if (previousCid !== added.cid) await this.client.unpin(added.cid).catch(() => undefined);
        throw error;
      }
      this.locations.set(meta.id, added.cid);
      return { id: meta.id, backend: "ipfs", size, checksum, location: added.cid, versionId: added.cid };
    });
  }

  async download(id: string): Promise<Readable> {
    return this.client.cat(await this.cid(id));
  }

  async delete(id: string): Promise<void> {
    await withIpfsMappingLock(this.mappingRoot, id, async () => {
      const cid = await this.cid(id);
      await this.client.unpin(cid);
      await deleteIpfsMapping(this.mappingRoot, id);
      this.locations.delete(id);
    });
  }

  async exists(id: string): Promise<boolean> {
    return this.client.stat(await this.cid(id));
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    const operation = opts.operation ?? "download";
    if (operation !== "download") throw new Error("IPFS signed URLs only support downloads");
    const expires = expiryTimestamp(opts.expiresIn);
    const cid = await this.cid(id);
    const base = this.signingProxyUrl
      ? signingProxyUrl(this.signingProxyUrl, cid)
      : this.gateway
        ? `${this.gateway}/${cid}`
        : this.client.gatewayUrl(cid);
    assertSigningUrl(base);
    if (
      !this.signingProxyUrl &&
      !this.legacyGatewaySigning &&
      (isPublicGateway(base) || !isDevelopmentGateway(base))
    )
      throw new Error(
        "IPFS gateways cannot enforce signed URLs unless explicitly trusted; configure signingProxyUrl",
      );
    const signature = createHmac("sha256", this.signingSecret)
      .update(`${cid}:${expires}`)
      .digest("base64url");
    const query = new URLSearchParams({ expires: String(expires), signature });
    return `${base}${base.includes("?") ? "&" : "?"}${query.toString()}`;
  }

  async verifyPresignedUrl(id: string, expires: number, signature: string): Promise<boolean>;
  async verifyPresignedUrl(
    id: string,
    expires: number,
    operation: string,
    signature: string,
  ): Promise<boolean>;
  async verifyPresignedUrl(
    id: string,
    expires: number,
    operationOrSignature: string,
    possibleSignature?: string,
  ): Promise<boolean> {
    if (possibleSignature !== undefined && operationOrSignature !== "download") return false;
    if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const cid = await this.cid(id).catch(() => undefined);
    if (!cid) return false;
    const signature = possibleSignature ?? operationOrSignature;
    const expected = createHmac("sha256", this.signingSecret).update(`${cid}:${expires}`).digest("base64url");
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    return (await this.listPage(prefix, opts)).files;
  }

  async listPage(prefix: string, opts: ListOpts): Promise<StorageListPage> {
    const scopedPrefix = opts.tenantId ? `${opts.tenantId}/${prefix}` : prefix;
    const [stored, pins] = await Promise.all([
      listIpfsMappings(this.mappingRoot),
      this.allPins(scopedPrefix),
    ]);
    const records = new Map<string, FileMeta>();
    for (const pin of pins) {
      const persisted = await withIpfsMappingLock(this.mappingRoot, pin.name, async () => {
        const existing = await readIpfsMapping(this.mappingRoot, pin.name);
        if (existing) return existing;
        const meta = pinFileMeta(pin, opts.tenantId);
        const record = { id: pin.name, cid: pin.cid, meta, checksum: meta.checksum ?? "", size: meta.size };
        await writeIpfsMapping(this.mappingRoot, record);
        return record;
      });
      this.locations.set(pin.name, persisted.cid);
      if (matches(persisted.meta, scopedPrefix, opts.tenantId)) records.set(persisted.id, persisted.meta);
    }
    for (const mapping of stored) {
      this.locations.set(mapping.id, mapping.cid);
      if (matches(mapping.meta, scopedPrefix, opts.tenantId)) records.set(mapping.id, mapping.meta);
    }
    const limit = listLimit(opts.limit);
    const offset = listOffset(opts.cursor);
    const all = [...records.values()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    );
    const files = all.slice(offset, offset + limit);
    return { files, ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}) };
  }

  async healthCheck() {
    return healthResult(this.name, "ipfs", () => this.client.version());
  }

  private async allPins(prefix: string): Promise<IpfsPin[]> {
    if (!this.client.pinsPage) {
      const pins = await this.client.pins({ prefix, limit: 1000 });
      if (pins.length === 1000) throw new Error("IPFS adapter cannot guarantee complete pagination");
      return pins;
    }
    const listPage = this.client.pinsPage.bind(this.client);
    const pins: IpfsPin[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const page = await listPage({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      pins.push(...page.pins);
      if (!page.nextCursor) return pins;
      if (cursors.has(page.nextCursor)) throw new Error("IPFS pin cursor did not advance");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private async cid(id: string): Promise<string> {
    const stored = await readIpfsMapping(this.mappingRoot, id);
    if (stored) {
      if (stored.meta.expiresAt && new Date(stored.meta.expiresAt).getTime() <= Date.now())
        throw new Error("Object has expired");
      this.locations.set(id, stored.cid);
      return stored.cid;
    }
    const cid = this.locations.get(id) ?? (looksLikeCid(id) ? id : undefined);
    if (!cid) throw new Error("IPFS content identifier is unknown; list or upload the object first");
    return cid;
  }
}

function byteChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("IPFS upload stream must yield bytes");
}

function looksLikeCid(id: string): boolean {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(id) || /^b[a-z2-7]{20,}$/.test(id);
}

function assertObjectId(id: string): void {
  if (
    !id ||
    id.includes("\0") ||
    id.includes("\\") ||
    id.startsWith("/") ||
    id.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("Invalid object identifier");
}

function equalSha256(left: string, right: string): boolean {
  return (
    /^[a-f0-9]{64}$/i.test(left) &&
    /^[a-f0-9]{64}$/i.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function assertSigningUrl(value: string): void {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash)
    throw new Error("Invalid IPFS signing URL");
}

function expiryTimestamp(expiresIn: number): number {
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0)
    throw new Error("IPFS URL expiry must be a positive safe integer");
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  if (!Number.isSafeInteger(expires)) throw new Error("IPFS URL expiry exceeds the safe integer range");
  return expires;
}

function signingProxyUrl(template: string, cid: string): string {
  if (template.includes("{cid}")) return template.replaceAll("{cid}", encodeURIComponent(cid));
  try {
    const url = new URL(template);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(cid)}`;
    return url.toString();
  } catch {
    throw new Error("Invalid IPFS signing proxy URL");
  }
}

function isPublicGateway(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return ["ipfs.io", "dweb.link", "cloudflare-ipfs.com", "gateway.pinata.cloud"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function isDevelopmentGateway(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".test")
  );
}

function pinFileMeta(pin: IpfsPin, tenantId?: string): FileMeta {
  return {
    id: pin.name,
    name: pin.name.split("/").pop() ?? pin.name,
    size: pin.size,
    mimeType: pin.metadata?.mimeType ?? "application/octet-stream",
    backend: "ipfs",
    versionId: pin.cid,
    createdAt: pin.createdAt,
    metadata: pin.metadata ?? {},
    ...(pin.metadata?.tenantId || (tenantId && pin.name.startsWith(`${tenantId}/`))
      ? { tenantId: pin.metadata?.tenantId ?? tenantId }
      : {}),
    ...(pin.metadata?.checksum ? { checksum: pin.metadata.checksum } : {}),
  };
}

function matches(meta: FileMeta, scopedPrefix: string, tenantId?: string): boolean {
  const tenantMatches =
    !tenantId ||
    meta.tenantId === tenantId ||
    (meta.tenantId === undefined && meta.id.startsWith(`${tenantId}/`));
  return (
    tenantMatches &&
    meta.id.startsWith(scopedPrefix) &&
    (!meta.expiresAt || new Date(meta.expiresAt).getTime() > Date.now())
  );
}

function listLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid list limit");
  return Math.min(limit, 1000);
}

function listOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error("Invalid list cursor");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid list cursor");
  return offset;
}
