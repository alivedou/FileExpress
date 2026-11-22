import { Readable } from "node:stream";
import { bufferFromStream } from "../storage/utils";
import type { FileMeta } from "../storage/types";
import type { EngineScanResult, ScanEngine } from "./types";

export interface HeuristicOptions { entropyThreshold?: number; maxSampleBytes?: number }

export function shannonEntropy(data: Buffer): number {
  if (!data.length) return 0;
  const counts = new Uint32Array(256);
  for (const byte of data) counts[byte] = (counts[byte] ?? 0) + 1;
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / data.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function analyseHeuristics(data: Buffer, mimeType: string, options: HeuristicOptions = {}): EngineScanResult {
  const details: string[] = [];
  let malicious = false;
  let suspicious = false;
  const executableAt = findExecutableHeader(data);
  if (executableAt === 0) {
    details.push("Executable header at file start");
    malicious = !["application/x-msdownload", "application/x-executable", "application/x-elf"].includes(mimeType);
  } else if (executableAt > 0) {
    details.push(`Embedded executable header at offset ${executableAt}`);
    malicious = true;
  }
  if (isOfficeArchive(data) && data.includes(Buffer.from("vbaProject.bin"))) {
    details.push("Office macro project detected");
    suspicious = true;
  }
  if (mimeType === "application/pdf" && /\/JavaScript|\/JS|\/Launch|\/OpenAction/.test(data.toString("latin1"))) {
    details.push("Active PDF content detected");
    suspicious = true;
  }
  const sample = data.subarray(0, options.maxSampleBytes ?? 4 * 1024 * 1024);
  const entropy = shannonEntropy(sample);
  if (sample.length >= 4096 && entropy >= (options.entropyThreshold ?? 7.95)) {
    details.push(`High entropy sample: ${entropy.toFixed(3)} bits/byte`);
    suspicious = true;
  }
  if (!data.length) details.push("Empty file");
  return { engine: "heuristic", verdict: malicious ? "malicious" : suspicious ? "suspicious" : "clean", details, signatureVersion: "builtin-v1" };
}

export class HeuristicScanner implements ScanEngine {
  readonly name = "heuristic";
  constructor(private readonly options: HeuristicOptions = {}) {}
  async version(): Promise<string> { return "builtin-v1"; }
  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    return analyseHeuristics(await bufferFromStream(stream, this.options.maxSampleBytes ?? 64 * 1024 * 1024), meta.mimeType, this.options);
  }
}

function findExecutableHeader(data: Buffer): number {
  const mz = data.indexOf(Buffer.from([0x4d, 0x5a]));
  const elf = data.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  if (mz < 0) return elf;
  if (elf < 0) return mz;
  return Math.min(mz, elf);
}

function isOfficeArchive(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04 && data.includes(Buffer.from("[Content_Types].xml"));
}
