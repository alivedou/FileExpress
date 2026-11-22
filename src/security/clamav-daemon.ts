import { createConnection } from "node:net";
import type { Readable } from "node:stream";
import type { FileMeta } from "../storage/types";
import type { EngineScanResult, ScanEngine } from "./types";
import { errorMessage, positiveInteger, safeDetail } from "./utils";

export interface ClamAvDaemonOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  maxChunkBytes?: number;
  maxResponseBytes?: number;
}
type Producer = (write: (chunk: Buffer) => Promise<void>, active: () => boolean) => Promise<void>;

export class ClamAvDaemonScanner implements ScanEngine {
  readonly name = "clamav-daemon";
  private readonly timeoutMs: number;
  private readonly maxChunkBytes: number;
  private readonly maxResponseBytes: number;
  constructor(private readonly options: ClamAvDaemonOptions) {
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, "ClamAV daemon timeout");
    this.maxChunkBytes = positiveInteger(
      options.maxChunkBytes ?? 1024 * 1024,
      "ClamAV daemon chunk size",
      16 * 1024 * 1024,
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 64 * 1024,
      "ClamAV daemon response size",
      1024 * 1024,
    );
  }
  async version(): Promise<string> {
    const response = await this.exchange(async (write) => {
      await write(Buffer.from("zVERSION\0"));
    });
    if (!response) throw new Error("Empty ClamAV daemon version response");
    if (/\sERROR$/i.test(response)) throw new Error(`ClamAV daemon error: ${safeDetail(response)}`);
    return response;
  }
  async scan(stream: Readable, meta: FileMeta): Promise<EngineScanResult> {
    void meta;
    const started = performance.now();
    try {
      const response = await this.instream(stream);
      const found = /^stream:\s+(.+)\s+FOUND$/i.exec(response);
      if (found)
        return {
          engine: this.name,
          verdict: "malicious",
          details: [safeDetail(response)],
          durationMs: performance.now() - started,
        };
      if (/^stream:\s+OK$/i.test(response))
        return { engine: this.name, verdict: "clean", details: [], durationMs: performance.now() - started };
      if (/^stream:\s+(.+)\s+ERROR$/i.test(response))
        throw new Error(`ClamAV daemon error: ${safeDetail(response)}`);
      throw new Error(`Unrecognised ClamAV daemon response: ${safeDetail(response)}`);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }
  private async instream(stream: Readable): Promise<string> {
    return this.exchange(async (write, active) => {
      await write(Buffer.from("zINSTREAM\0"));
      for await (const raw of stream) {
        if (!active()) return;
        const value: unknown = raw;
        const chunk = toBuffer(value);
        for (let offset = 0; offset < chunk.length; offset += this.maxChunkBytes) {
          if (!active()) return;
          const part = chunk.subarray(offset, Math.min(offset + this.maxChunkBytes, chunk.length));
          const size = Buffer.allocUnsafe(4);
          size.writeUInt32BE(part.length, 0);
          await write(size);
          if (!active()) return;
          await write(part);
        }
      }
      if (active()) await write(Buffer.alloc(4));
    }, stream);
  }
  private async command(command: string): Promise<string> {
    return this.exchange(async (write) => {
      await write(Buffer.from(command));
    });
  }
  private exchange(producer: Producer, input?: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port ?? 3310 });
      const abort = new AbortController();
      let pending: Buffer = Buffer.alloc(0);
      let settled = false;
      let connected = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const finish = (error?: Error, response?: string): void => {
        if (settled) return;
        settled = true;
        abort.abort();
        if (input && !input.destroyed) input.destroy();
        cleanup();
        socket.destroy();
        if (error) reject(error);
        else resolve(response ?? "");
      };
      const write = async (chunk: Buffer): Promise<void> => {
        if (settled || abort.signal.aborted) throw new Error("ClamAV daemon exchange closed");
        if (!chunk.length) return;
        if (socket.write(chunk)) return;
        await new Promise<void>((resolveWrite, rejectWrite) => {
          const remove = (): void => {
            socket.removeListener("drain", onDrain);
            socket.removeListener("error", onFailure);
            socket.removeListener("close", onClosed);
            abort.signal.removeEventListener("abort", onAbort);
          };
          const onDrain = (): void => {
            remove();
            resolveWrite();
          };
          const onFailure = (error: Error): void => {
            remove();
            rejectWrite(error);
          };
          const onClosed = (): void => {
            remove();
            rejectWrite(new Error("ClamAV daemon connection closed"));
          };
          const onAbort = (): void => {
            remove();
            rejectWrite(new Error("ClamAV daemon exchange closed"));
          };
          socket.once("drain", onDrain);
          socket.once("error", onFailure);
          socket.once("close", onClosed);
          abort.signal.addEventListener("abort", onAbort, { once: true });
        });
      };
      const onConnect = (): void => {
        connected = true;
        void producer(write, () => !settled && !abort.signal.aborted).catch((error: unknown) => {
          if (!settled) finish(new Error(`ClamAV daemon write failed: ${safeDetail(errorMessage(error))}`));
        });
      };
      const onData = (chunk: Buffer): void => {
        if (settled) return;
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (true) {
          const nul = pending.indexOf(0);
          const newline = pending.indexOf(10);
          const end = nul < 0 ? newline : newline < 0 ? nul : Math.min(nul, newline);
          if (end < 0) {
            if (pending.length > this.maxResponseBytes)
              finish(new Error("ClamAV daemon response exceeds configured size limit"));
            return;
          }
          if (end > this.maxResponseBytes) {
            finish(new Error("ClamAV daemon response exceeds configured size limit"));
            return;
          }
          const response = pending.subarray(0, end).toString("utf8").replace(/\r$/, "").trim();
          finish(undefined, response);
          return;
        }
      };
      const onError = (error: Error): void =>
        finish(new Error(`ClamAV daemon connection failed: ${safeDetail(errorMessage(error))}`));
      const onClose = (): void => {
        if (!settled)
          finish(
            new Error(
              connected
                ? "ClamAV daemon closed before a complete response"
                : "ClamAV daemon connection closed",
            ),
          );
      };
      const timer = setTimeout(
        () => finish(new Error(`ClamAV daemon exchange timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
      socket.once("connect", onConnect);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("ClamAV daemon scanner requires byte stream input");
}
