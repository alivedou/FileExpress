import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { HeuristicScanner } from "./heuristic";
import type {
  ScanAction,
  EngineScanResult,
  ScanEngine,
  ScanEventSink,
  ScanSummary,
  ScanVerdict,
} from "./types";
import { errorMessage, positiveInteger, safeDetail, withTimeout } from "./utils";

export interface QuarantinePort {
  isolate(fileId: string, stream: Readable, summary: ScanSummary): Promise<unknown>;
}
export interface ScanPipelineOptions {
  engines?: ScanEngine[];
  events?: ScanEventSink;
  quarantine?: QuarantinePort;
  concurrency?: number;
  maxQueue?: number;
  engineTimeoutMs?: number;
  verdictPriority?: readonly ScanVerdict[];
  actions?: Partial<Record<ScanVerdict, ScanAction>>;
  failClosed?: boolean;
  whitelist?: readonly string[] | ReadonlySet<string>;
  whitelistMaxBytes?: number;
}

const DEFAULT_PRIORITY: readonly ScanVerdict[] = ["malicious", "suspicious", "error", "clean"];
const DEFAULT_ACTIONS: Record<ScanVerdict, ScanAction> = {
  malicious: "quarantine",
  suspicious: "review",
  error: "review",
  clean: "accept",
};

export class ScanPipeline {
  private readonly engines: ScanEngine[];
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly engineTimeoutMs: number;
  private readonly priority: ScanVerdict[];
  private readonly actions: Record<ScanVerdict, ScanAction>;
  private readonly failClosed: boolean;
  private readonly whitelist?: ReadonlySet<string>;
  private readonly whitelistMaxBytes: number;
  private active = 0;

  constructor(private readonly options: ScanPipelineOptions = {}) {
    this.engines = options.engines ?? [new HeuristicScanner()];
    this.concurrency = positiveInteger(options.concurrency ?? 2, "scan concurrency", 1024);
    if (!Number.isSafeInteger(options.maxQueue ?? 10_000) || (options.maxQueue ?? 10_000) < 0)
      throw new Error("Invalid scan queue size");
    this.maxQueue = options.maxQueue ?? 10_000;
    this.engineTimeoutMs = positiveInteger(options.engineTimeoutMs ?? 30_000, "scan engine timeout");
    this.priority = normalisePriority(options.verdictPriority ?? DEFAULT_PRIORITY);
    this.actions = { ...DEFAULT_ACTIONS, ...options.actions };
    this.failClosed = options.failClosed ?? true;
    this.whitelist = normaliseWhitelist(options.whitelist);
    this.whitelistMaxBytes = positiveInteger(
      options.whitelistMaxBytes ?? 128 * 1024 * 1024,
      "whitelist scan size",
      1024 * 1024 * 1024,
    );
  }

