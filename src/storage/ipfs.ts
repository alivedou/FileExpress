import { createHash, createHmac } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { BackendConfig, FileMeta, ListOpts, PresignOpts, StorageBackend, UploadResult } from "./types";
import { readStringOption } from "./types";
import { healthResult } from "./utils";

export interface IpfsPin { cid: string; name: string; size: number; createdAt: string; metadata?: Record<string, string> }
export interface IpfsClientAdapter {
  add(input: { content: Readable; name: string; pin: boolean }): Promise<{ cid: string; size: number }>;
  cat(cid: string): Promise<Readable>;
  unpin(cid: string): Promise<void>;
  stat(cid: string): Promise<boolean>;
  pins(input: { prefix: string; limit: number; cursor?: string }): Promise<IpfsPin[]>;
  gatewayUrl(cid: string): string;
  version(): Promise<void>;
}

export class IpfsStorageBackend implements StorageBackend {
  private gateway = "";
  private signingSecret = "ipfs-development-secret";
  private name = "ipfs";
  private readonly locations = new Map<string, string>();

  constructor(private readonly client: IpfsClientAdapter) {}

  async init(config: BackendConfig): Promise<void> {
    this.name = config.name;
    this.gateway = readStringOption(config, "gateway", this.client.gatewayUrl("")).replace(/\/$/, "");
    this.signingSecret = readStringOption(config, "signingSecret", this.signingSecret);
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
    stream.pipe(meter);
    const added = await this.client.add({ content: meter, name: meta.id, pin: true });
    this.locations.set(meta.id, added.cid);
    return { id: meta.id, backend: "ipfs", size, checksum: hash.digest("hex"), location: added.cid, versionId: added.cid };
  }

  async download(id: string): Promise<Readable> {
    return this.client.cat(this.cid(id));
  }

  async delete(id: string): Promise<void> {
    const cid = this.cid(id);
    await this.client.unpin(cid);
    this.locations.delete(id);
  }

  async exists(id: string): Promise<boolean> {
    return this.client.stat(this.cid(id));
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    const cid = this.cid(id);
    const expires = Math.floor(Date.now() / 1000) + opts.expiresIn;
    const signature = createHmac("sha256", this.signingSecret).update(`${cid}:${expires}`).digest("base64url");
    const base = this.gateway ? `${this.gateway}/${cid}` : this.client.gatewayUrl(cid);
    return `${base}?${new URLSearchParams({ expires: String(expires), signature })}`;
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    const pins = await this.client.pins({ prefix: opts.tenantId ? `${opts.tenantId}/${prefix}` : prefix, limit: Math.min(Math.max(opts.limit ?? 100, 1), 1000), ...(opts.cursor ? { cursor: opts.cursor } : {}) });
    return pins.map((pin) => { this.locations.set(pin.name, pin.cid); return { id: pin.name, name: pin.name.split("/").pop() ?? pin.name, size: pin.size, mimeType: pin.metadata?.mimeType ?? "application/octet-stream", backend: "ipfs", versionId: pin.cid, createdAt: pin.createdAt, metadata: pin.metadata ?? {} }; });
  }

  async healthCheck() {
    return healthResult(this.name, "ipfs", () => this.client.version());
  }

  private cid(id: string): string {
    const cid = this.locations.get(id) ?? (/^[a-z0-9]+$/i.test(id) && id.length > 20 ? id : undefined);
    if (!cid) throw new Error("IPFS content identifier is unknown; list or upload the object first");
    return cid;
  }
}
