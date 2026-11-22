import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { YaraMatch, YaraRunner } from "./yara";
import { parseYaraCli } from "./yara";
import { positiveInteger } from "./utils";

const execute = promisify(execFile);
export class YaraCliRunner implements YaraRunner {
  private readonly binary: string;
  private readonly rulesPath: string;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  constructor(options: { binary?: string; rulesPath: string; timeoutMs?: number; maxBuffer?: number }) {
    this.binary = controlledPath(options.binary ?? "/usr/bin/yara");
    this.rulesPath = controlledPath(options.rulesPath);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "YARA timeout");
    this.maxBuffer = positiveInteger(
      options.maxBuffer ?? 4 * 1024 * 1024,
      "YARA output size",
      4 * 1024 * 1024,
    );
  }
  async version(): Promise<string> {
    const { stdout } = await execute(this.binary, ["--version"], {
      shell: false,
      windowsHide: true,
      timeout: this.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: this.maxBuffer,
    });
    return stdout.trim().slice(0, 1024);
  }
  async scan(content: Buffer, fileName: string): Promise<YaraMatch[]> {
    const rules = await this.rules();
    const directory = await mkdtemp(path.join(tmpdir(), "fileexpress-yara-"));
    await chmod(directory, 0o700);
    try {
      const extension = path
        .extname(fileName)
        .replace(/[^a-z0-9.]/gi, "")
        .slice(0, 16);
      const target = path.join(directory, `payload${extension}`);
      await writeFile(target, content, { flag: "wx", mode: 0o600 });
      try {
        const { stdout } = await execute(this.binary, ["--", rules, target], {
          shell: false,
          windowsHide: true,
          timeout: this.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: this.maxBuffer,
        });
        return parseYaraCli(stdout);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 1 &&
          "stdout" in error &&
          typeof error.stdout === "string" &&
          !error.stdout.trim()
        )
          return [];
        throw error;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async rules(): Promise<string> {
    const metadata = await lstat(this.rulesPath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("YARA rules must be a regular non-symlink file");
    return realpath(this.rulesPath);
  }
}

function controlledPath(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Invalid YARA executable or rules path");
  return path.resolve(value);
}