  scan(fileId: string, streamFactory: () => Readable, meta: FileMeta): Promise<ScanSummary> {
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueue)
      return Promise.reject(new Error("Scan queue is full"));
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await this.execute(fileId, streamFactory, meta);
          this.active -= 1;
          resolve(result);
        } catch (error) {
          this.active -= 1;
          reject(error);
        }
        this.drain();
      });
      this.drain();
    });
  }

  get depth(): number {
    return this.queue.length + this.active;
  }

  private async execute(fileId: string, streamFactory: () => Readable, meta: FileMeta): Promise<ScanSummary> {
    const startedAt = new Date().toISOString();
    const results = await Promise.all(
      this.engines.map((engine) => this.runEngine(engine, streamFactory, meta)),
    );
    if (!results.length)
      results.push({ engine: "pipeline", verdict: "error", details: ["No scan engines configured"] });
    let aggregate = this.aggregate(results);
    let checksum: string | undefined;
    let whitelisted = false;
    if (this.whitelist?.size) {
      let input: Readable | undefined;
      try {
        input = streamFactory();
        checksum = await withTimeout(
          this.checksum(input),
          this.engineTimeoutMs,
          () => input?.destroy(),
          "Whitelist checksum timed out",
        );
        const hasThreat = results.some((item) => item.verdict === "malicious");
        const hasFailure = results.some((item) => item.verdict === "error");
        if (this.whitelist.has(checksum) && !hasThreat && !(this.failClosed && hasFailure)) {
          whitelisted = true;
          aggregate = { verdict: "clean", action: "accept" };
        }
      } catch (error) {
        input?.destroy();
        results.push({ engine: "whitelist", verdict: "error", details: [safeDetail(errorMessage(error))] });
        aggregate = this.aggregate(results);
      }
    }
    const summary: ScanSummary = {
      fileId,
      verdict: aggregate.verdict,
      action: aggregate.action,
      results,
      startedAt,
      completedAt: new Date().toISOString(),
      ...(checksum ? { checksum } : {}),
      ...(this.whitelist ? { whitelisted } : {}),
    };
    if (summary.action === "quarantine") {
      let input: Readable | undefined;
      try {
        const quarantine = this.options.quarantine;
        if (!quarantine) throw new Error("Quarantine storage is not configured");
        input = streamFactory();
        const source = input;
        const isolation = Promise.resolve().then(() => quarantine.isolate(fileId, source, summary));
        await withTimeout(
          isolation,
          this.engineTimeoutMs,
          () => input?.destroy(),
          "Quarantine isolation timed out",
        );
      } catch (error) {
        input?.destroy();
        results.push({ engine: "quarantine", verdict: "error", details: [safeDetail(errorMessage(error))] });
        summary.action = this.actions.error === "accept" ? "review" : this.actions.error;
      }
    }
    summary.completedAt = new Date().toISOString();
    const eventState = { ...(checksum ? { checksum } : {}), ...(this.whitelist ? { whitelisted } : {}) };
    if (summary.verdict === "malicious")
      await this.publish("scan.threat_detected", {
        id: fileId,
        verdict: summary.verdict,
        action: summary.action,
        engines: results,
        ...eventState,
      });
    if (results.some((item) => item.verdict === "error"))
      await this.publish("scan.error", {
        id: fileId,
        verdict: summary.verdict,
        action: summary.action,
        engines: results,
        ...eventState,
      });
    await this.publish("scan.completed", {
      id: fileId,
      verdict: summary.verdict,
      action: summary.action,
      ...eventState,
    });
    return summary;
  }

  private async runEngine(
    engine: ScanEngine,
    streamFactory: () => Readable,
    meta: FileMeta,
  ): Promise<EngineScanResult> {
    const started = performance.now();
    let stream: Readable | undefined;
    try {
      stream = streamFactory();
      const result = await withTimeout(
        Promise.resolve(engine.scan(stream, meta)),
        this.engineTimeoutMs,
        () => stream?.destroy(),
        `Scan engine ${engine.name} timed out`,
      );
      return { ...result, details: [...result.details], durationMs: performance.now() - started };
    } catch (error) {
      stream?.destroy();
      return {
        engine: engine.name,
        verdict: "error",
        details: [safeDetail(errorMessage(error))],
        durationMs: performance.now() - started,
      };
    }
  }

  private aggregate(results: EngineScanResult[]): { verdict: ScanVerdict; action: ScanAction } {
    const verdict =
      this.priority.find((candidate) => results.some((item) => item.verdict === candidate)) ?? "error";
    const result = { verdict, action: this.actions[verdict] };
    return this.failClosed && results.some((item) => item.verdict === "error") && result.action === "accept"
      ? this.failureAction(results, result)
      : result;
  }

  private failureAction(
    results: EngineScanResult[],
    current: { verdict: ScanVerdict; action: ScanAction },
  ): { verdict: ScanVerdict; action: ScanAction } {
    if (!this.failClosed) return current;
    const action = this.actions.error === "accept" ? "review" : this.actions.error;
    return { verdict: "error", action };
  }

  private async checksum(stream: Readable): Promise<string> {
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const raw of stream) {
        const value: unknown = raw;
        const chunk = Buffer.isBuffer(value)
          ? value
          : typeof value === "string"
            ? Buffer.from(value)
            : value instanceof Uint8Array
              ? Buffer.from(value)
              : undefined;
        if (!chunk) throw new Error("Whitelist checksum requires byte stream input");
        size += chunk.length;
        if (size > this.whitelistMaxBytes) throw new Error("Stream exceeds configured whitelist size limit");
        hash.update(chunk);
      }
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return hash.digest("hex");
  }

  private async publish(
    event: "scan.completed" | "scan.threat_detected" | "scan.error",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const sink = this.options.events;
    if (!sink) return;
    const operation = Promise.resolve().then(() => sink.publish(event, payload));
    await withTimeout(
      operation,
      this.engineTimeoutMs,
      () => undefined,
      `Scan event ${event} timed out`,
    ).catch(() => undefined);
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      this.active += 1;
      void task();
    }
  }
}

function normalisePriority(configured: readonly ScanVerdict[]): ScanVerdict[] {
  const result: ScanVerdict[] = [];
  for (const verdict of configured) {
    if (!DEFAULT_PRIORITY.includes(verdict)) throw new Error("Invalid scan verdict priority");
    if (result.includes(verdict)) throw new Error("Duplicate scan verdict priority");
    result.push(verdict);
  }
  for (const verdict of DEFAULT_PRIORITY) if (!result.includes(verdict)) result.push(verdict);
  return result;
}

function normaliseWhitelist(
  configured?: readonly string[] | ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (!configured) return undefined;
  const values = new Set<string>();
  for (const value of configured) {
    if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("Invalid whitelist checksum");
    values.add(value.toLowerCase());
  }
  return values;
}
