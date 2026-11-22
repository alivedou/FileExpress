import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import type { EngineScanResult, ScanEngine } from "./types";
import { positiveInteger } from "./utils";

export interface HeuristicOptions {
  entropyThreshold?: number;
  maxSampleBytes?: number;
  maxScanBytes?: number;
}

const EXECUTABLE_HEADERS = [
  Buffer.from([0x4d, 0x5a]),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0x50, 0x45, 0, 0]),
];
const OFFICE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CONTENT_TYPES = Buffer.from("[Content_Types].xml");
const MACRO_PROJECT = Buffer.from("vbaProject.bin");
const PDF_ACTIVE_TOKENS = ["/JavaScript", "/JS", "/Launch", "/OpenAction"].map((value) =>
  Buffer.from(value, "latin1"),
);
const SEARCH_TOKENS = [...EXECUTABLE_HEADERS, CONTENT_TYPES, MACRO_PROJECT, ...PDF_ACTIVE_TOKENS];
const CARRY_BYTES = Math.max(...SEARCH_TOKENS.map((value) => value.length)) - 1;

export function shannonEntropy(data: Buffer): number {
  if (!data.length) return 0;
  const counts = new Float64Array(256);
  for (const byte of data) counts[byte] = (counts[byte] ?? 0) + 1;
  return entropyFromCounts(counts, data.length);
}

export function analyseHeuristics(
  data: Buffer,
  mimeType: string,
  options: HeuristicOptions = {},
): EngineScanResult {
  const maximum = positiveInteger(
    options.maxScanBytes ?? Math.max(1, data.length),
    "heuristic scan size",
    1024 * 1024 * 1024,
  );
  if (data.length > maximum) throw new Error("Content exceeds configured heuristic scan limit");
  const state = new HeuristicState(options.maxSampleBytes ?? 4 * 1024 * 1024);
  state.push(data);
  return state.result(mimeType, validEntropyThreshold(options.entropyThreshold ?? 7.95));
}

export class HeuristicScanner implements ScanEngine {
  readonly name = "heuristic";
  constructor(private readonly options: HeuristicOptions = {}) {}
  async version(): Promise<string> {
    return "builtin-v1";
  }
  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    const maximum = positiveInteger(
      this.options.maxScanBytes ?? 64 * 1024 * 1024,
      "heuristic scan size",
      1024 * 1024 * 1024,
    );
    const state = new HeuristicState(this.options.maxSampleBytes ?? 4 * 1024 * 1024);
    try {
      for await (const raw of stream) {
        const value: unknown = raw;
        const chunk = toBuffer(value);
        const remaining = maximum - state.totalBytes;
        if (chunk.length > remaining) {
          if (remaining > 0) state.push(chunk.subarray(0, remaining));
          throw new Error("Stream exceeds configured heuristic scan limit");
        }
        state.push(chunk);
      }
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return state.result(meta.mimeType, validEntropyThreshold(this.options.entropyThreshold ?? 7.95));
  }
}

class HeuristicState {
  private readonly counts = new Float64Array(256);
  private carry = Buffer.alloc(0);
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private executableAt = -1;
  private hasContentTypes = false;
  private hasMacro = false;
  private hasActivePdf = false;
  private sampledBytes = 0;
  totalBytes = 0;

  constructor(private readonly maximumSampleBytes: number) {
    positiveInteger(maximumSampleBytes, "heuristic sample size", 1024 * 1024 * 1024);
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    const combined = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const baseOffset = this.totalBytes - this.carry.length;
    if (this.executableAt < 0) {
      for (const token of EXECUTABLE_HEADERS) {
        const found = combined.indexOf(token);
        if (found >= 0) {
          const offset = baseOffset + found;
          if (offset >= 0 && (this.executableAt < 0 || offset < this.executableAt))
            this.executableAt = offset;
        }
      }
    }
    if (!this.hasContentTypes) this.hasContentTypes = combined.includes(CONTENT_TYPES);
    if (!this.hasMacro) this.hasMacro = combined.includes(MACRO_PROJECT);
    if (!this.hasActivePdf) this.hasActivePdf = PDF_ACTIVE_TOKENS.some((token) => combined.includes(token));
    const headerCount = Math.min(4 - this.headerBytes, chunk.length);
    if (headerCount > 0) {
      chunk.copy(this.header, this.headerBytes, 0, headerCount);
      this.headerBytes += headerCount;
    }
    const sampleCount = Math.min(this.maximumSampleBytes - this.sampledBytes, chunk.length);
    for (let index = 0; index < sampleCount; index += 1) {
      const byte = chunk[index];
      if (byte !== undefined) this.counts[byte] = (this.counts[byte] ?? 0) + 1;
    }
    this.sampledBytes += sampleCount;
    const carryLength = Math.min(CARRY_BYTES, combined.length);
    this.carry = Buffer.alloc(carryLength);
    combined.copy(this.carry, 0, combined.length - carryLength);
    this.totalBytes += chunk.length;
  }

  result(mimeType: string, entropyThreshold: number): EngineScanResult {
    const details: string[] = [];
    let malicious = false;
    let suspicious = false;
    if (this.executableAt === 0) {
      details.push("Executable header at file start");
      malicious = !["application/x-msdownload", "application/x-executable", "application/x-elf"].includes(
        mimeType,
      );
    } else if (this.executableAt > 0) {
      details.push(`Embedded executable header at offset ${this.executableAt}`);
      malicious = true;
    }
    if (
      this.headerBytes === 4 &&
      this.header.equals(OFFICE_HEADER) &&
      this.hasContentTypes &&
      this.hasMacro
    ) {
      details.push("Office macro project detected");
      suspicious = true;
    }
    if (mimeType === "application/pdf" && this.hasActivePdf) {
      details.push("Active PDF content detected");
      suspicious = true;
    }
    const entropy = entropyFromCounts(this.counts, this.sampledBytes);
    if (this.sampledBytes >= 4096 && entropy >= entropyThreshold) {
      details.push(`High entropy sample: ${entropy.toFixed(3)} bits/byte`);
      suspicious = true;
    }
    if (!this.totalBytes) details.push("Empty file");
    return {
      engine: "heuristic",
      verdict: malicious ? "malicious" : suspicious ? "suspicious" : "clean",
      details,
      signatureVersion: "builtin-v1",
    };
  }
}

function validEntropyThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 8)
    throw new Error("Invalid heuristic entropy threshold");
  return value;
}

function entropyFromCounts(counts: Float64Array, length: number): number {
  if (!length) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("Heuristic scanner requires byte stream input");
}
