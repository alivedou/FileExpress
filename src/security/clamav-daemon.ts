import { createConnection } from "node:net";
import { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import type { EngineScanResult, ScanEngine } from "./types";

export class ClamAvDaemonScanner implements ScanEngine {
  readonly name = "clamav-daemon";
  constructor(private readonly options: { host: string; port?: number; timeoutMs?: number }) {}
  async version(): Promise<string> { return this.command("zVERSION\0"); }
  async scan(stream: Readable, _meta: FileMeta): Promise<EngineScanResult> {
    const started = performance.now();
    const response = await this.instream(stream);
    const infected = /FOUND/i.test(response);
    if (!infected && !/OK/i.test(response)) throw new Error(`ClamAV daemon error: ${response}`);
    return { engine: this.name, verdict: infected ? "malicious" : "clean", details: infected ? [response] : [], durationMs: performance.now() - started };
  }
  private async instream(stream: Readable): Promise<string> {
    return this.exchange(async (write) => {
      write(Buffer.from("zINSTREAM\0"));
      for await (const value of stream) { const chunk = Buffer.from(value as Uint8Array); const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length); write(Buffer.concat([size, chunk])); }
      write(Buffer.alloc(4));
    });
  }
  private async command(command: string): Promise<string> { return this.exchange(async (write) => { write(Buffer.from(command)); }); }
  private async exchange(producer: (write: (chunk: Buffer) => void) => Promise<void>): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port ?? 3310 });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => socket.destroy(new Error("ClamAV daemon timeout")), this.options.timeoutMs ?? 30_000);
      socket.on("connect", () => { void producer((chunk) => socket.write(chunk)).then(() => socket.end()).catch((error: unknown) => socket.destroy(error instanceof Error ? error : new Error("Stream failed"))); });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim()); });
    });
  }
}
