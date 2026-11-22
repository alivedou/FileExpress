import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { bufferFromStream } from "../storage/utils";
import type { EngineScanResult, ScanEngine } from "./types";
import { positiveInteger, withTimeout } from "./utils";

export interface YaraMatch {
  rule: string;
  namespace?: string;
  tags?: string[];
  severity?: "suspicious" | "malicious";
}
export interface YaraRunner {
  version(): Promise<string>;
  scan(content: Buffer, fileName: string): Promise<YaraMatch[]>;
}
export interface YaraScannerOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxMatches?: number;
}

export class YaraScanner implements ScanEngine {
  readonly name = "yara";
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxMatches: number;
  constructor(
    private readonly runner: YaraRunner,
    options: number | YaraScannerOptions = {},
  ) {
    const configured = typeof options === "number" ? { maxBytes: options } : options;
    this.maxBytes = positiveInteger(
      configured.maxBytes ?? 64 * 1024 * 1024,
      "YARA input size",
      1024 * 1024 * 1024,
    );
    this.timeoutMs = positiveInteger(configured.timeoutMs ?? 30_000, "YARA timeout");
    this.maxMatches = positiveInteger(configured.maxMatches ?? 10_000, "YARA match limit", 100_000);
  }
  async version(): Promise<string> {
    const version = await withTimeout(
      this.runner.version(),
      this.timeoutMs,
      () => undefined,
      "YARA version check timed out",
    );
    return version.slice(0, 1024);
  }
  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    return withTimeout(
      this.execute(stream, meta),
      this.timeoutMs,
      () => stream.destroy(),
      "YARA scan timed out",
    );
  }
  private async execute(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    const content = await bufferFromStream(stream, this.maxBytes);
    const matches = (await this.runner.scan(content, meta.name)).slice(0, this.maxMatches);
    const verdict = matches.some((match) => match.severity === "malicious")
      ? "malicious"
      : matches.length
        ? "suspicious"
        : "clean";
    const signatureVersion = (await this.runner.version()).slice(0, 1024);
    return {
      engine: this.name,
      verdict,
      details: matches.map(
        (match) =>
          `${match.namespace ? `${match.namespace.slice(0, 128)}:` : ""}${match.rule.slice(0, 256)}${
            match.tags?.length
              ? ` [${match.tags
                  .slice(0, 32)
                  .map((tag) => tag.slice(0, 64))
                  .join(",")}]`
              : ""
          }`,
      ),
      signatureVersion,
    };
  }
}

export function parseYaraCli(output: string): YaraMatch[] {
  if (Buffer.byteLength(output) > 4 * 1024 * 1024)
    throw new Error("YARA output exceeds configured size limit");
  const lines = output.split(/\r?\n/);
  if (lines.length > 10_001) throw new Error("YARA output contains too many lines");
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.length > 4096) throw new Error("Invalid YARA output line length");
      const [rule, ...pathParts] = line.split(/\s+/);
      if (!rule || !pathParts.length || rule.length > 256 || /[\u0000-\u001f\u007f]/.test(rule))
        throw new Error(`Invalid YARA output: ${line.slice(0, 160)}`);
      return { rule, severity: /macro|credential|suspicious/i.test(rule) ? "suspicious" : "malicious" };
    });
}
