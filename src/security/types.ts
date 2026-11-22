import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";

export type ScanVerdict = "clean" | "suspicious" | "malicious" | "error";
export interface EngineScanResult { engine: string; verdict: ScanVerdict; details: string[]; signatureVersion?: string; durationMs?: number }
export interface ScanEngine { readonly name: string; version(): Promise<string>; scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> }
export interface ScanSummary {
  fileId: string;
  verdict: ScanVerdict | "pending";
  action: "accept" | "review" | "quarantine" | "reject";
  results: EngineScanResult[];
  startedAt: string;
  completedAt: string;
}
export interface ScanEventSink { publish(event: "scan.completed" | "scan.threat_detected" | "scan.error", payload: Record<string, unknown>): Promise<void> }
