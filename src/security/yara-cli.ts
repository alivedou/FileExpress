import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { YaraMatch, YaraRunner } from "./yara";
import { parseYaraCli } from "./yara";

const execute = promisify(execFile);
export class YaraCliRunner implements YaraRunner {
  constructor(private readonly options: { binary?: string; rulesPath: string; timeoutMs?: number }) {}
  async version(): Promise<string> { const { stdout } = await execute(this.options.binary ?? "yara", ["--version"], { timeout: this.options.timeoutMs ?? 30_000 }); return stdout.trim(); }
  async scan(content: Buffer, fileName: string): Promise<YaraMatch[]> {
    const directory = await mkdtemp(path.join(tmpdir(), "fileexpress-yara-"));
    try {
      const extension = path.extname(fileName).replace(/[^a-z0-9.]/gi, "").slice(0, 16);
      const target = path.join(directory, `payload${extension}`);
      await writeFile(target, content, { flag: "wx" });
      try {
        const { stdout } = await execute(this.options.binary ?? "yara", ["-r", this.options.rulesPath, target], { timeout: this.options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024 });
        return parseYaraCli(stdout);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string" && !error.stdout.trim()) return [];
        throw error;
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
