import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { HeuristicScanner } from "./heuristic";
import type { EngineScanResult, ScanEngine, ScanEventSink, ScanSummary } from "./types";

export interface QuarantinePort { isolate(fileId: string, stream: Readable, summary: ScanSummary): Promise<unknown> }
export interface ScanPipelineOptions { engines?: ScanEngine[]; events?: ScanEventSink; quarantine?: QuarantinePort; concurrency?: number }

export class ScanPipeline {
  private readonly engines: ScanEngine[];
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  constructor(private readonly options: ScanPipelineOptions = {}) { this.engines = options.engines ?? [new HeuristicScanner()]; }

  scan(fileId: string, streamFactory: () => Readable, meta: FileMeta): Promise<ScanSummary> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await this.execute(fileId, streamFactory, meta)); } catch (error) { reject(error); }
      });
      this.drain();
    });
  }

  get depth(): number { return this.queue.length + this.active; }

  private async execute(fileId: string, streamFactory: () => Readable, meta: FileMeta): Promise<ScanSummary> {
    const startedAt = new Date().toISOString();
    const results = await Promise.all(this.engines.map(async (engine): Promise<EngineScanResult> => {
      const started = performance.now();
      try { return { ...await engine.scan(streamFactory(), meta), durationMs: performance.now() - started }; }
      catch (error) { return { engine: engine.name, verdict: "error", details: [error instanceof Error ? error.message : "Unknown scanner error"], durationMs: performance.now() - started }; }
    }));
    const verdict = results.some((item) => item.verdict === "malicious") ? "malicious" : results.some((item) => item.verdict === "suspicious") ? "suspicious" : results.some((item) => item.verdict === "error") ? "error" : "clean";
    const action = verdict === "malicious" ? "quarantine" : verdict === "suspicious" ? "review" : verdict === "error" ? "review" : "accept";
    const summary: ScanSummary = { fileId, verdict, action, results, startedAt, completedAt: new Date().toISOString() };
    if (action === "quarantine" && this.options.quarantine) await this.options.quarantine.isolate(fileId, streamFactory(), summary);
    await this.publish(verdict === "malicious" ? "scan.threat_detected" : verdict === "error" ? "scan.error" : "scan.completed", { id: fileId, verdict, action, engines: results });
    await this.publish("scan.completed", { id: fileId, verdict, action });
    return summary;
  }

  private async publish(event: "scan.completed" | "scan.threat_detected" | "scan.error", payload: Record<string, unknown>): Promise<void> {
    await this.options.events?.publish(event, payload).catch(() => undefined);
  }

  private drain(): void {
    const limit = Math.max(1, this.options.concurrency ?? 2);
    while (this.active < limit && this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      this.active += 1;
      void task().finally(() => { this.active -= 1; this.drain(); });
    }
  }
}
