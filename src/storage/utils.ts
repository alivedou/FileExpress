import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { BackendKind, HealthStatus } from "./types";

export async function bufferFromStream(stream: Readable, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Stream exceeds configured size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function* chunksFromStream(stream: Readable, chunkSize: number): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("Invalid chunk size");
  let pending = Buffer.alloc(0);
  for await (const value of stream) {
    pending = Buffer.concat([pending, Buffer.from(value as Uint8Array)]);
    while (pending.length >= chunkSize) {
      yield pending.subarray(0, chunkSize);
      pending = pending.subarray(chunkSize);
    }
  }
  if (pending.length) yield pending;
}

export function hashingStream(hash = createHash("sha256"), onBytes?: (size: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      onBytes?.(chunk.length);
      callback(null, chunk);
    },
  });
}

export async function healthResult(
  backend: string,
  kind: BackendKind,
  probe: () => Promise<void>,
): Promise<HealthStatus> {
  const started = performance.now();
  try {
    await probe();
    return { backend, kind, healthy: true, latencyMs: performance.now() - started, checkedAt: new Date().toISOString() };
  } catch (error) {
    return {
      backend,
      kind,
      healthy: false,
      latencyMs: performance.now() - started,
      checkedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Unknown storage error",
    };
  }
}
