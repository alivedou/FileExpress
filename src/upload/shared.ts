import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withFileLock } from "../storage/file-lock";
import { UploadError } from "./errors";

export interface CompletionNotification {
  id: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  tenantId: string;
  checksum: string;
}

export interface CompletionResult {
  pickupCode?: string;
}

export type CompletionCallback = (upload: CompletionNotification) => Promise<CompletionResult | void>;

const locks = new Map<string, Promise<unknown>>();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function assertFutureExpiry(value: unknown): asserts value is string {
  if (!isIsoTimestamp(value)) throw new UploadError(400, "Invalid upload expiration");
  if (Date.parse(value) <= Date.now()) throw new UploadError(400, "Upload already expired");
}

export function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}

export function assertSessionId(value: string): void {
  if (!isSessionId(value)) throw new UploadError(400, "Invalid upload identifier");
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function equalSha256Hex(left: string, right: string): boolean {
  if (!isSha256Hex(left) || !isSha256Hex(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function withSessionLock<T>(root: string, id: string, operation: () => Promise<T>): Promise<T> {
  const key = `${path.resolve(root)}\0${id.toLowerCase()}`;
  const previous = locks.get(key) ?? Promise.resolve();
  const lockPath = path.join(
    path.resolve(root),
    ".locks",
    `${createHash("sha256").update(id.toLowerCase()).digest("hex")}.lock`,
  );
  const current = previous.catch(() => undefined).then(() => withFileLock(lockPath, operation));
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function hashFile(filePath: string): Promise<{ size: number; checksum: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!Number.isSafeInteger(size + chunk.length)) {
        callback(new UploadError(413, "File exceeds supported size"));
        return;
      }
      size += chunk.length;
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(createReadStream(filePath), sink);
  return { size, checksum: hash.digest("hex") };
}
