import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { bufferFromStream } from "../storage/utils";
import type { EngineScanResult, ScanEngine, ScanVerdict } from "./types";
import type { FetchLike } from "./clamav";
import { positiveInteger, readResponseText, safeDetail } from "./utils";

interface VirusTotalStats {
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
}
interface VirusTotalAttributes {
  last_analysis_stats?: VirusTotalStats;
  status?: string;
}
interface ProducedResult {
  result: EngineScanResult;
  analysisId?: string;
}
interface CacheEntry {
  result: EngineScanResult;
  expiresAt: number;
  analysisId?: string;
}
interface JsonResponse {
  status: number;
  value?: unknown;
}
export interface VirusTotalPollingOptions {
  enabled?: boolean;
  intervalMs?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}
export interface VirusTotalOptions {
  apiKey: string;
  baseUrl?: string;
  cacheTtlMs?: number;
  maxBytes?: number;
  maxCacheEntries?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  pollAnalyses?: boolean;
  poll?: boolean;
  polling?: VirusTotalPollingOptions;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  pollTimeoutMs?: number;
  callbackSecret?: string;
}

class VirusTotalError extends Error {}

export class VirusTotalScanner implements ScanEngine {
  readonly name = "virustotal";
  private readonly cache = new Map<string, CacheEntry>();
  private readonly analysisHashes = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<ProducedResult>>();
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxCacheEntries: number;
  private readonly cacheTtlMs: number;
  private readonly maxBytes: number;
  constructor(private readonly options: VirusTotalOptions) {
    if (!options.apiKey) throw new Error("VirusTotal API key is required");
    this.fetcher = options.fetchImpl ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "VirusTotal timeout");
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 1024 * 1024,
      "VirusTotal response size",
      4 * 1024 * 1024,
    );
    this.maxCacheEntries = positiveInteger(options.maxCacheEntries ?? 1024, "VirusTotal cache size", 100_000);
    this.cacheTtlMs = positiveInteger(options.cacheTtlMs ?? 3600_000, "VirusTotal cache TTL");
    this.maxBytes = positiveInteger(
      options.maxBytes ?? 32 * 1024 * 1024,
      "VirusTotal input size",
      1024 * 1024 * 1024,
    );
  }
  async version(): Promise<string> {
    return "multi-engine-cloud";
  }

  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    const body = await bufferFromStream(stream, this.maxBytes);
    const hash = createHash("sha256").update(body).digest("hex");
    const cached = this.cached(hash);
    if (cached) return cached;
    const existing = this.inflight.get(hash);
    if (existing) return cloneResult((await existing).result);
    const operation = this.produce(body, meta);
    this.inflight.set(hash, operation);
    try {
      const produced = await operation;
      this.store(hash, produced);
      return cloneResult(produced.result);
    } finally {
      if (this.inflight.get(hash) === operation) this.inflight.delete(hash);
    }
  }

  verifyCallback(
    payload: string,
    timestamp: string,
    signature: string,
    secret: string,
    toleranceSeconds = 300,
  ): boolean {
    if (!/^\d{1,12}$/.test(timestamp) || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0)
      return false;
    const time = Number(timestamp);
    if (!Number.isSafeInteger(time)) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - time);
    if (age > toleranceSeconds) return false;
    const normalized = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    if (!/^[a-fA-F0-9]{64}$/.test(normalized) || !secret) return false;
    const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(normalized.toLowerCase(), "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }

  handleCallback(
    payload: string,
    timestamp: string,
    signature: string,
    secret = this.options.callbackSecret,
    toleranceSeconds = 300,
  ): EngineScanResult {
    if (
      !secret ||
      Buffer.byteLength(payload) > this.maxResponseBytes ||
      !this.verifyCallback(payload, timestamp, signature, secret, toleranceSeconds)
    )
      throw new Error("Invalid VirusTotal callback");
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      throw new Error("Invalid VirusTotal callback payload");
    }
    return this.storeCallback(value);
  }

  ingestCallback(
    payload: string,
    timestamp: string,
    signature: string,
    secret = this.options.callbackSecret,
    toleranceSeconds = 300,
  ): EngineScanResult {
    return this.handleCallback(payload, timestamp, signature, secret, toleranceSeconds);
  }

  private async produce(body: Buffer, meta: FileMeta): Promise<ProducedResult> {
    const hash = createHash("sha256").update(body).digest("hex");
    const lookup = await this.request(`/files/${hash}`, { method: "GET" }, [404]);
    if (lookup.status !== 404) return { result: this.aggregate(readAttributes(lookup.value)) };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(body)], { type: meta.mimeType }), meta.name);
    const submitted = await this.request("/files", { method: "POST", body: form });
    const id = readAnalysisId(submitted.value);
    const queued: EngineScanResult = {
      engine: this.name,
      verdict: "suspicious",
      details: [`Analysis queued: ${id}`],
    };
    const pollingEnabled =
      this.options.pollAnalyses ??
      this.options.poll ??
      this.options.polling?.enabled ??
      this.options.polling !== undefined;
    if (!pollingEnabled) return { result: queued, analysisId: id };
    return this.poll(id, queued);
  }

  private async poll(id: string, queued: EngineScanResult): Promise<ProducedResult> {
    const polling = this.options.polling ?? {};
    const interval = this.options.pollIntervalMs ?? polling.intervalMs ?? 1000;
    if (!Number.isSafeInteger(interval) || interval < 0 || interval > 60_000)
      throw new Error("Invalid VirusTotal polling interval");
    const attempts = positiveInteger(
      this.options.pollMaxAttempts ?? polling.maxAttempts ?? 30,
      "VirusTotal polling attempts",
      1000,
    );
    const timeout = positiveInteger(
      this.options.pollTimeoutMs ?? polling.timeoutMs ?? 60_000,
      "VirusTotal polling timeout",
    );
    const deadline = Date.now() + timeout;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const response = await this.request(
        `/analyses/${encodeURIComponent(id)}`,
        { method: "GET" },
        [],
        Math.min(this.timeoutMs, remaining),
      );
      const attributes = readAttributes(response.value);
      if (attributes.status === "completed") return { result: this.aggregate(attributes), analysisId: id };
      if (attempt + 1 < attempts) {
        const delay = Math.min(interval, Math.max(0, deadline - Date.now()));
        if (delay > 0)
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delay);
          });
      }
    }
    return { result: queued, analysisId: id };
  }

  private aggregate(attributes: VirusTotalAttributes): EngineScanResult {
    if (attributes.status && attributes.status !== "completed")
      return {
        engine: this.name,
        verdict: "suspicious",
        details: [`Analysis ${safeDetail(attributes.status, 64)}`],
      };
    if (!attributes.last_analysis_stats) throw new VirusTotalError("Invalid VirusTotal analysis statistics");
    const stats = attributes.last_analysis_stats;
    const verdict: ScanVerdict =
      stats.malicious > 0 ? "malicious" : stats.suspicious > 0 ? "suspicious" : "clean";
    return {
      engine: this.name,
      verdict,
      details: [
        `${stats.malicious} malicious, ${stats.suspicious} suspicious, ${stats.harmless} harmless, ${stats.undetected} undetected`,
      ],
    };
  }

  private storeCallback(value: unknown): EngineScanResult {
    if (!isRecord(value)) throw new Error("Invalid VirusTotal callback payload");
    const data = value.data;
    if (!isRecord(data) || typeof data.id !== "string")
      throw new Error("Invalid VirusTotal callback analysis");
    const analysisId = validAnalysisId(data.id);
    const attributes = readAttributes(value);
    const result = this.aggregate(attributes);
    const hash = callbackHash(value) ?? this.analysisHashes.get(analysisId);
    if (!hash) throw new Error("VirusTotal callback has no known file hash");
    this.store(hash, { result, analysisId });
    return cloneResult(result);
  }

  private cached(hash: string): EngineScanResult | undefined {
    const entry = this.cache.get(hash);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(hash);
      if (entry.analysisId && this.analysisHashes.get(entry.analysisId) === hash)
        this.analysisHashes.delete(entry.analysisId);
      return undefined;
    }
    return cloneResult(entry.result);
  }

  private store(hash: string, produced: ProducedResult): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
        if (entry.analysisId && this.analysisHashes.get(entry.analysisId) === key)
          this.analysisHashes.delete(entry.analysisId);
      }
    }
    const previous = this.cache.get(hash);
    if (
      previous?.analysisId &&
      previous.analysisId !== produced.analysisId &&
      this.analysisHashes.get(previous.analysisId) === hash
    )
      this.analysisHashes.delete(previous.analysisId);
    this.cache.delete(hash);
    this.cache.set(hash, {
      result: cloneResult(produced.result),
      expiresAt: now + this.cacheTtlMs,
      analysisId: produced.analysisId,
    });
    if (produced.analysisId) this.analysisHashes.set(produced.analysisId, hash);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      const entry = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      if (entry?.analysisId && this.analysisHashes.get(entry.analysisId) === oldest.value)
        this.analysisHashes.delete(entry.analysisId);
    }
  }

  private async request(
    requestPath: string,
    init: RequestInit,
    allowed: number[] = [],
    timeoutMs = this.timeoutMs,
  ): Promise<JsonResponse> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new VirusTotalError(`VirusTotal request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.performRequest(requestPath, init, allowed, controller.signal),
        timeout,
      ]);
    } catch (error) {
      if (timedOut) throw new VirusTotalError(`VirusTotal request timed out after ${timeoutMs}ms`);
      if (error instanceof VirusTotalError) throw error;
      throw new VirusTotalError("VirusTotal request failed");
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private async performRequest(
    requestPath: string,
    init: RequestInit,
    allowed: number[],
    signal: AbortSignal,
  ): Promise<JsonResponse> {
    const base = (this.options.baseUrl ?? "https://www.virustotal.com/api/v3").replace(/\/$/, "");
    const response = await this.fetcher(`${base}${requestPath}`, {
      ...init,
      signal,
      headers: { "x-apikey": this.options.apiKey, ...init.headers },
    });
    if (!response.ok && !allowed.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new VirusTotalError(`VirusTotal HTTP ${response.status}`);
    }
    if (allowed.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status };
    }
    let text: string;
    try {
      text = await readResponseText(response, this.maxResponseBytes);
    } catch {
      throw new VirusTotalError("Invalid or oversized VirusTotal response");
    }
    try {
      return { status: response.status, value: JSON.parse(text) as unknown };
    } catch {
      throw new VirusTotalError("Invalid VirusTotal JSON response");
    }
  }
}

function readAttributes(value: unknown): VirusTotalAttributes {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.attributes))
    throw new VirusTotalError("Missing VirusTotal attributes");
  const source = value.data.attributes;
  const result: VirusTotalAttributes = {};
  if (source.status !== undefined) {
    if (typeof source.status !== "string" || !["queued", "in-progress", "completed"].includes(source.status))
      throw new VirusTotalError("Invalid VirusTotal analysis status");
    result.status = source.status;
  }
  if (source.last_analysis_stats !== undefined) {
    if (!isRecord(source.last_analysis_stats))
      throw new VirusTotalError("Invalid VirusTotal analysis statistics");
    result.last_analysis_stats = {
      malicious: readCount(source.last_analysis_stats.malicious),
      suspicious: readCount(source.last_analysis_stats.suspicious),
      harmless: readCount(source.last_analysis_stats.harmless),
      undetected: readCount(source.last_analysis_stats.undetected),
    };
  }
  return result;
}

function readAnalysisId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.id !== "string")
    throw new VirusTotalError("Missing VirusTotal analysis id");
  return validAnalysisId(value.data.id);
}

function validAnalysisId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new VirusTotalError("Invalid VirusTotal analysis id");
  return value;
}

function readCount(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000)
    throw new VirusTotalError("Invalid VirusTotal analysis count");
  return value;
}

function callbackHash(value: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [];
  if (isRecord(value.meta) && isRecord(value.meta.file_info)) candidates.push(value.meta.file_info.sha256);
  if (isRecord(value.data)) {
    if (isRecord(value.data.attributes)) {
      candidates.push(value.data.attributes.sha256);
      if (isRecord(value.data.attributes.file_info)) candidates.push(value.data.attributes.file_info.sha256);
    }
    if (
      isRecord(value.data.relationships) &&
      isRecord(value.data.relationships.item) &&
      isRecord(value.data.relationships.item.data)
    )
      candidates.push(value.data.relationships.item.data.id);
  }
  const hash = candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate),
  );
  return hash;
}

function cloneResult(result: EngineScanResult): EngineScanResult {
  return { ...result, details: [...result.details] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
