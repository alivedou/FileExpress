import { createHash } from "node:crypto";
import type { Readable} from "node:stream";
import { Transform } from "node:stream";
import type { BackendKind, HealthStatus } from "./types";

export async function bufferFromStream(
  stream: Readable,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("Invalid stream size limit");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = byteChunk(value);
    size += chunk.length;
    if (!Number.isSafeInteger(size) || size > maximumBytes)
      throw new Error("Stream exceeds configured size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function* chunksFromStream(stream: Readable, chunkSize: number): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("Invalid chunk size");
  let pending = Buffer.allocUnsafe(chunkSize);
  let offset = 0;
  for await (const value of stream) {
    const chunk = byteChunk(value);
    let sourceOffset = 0;
    while (sourceOffset < chunk.length) {
      const copied = chunk.copy(pending, offset, sourceOffset, sourceOffset + chunkSize - offset);
      offset += copied;
      sourceOffset += copied;
      if (offset === chunkSize) {
        yield pending;
        pending = Buffer.allocUnsafe(chunkSize);
        offset = 0;
      }
    }
  }
  if (offset > 0) yield pending.subarray(0, offset);
}

export function hashingStream(hash = createHash("sha256"), onBytes?: (size: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      hash.update(bytes);
      onBytes?.(bytes.length);
      callback(null, bytes);
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
    return {
      backend,
      kind,
      healthy: true,
      latencyMs: performance.now() - started,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      backend,
      kind,
      healthy: false,
      latencyMs: performance.now() - started,
      checkedAt: new Date().toISOString(),
      message: safeErrorMessage(error),
    };
  }
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown storage error";
  return message
    .replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, "://[REDACTED]@")
    .replace(
      /((?:secret|password|token|api[-_]?key|access[-_]?key(?:id)?|account[-_]?key|credential|signature|authorization|sig)=)[^\s&;]+/gi,
      "$1[REDACTED]",
    );
}

function byteChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("Storage streams must contain bytes");
}
