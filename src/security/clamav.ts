import { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { bufferFromStream } from "../storage/utils";
import type { EngineScanResult, ScanEngine } from "./types";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface ClamAvOptions { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number; maxBytes?: number }

export class ClamAvScanner implements ScanEngine {
  readonly name = "clamav";
  private readonly fetcher: FetchLike;
  constructor(private readonly options: ClamAvOptions) { this.fetcher = options.fetchImpl ?? fetch; }

  async version(): Promise<string> {
    const response = await this.request("/version", { method: "GET" });
    return (await response.text()).trim();
  }

  async scan(stream: Readable, _meta: FileMeta): Promise<EngineScanResult> {
    const started = performance.now();
    const body = await bufferFromStream(stream, this.options.maxBytes ?? 128 * 1024 * 1024);
    const response = await this.request("/scan", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
    const text = (await response.text()).trim();
    const infected = /FOUND/i.test(text) && !/OK|CLEAN/i.test(text);
    const clean = /OK|CLEAN|no threats/i.test(text);
    if (!infected && !clean) throw new Error(`Unrecognised ClamAV response: ${text}`);
    return { engine: this.name, verdict: infected ? "malicious" : "clean", details: infected ? [text] : [], signatureVersion: response.headers.get("X-ClamAV-Signature-Version") ?? undefined, durationMs: performance.now() - started };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`ClamAV HTTP ${response.status}`);
      return response;
    } finally { clearTimeout(timer); }
  }
}
