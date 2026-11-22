import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { bufferFromStream } from "../storage/utils";
import type { EngineScanResult, ScanEngine } from "./types";
import { errorMessage, positiveInteger, readResponseText, safeDetail } from "./utils";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface ClamAvOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  maxResponseBytes?: number;
}

interface ClamAvResponse {
  text: string;
  signatureVersion?: string;
}

export class ClamAvScanner implements ScanEngine {
  readonly name = "clamav";
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxResponseBytes: number;
  constructor(private readonly options: ClamAvOptions) {
    this.fetcher = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "ClamAV timeout");
    this.maxBytes = positiveInteger(
      options.maxBytes ?? 128 * 1024 * 1024,
      "ClamAV input size",
      1024 * 1024 * 1024,
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 64 * 1024,
      "ClamAV response size",
      1024 * 1024,
    );
  }

  async version(): Promise<string> {
    const response = await this.request("/version", { method: "GET" });
    const version = response.text.trim();
    if (!version) throw new Error("Empty ClamAV version response");
    return version;
  }

  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    void meta;
    const started = performance.now();
    const body = await bufferFromStream(stream, this.maxBytes);
    const response = await this.request("/scan", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(body),
    });
    const text = response.text.trim();
    const found = /^(?:stream:\s*)?.+\s+FOUND$/i.exec(text);
    const clean = /^(?:stream:\s*)?(?:OK|CLEAN|no threats)$/i.test(text);
    if (/^(?:stream:\s*)?.+\s+ERROR$/i.test(text)) throw new Error(`ClamAV error: ${safeDetail(text)}`);
    if (!found && !clean) throw new Error(`Unrecognised ClamAV response: ${safeDetail(text)}`);
    return {
      engine: this.name,
      verdict: found ? "malicious" : "clean",
      details: found ? [safeDetail(text)] : [],
      signatureVersion: response.signatureVersion,
      durationMs: performance.now() - started,
    };
  }

  private async request(requestPath: string, init: RequestInit): Promise<ClamAvResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`ClamAV request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.performRequest(requestPath, init, controller.signal), timeout]);
    } catch (error) {
      if (timedOut) throw new Error(`ClamAV request timed out after ${this.timeoutMs}ms`);
      throw new Error(`ClamAV request failed: ${safeDetail(errorMessage(error))}`);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private async performRequest(
    requestPath: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<ClamAvResponse> {
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}${requestPath}`, {
      ...init,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`ClamAV HTTP ${response.status}`);
    }
    const text = await readResponseText(response, this.maxResponseBytes);
    return { text, signatureVersion: response.headers.get("X-ClamAV-Signature-Version") ?? undefined };
  }
}
