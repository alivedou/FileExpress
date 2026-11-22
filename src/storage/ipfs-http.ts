import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { IpfsClientAdapter, IpfsPin, IpfsPinPage } from "./ipfs";

export interface IpfsHttpAdapterOptions {
  apiUrl: string;
  gateway?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  pinningServiceUrl?: string;
  pinningServiceToken?: string;
}

type IpfsRequestInit = RequestInit & { duplex?: "half" };

export class IpfsHttpAdapter implements IpfsClientAdapter {
  constructor(private readonly options: IpfsHttpAdapterOptions) {}

  async add(input: {
    content: Readable;
    name: string;
    pin: boolean;
    metadata?: Record<string, string>;
  }): Promise<{ cid: string; size: number }> {
    const boundary = `fileexpress-${randomUUID()}`;
    let streamedSize = 0;
    const body = Readable.from(
      multipartContent(input.content, input.name, boundary, (size) => {
        streamedSize += size;
      }),
    );
    const response = await this.request(`/api/v0/add?pin=${input.pin && !this.options.pinningServiceUrl}`, {
      method: "POST",
      body: body as unknown as BodyInit,
      duplex: "half",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    });
    const result = parseAddResponse(await response.text());
    if (this.options.pinningServiceUrl)
      await this.createServicePin(result.cid, input.name, { ...input.metadata, size: String(streamedSize) });
    return { cid: result.cid, size: result.size ?? streamedSize };
  }

  async cat(cid: string): Promise<Readable> {
    const response = await this.request(`/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: "POST" });
    if (!response.body) throw new Error("IPFS response has no body");
    return Readable.fromWeb(response.body as NodeReadableStream);
  }

  async unpin(cid: string): Promise<void> {
    if (!this.options.pinningServiceUrl) {
      await this.request(`/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, { method: "POST" });
      return;
    }
    const response = await this.serviceRequest(
      `/pins?cid=${encodeURIComponent(cid)}&status=pinned&limit=1000`,
      { method: "GET" },
    );
    const pins = parseServicePins(await response.text());
    await Promise.all(
      pins
        .filter((pin) => pin.cid === cid && pin.requestid)
        .map((pin) =>
          this.serviceRequest(`/pins/${encodeURIComponent(pin.requestid ?? "")}`, { method: "DELETE" }),
        ),
    );
  }

  async stat(cid: string): Promise<boolean> {
    try {
      await this.request(`/api/v0/object/stat?arg=${encodeURIComponent(cid)}`, { method: "POST" });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("500")) return false;
      throw error;
    }
  }

  async pins(input: { prefix: string; limit: number; cursor?: string }): Promise<IpfsPin[]> {
    return (await this.pinsPage(input)).pins.slice(0, input.limit);
  }

  async pinsPage(input: { prefix: string; limit: number; cursor?: string }): Promise<IpfsPinPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1000)
      throw new Error("Invalid IPFS pin list limit");
    if (this.options.pinningServiceUrl) {
      const query = new URLSearchParams({ status: "pinned", limit: String(input.limit) });
      if (input.cursor) query.set("before", input.cursor);
      const response = await this.serviceRequest(`/pins?${query.toString()}`, { method: "GET" });
      const result = parseServicePins(await response.text());
      const last = result.at(-1);
      const nextCursor = result.length === input.limit && last ? last.createdAt : undefined;
      return {
        pins: result.filter((pin) => pin.name.startsWith(input.prefix)),
        ...(nextCursor ? { nextCursor } : {}),
      };
    }
    const response = await this.request(`/api/v0/pin/ls?type=recursive&names=true`, { method: "POST" });
    const body = parseJson(await response.text(), "IPFS pin list returned invalid JSON");
    const root = asRecord(body);
    const keys = asRecord(root?.Keys);
    if (!keys) return { pins: [] };
    const pins = Object.entries(keys).flatMap(([cid, value]) => {
      const record = asRecord(value);
      const name = typeof record?.Name === "string" ? record.Name : cid;
      return name.startsWith(input.prefix)
        ? [{ cid, name, size: 0, createdAt: new Date(0).toISOString() }]
        : [];
    });
    return { pins };
  }

  gatewayUrl(cid: string): string {
    return `${this.options.gateway ?? "https://ipfs.io/ipfs"}/${cid}`;
  }

  async version(): Promise<void> {
    await this.request("/api/v0/version", { method: "POST" });
  }

  private async createServicePin(cid: string, name: string, metadata: Record<string, string>): Promise<void> {
    await this.serviceRequest("/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid, name, meta: metadata }),
    });
  }

  private async request(path: string, init: IpfsRequestInit): Promise<Response> {
    return this.performRequest(this.options.apiUrl, path, init, this.options.token);
  }

  private async serviceRequest(path: string, init: IpfsRequestInit): Promise<Response> {
    const base = this.options.pinningServiceUrl;
    if (!base) throw new Error("IPFS pinning service is not configured");
    return this.performRequest(base, path, init, this.options.pinningServiceToken);
  }

  private async performRequest(
    base: string,
    path: string,
    init: IpfsRequestInit,
    token: string | undefined,
  ): Promise<Response> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      response = await (this.options.fetchImpl ?? fetch)(`${base.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new Error("IPFS HTTP request failed");
    }
    if (!response.ok) throw new Error(`IPFS HTTP ${response.status}`);
    return response;
  }
}

async function* multipartContent(
  content: Readable,
  name: string,
  boundary: string,
  onBytes: (size: number) => void,
): AsyncGenerator<Buffer> {
  const filename = name
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "_")
    .replaceAll("\n", "_");
  yield Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const source = content as AsyncIterable<unknown>;
  for await (const value of source) {
    const chunk = byteChunk(value);
    onBytes(chunk.length);
    yield chunk;
  }
  yield Buffer.from(`\r\n--${boundary}--\r\n`);
}

function parseAddResponse(text: string): { cid: string; size?: number } {
  let cid = "";
  let size: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = asRecord(parseJson(line, "IPFS add returned invalid NDJSON"));
    if (typeof record?.Hash === "string") cid = record.Hash;
    const parsedSize = parseSize(record?.Size);
    if (parsedSize !== undefined) size = parsedSize;
  }
  if (!cid) throw new Error("IPFS add did not return a CID");
  return { cid, ...(size !== undefined ? { size } : {}) };
}

function parseServicePins(text: string): IpfsPin[] {
  const root = asRecord(parseJson(text, "IPFS pinning service returned invalid JSON"));
  if (!Array.isArray(root?.results)) throw new Error("IPFS pinning service returned an invalid pin list");
  return root.results.flatMap((value) => {
    const record = asRecord(value);
    if (!record || typeof record.cid !== "string") return [];
    const metadata = stringRecord(record.meta);
    const name = typeof record.name === "string" ? record.name : record.cid;
    const createdAt = typeof record.created === "string" ? record.created : new Date(0).toISOString();
    const requestid = typeof record.requestid === "string" ? record.requestid : undefined;
    return [
      {
        cid: record.cid,
        name,
        size: parseSize(metadata?.size) ?? 0,
        createdAt,
        ...(requestid ? { requestid } : {}),
        ...(metadata ? { metadata } : {}),
      },
    ];
  });
}

function parseJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(message);
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") return undefined;
    result[key] = entry;
  }
  return result;
}

function parseSize(value: unknown): number | undefined {
  const size = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function byteChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("IPFS upload stream must yield bytes");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
