import { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import { bufferFromStream } from "../storage/utils";
import type { EngineScanResult, ScanEngine } from "./types";

export interface YaraMatch { rule: string; namespace?: string; tags?: string[]; severity?: "suspicious" | "malicious" }
export interface YaraRunner {
  version(): Promise<string>;
  scan(content: Buffer, fileName: string): Promise<YaraMatch[]>;
}

export class YaraScanner implements ScanEngine {
  readonly name = "yara";
  constructor(private readonly runner: YaraRunner, private readonly maxBytes = 64 * 1024 * 1024) {}
  async version(): Promise<string> { return this.runner.version(); }
  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    const matches = await this.runner.scan(await bufferFromStream(stream, this.maxBytes), meta.name);
    const verdict = matches.some((match) => match.severity === "malicious") ? "malicious" : matches.length ? "suspicious" : "clean";
    return { engine: this.name, verdict, details: matches.map((match) => `${match.namespace ? `${match.namespace}:` : ""}${match.rule}${match.tags?.length ? ` [${match.tags.join(",")}]` : ""}`), signatureVersion: await this.runner.version() };
  }
}

export function parseYaraCli(output: string): YaraMatch[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [rule, ...pathParts] = line.split(/\s+/);
    if (!rule || !pathParts.length) throw new Error(`Invalid YARA output: ${line}`);
    return { rule, severity: /macro|credential|suspicious/i.test(rule) ? "suspicious" : "malicious" };
  });
}
