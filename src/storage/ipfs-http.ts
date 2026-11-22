import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { bufferFromStream } from "./utils";
import type { IpfsClientAdapter, IpfsPin } from "./ipfs";

export class IpfsHttpAdapter implements IpfsClientAdapter {
  constructor(private readonly options: { apiUrl: string; gateway?: string; token?: string; fetchImpl?: typeof fetch }) {}
  async add(input: { content: Readable; name: string; pin: boolean }): Promise<{ cid: string; size: number }> {
    const content = await bufferFromStream(input.content);
    const form = new FormData(); form.append("file", new Blob([new Uint8Array(content)]), input.name);
    const response = await this.request(`/api/v0/add?pin=${input.pin}`, { method: "POST", body: form });
    const result = await response.json() as { Hash?: string; Size?: string };
    if (!result.Hash) throw new Error("IPFS add did not return a CID");
    return { cid: result.Hash, size: Number(result.Size ?? content.length) };
  }
  async cat(cid: string): Promise<Readable> { const response = await this.request(`/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: "POST" }); if (!response.body) throw new Error("IPFS response has no body"); return Readable.fromWeb(response.body as NodeReadableStream); }
  async unpin(cid: string): Promise<void> { await this.request(`/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, { method: "POST" }); }
  async stat(cid: string): Promise<boolean> { try { await this.request(`/api/v0/object/stat?arg=${encodeURIComponent(cid)}`, { method: "POST" }); return true; } catch (error) { if (error instanceof Error && error.message.includes("500")) return false; throw error; } }
  async pins(input: { prefix: string; limit: number }): Promise<IpfsPin[]> { const response = await this.request(`/api/v0/pin/ls?type=recursive&names=true`, { method: "POST" }); const body = await response.json() as { Keys?: Record<string, { Name?: string }> }; return Object.entries(body.Keys ?? {}).filter(([, value]) => (value.Name ?? "").startsWith(input.prefix)).slice(0, input.limit).map(([cid, value]) => ({ cid, name: value.Name ?? cid, size: 0, createdAt: new Date(0).toISOString() })); }
  gatewayUrl(cid: string): string { return `${this.options.gateway ?? "https://ipfs.io/ipfs"}/${cid}`; }
  async version(): Promise<void> { await this.request("/api/v0/version", { method: "POST" }); }
  private async request(path: string, init: RequestInit): Promise<Response> { const response = await (this.options.fetchImpl ?? fetch)(`${this.options.apiUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}), ...init.headers } }); if (!response.ok) throw new Error(`IPFS HTTP ${response.status}: ${await response.text()}`); return response; }
}
