import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { bufferFromStream } from "../storage/utils";
import type { EngineScanResult, ScanEngine } from "./types";
import type { FetchLike } from "./clamav";

interface VirusTotalStats { malicious?: number; suspicious?: number; harmless?: number; undetected?: number }
interface VirusTotalAttributes { last_analysis_stats?: VirusTotalStats; status?: string }

export class VirusTotalScanner implements ScanEngine {
  readonly name = "virustotal";
  private readonly cache = new Map<string, { result: EngineScanResult; expiresAt: number }>();
  private readonly fetcher: FetchLike;
  constructor(private readonly options: { apiKey: string; baseUrl?: string; cacheTtlMs?: number; maxBytes?: number; fetchImpl?: FetchLike }) { this.fetcher = options.fetchImpl ?? fetch; }
  async version(): Promise<string> { return "multi-engine-cloud"; }

  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    const body = await bufferFromStream(stream, this.options.maxBytes ?? 32 * 1024 * 1024);
    const hash = createHash("sha256").update(body).digest("hex");
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.result, details: [...cached.result.details] };
    const lookup = await this.request(`/files/${hash}`, { method: "GET" }, [404]);
    let result: EngineScanResult;
    if (lookup.status === 404) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(body)], { type: meta.mimeType }), meta.name);
      const submitted = await this.request("/files", { method: "POST", body: form });
      const id = readAnalysisId(await submitted.json());
      result = { engine: this.name, verdict: "suspicious", details: [`Analysis queued: ${id}`] };
    } else result = this.aggregate(readAttributes(await lookup.json()));
    this.cache.set(hash, { result, expiresAt: Date.now() + (this.options.cacheTtlMs ?? 3600_000) });
    return { ...result, details: [...result.details] };
  }

  verifyCallback(payload: string, timestamp: string, signature: string, secret: string, toleranceSeconds = 300): boolean {
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > toleranceSeconds) return false;
    const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private aggregate(attributes: VirusTotalAttributes): EngineScanResult {
    if (attributes.status && attributes.status !== "completed") return { engine: this.name, verdict: "suspicious", details: [`Analysis ${attributes.status}`] };
    const stats = attributes.last_analysis_stats ?? {};
    const malicious = stats.malicious ?? 0;
    const suspicious = stats.suspicious ?? 0;
    const verdict = malicious > 0 ? "malicious" : suspicious > 0 ? "suspicious" : "clean";
    return { engine: this.name, verdict, details: [`${malicious} malicious, ${suspicious} suspicious, ${stats.harmless ?? 0} harmless, ${stats.undetected ?? 0} undetected`] };
  }

  private async request(path: string, init: RequestInit, allowed: number[] = []): Promise<Response> {
    const response = await this.fetcher(`${this.options.baseUrl ?? "https://www.virustotal.com/api/v3"}${path}`, { ...init, headers: { "x-apikey": this.options.apiKey, ...init.headers } });
    if (!response.ok && !allowed.includes(response.status)) throw new Error(`VirusTotal HTTP ${response.status}`);
    return response;
  }
}

function readAttributes(value: unknown): VirusTotalAttributes {
  if (!value || typeof value !== "object" || !("data" in value)) throw new Error("Invalid VirusTotal response");
  const data = value.data;
  if (!data || typeof data !== "object" || !("attributes" in data)) throw new Error("Missing VirusTotal attributes");
  return data.attributes as VirusTotalAttributes;
}
function readAnalysisId(value: unknown): string {
  const attributes = value as { data?: { id?: unknown } };
  if (typeof attributes.data?.id !== "string") throw new Error("Missing VirusTotal analysis id");
  return attributes.data.id;
}
