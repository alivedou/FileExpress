import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EngineScanResult, ScanAction, ScanSummary, ScanVerdict } from "./types";

export interface QuarantineRecord {
  fileId: string;
  quarantineId: string;
  reason: string;
  createdAt: string;
  checksum: string;
  released: boolean;
  size?: number;
}
export interface QuarantineStoreOptions {
  restoreRoot?: string;
}

interface StoredValue {
  record: QuarantineRecord;
  summary: ScanSummary;
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const MAX_RECORD_BYTES = 1024 * 1024;

export class FileQuarantineStore {
  private readonly root: string;
  private readonly restoreRoot?: string;
  constructor(root: string, options: QuarantineStoreOptions = {}) {
    this.root = path.resolve(root);
    this.restoreRoot = options.restoreRoot ? path.resolve(options.restoreRoot) : undefined;
  }

  async isolate(fileId: string, stream: Readable, summary: ScanSummary): Promise<QuarantineRecord> {
    validateText(fileId, "file identifier", 1024);
    await this.ensureRoot();
    const allocated = await this.allocate();
    try {
      const payload = await this.writePayload(allocated.directory, stream);
      const record: QuarantineRecord = {
        fileId,
        quarantineId: allocated.id,
        reason: summary.verdict,
        createdAt: new Date().toISOString(),
        checksum: payload.checksum,
        released: false,
        size: payload.size,
      };
      await this.writeRecord(allocated.directory, { record, summary });
      return { ...record };
    } catch (error) {
      await rm(allocated.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(quarantineId: string): Promise<{ record: QuarantineRecord; summary: ScanSummary }> {
    this.assertId(quarantineId);
    await this.ensureRoot();
    const directory = await this.directory(quarantineId);
    const stored = parseStored(await this.readRecord(directory), quarantineId);
    await this.verifyPayload(directory, stored.record);
    return { record: { ...stored.record }, summary: cloneSummary(stored.summary) };
  }

  async release(quarantineId: string): Promise<QuarantineRecord> {
    const value = await this.get(quarantineId);
    value.record.released = true;
    const directory = await this.directory(quarantineId);
    await this.writeRecord(directory, value);
    return { ...value.record };
  }

  async restore(quarantineId: string, destination: string): Promise<QuarantineRecord> {
    const value = await this.get(quarantineId);
    const directory = await this.directory(quarantineId);
    const target = await this.prepareDestination(destination);
    let created = false;
    try {
      const sourceHandle = await open(contained(directory, "payload.bin"), READ_FLAGS);
      try {
        const targetHandle = await open(target, WRITE_FLAGS, 0o600);
        created = true;
        try {
          const hash = createHash("sha256");
          let size = 0;
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          const input = sourceHandle.createReadStream();
          const output = targetHandle.createWriteStream();
          await pipeline(input, meter, output);
          verifyChecksum(hash.digest("hex"), value.record.checksum);
          if (value.record.size !== undefined && value.record.size !== size)
            throw new Error("Quarantine payload size mismatch");
        } finally {
          await closeHandle(targetHandle);
        }
      } finally {
        await closeHandle(sourceHandle);
      }
      value.record.released = true;
      await this.writeRecord(directory, value);
      return { ...value.record };
    } catch (error) {
      if (created) await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async delete(quarantineId: string): Promise<void> {
    this.assertId(quarantineId);
    await this.ensureRoot();
    const directory = await this.directory(quarantineId);
    await rm(directory, { recursive: true, force: false });
  }

  async remove(quarantineId: string): Promise<void> {
    await this.delete(quarantineId);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(this.root)) !== this.root)
      throw new Error("Invalid quarantine root");
    await chmod(this.root, 0o700);
  }

  private async allocate(): Promise<{ id: string; directory: string }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomBytes(32).toString("hex");
      const directory = contained(this.root, id);
      try {
        await mkdir(directory, { recursive: false, mode: 0o700 });
        return { id, directory };
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
      }
    }
    throw new Error("Unable to allocate quarantine identifier");
  }

  private async directory(id: string): Promise<string> {
    this.assertId(id);
    const directory = contained(this.root, id);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Error("Invalid quarantine directory");
    return directory;
  }

  private async writePayload(
    directory: string,
    stream: Readable,
  ): Promise<{ checksum: string; size: number }> {
    const temporary = contained(directory, "payload.tmp");
    const handle = await open(temporary, WRITE_FLAGS, 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const output = handle.createWriteStream();
      await pipeline(stream, meter, output);
    } finally {
      await closeHandle(handle);
    }
    const metadata = await lstat(temporary);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid quarantine payload");
    await rename(temporary, contained(directory, "payload.bin"));
    return { checksum: hash.digest("hex"), size };
  }

  private async verifyPayload(directory: string, record: QuarantineRecord): Promise<void> {
    const handle = await open(contained(directory, "payload.bin"), READ_FLAGS);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid quarantine payload");
      if (record.size !== undefined && (!Number.isSafeInteger(record.size) || metadata.size !== record.size))
        throw new Error("Quarantine payload size mismatch");
      const input = handle.createReadStream();
      for await (const raw of input) {
        const value: unknown = raw;
        if (!(value instanceof Uint8Array)) throw new Error("Invalid quarantine payload stream");
        size += value.length;
        hash.update(value);
      }
    } finally {
      await closeHandle(handle);
    }
    if (record.size !== undefined && size !== record.size)
      throw new Error("Quarantine payload size mismatch");
    verifyChecksum(hash.digest("hex"), record.checksum);
  }

  private async readRecord(directory: string): Promise<unknown> {
    const handle = await open(contained(directory, "record.json"), READ_FLAGS);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES)
        throw new Error("Invalid quarantine record");
      const text = await handle.readFile({ encoding: "utf8" });
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("Invalid quarantine record JSON");
      }
    } finally {
      await closeHandle(handle);
    }
  }

  private async writeRecord(directory: string, value: StoredValue): Promise<void> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES)
      throw new Error("Quarantine record exceeds configured size limit");
    const temporary = contained(directory, `.record-${randomBytes(12).toString("hex")}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, WRITE_FLAGS, 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await closeHandle(handle);
      handle = undefined;
      await rename(temporary, contained(directory, "record.json"));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (handle) await closeHandle(handle);
    }
  }

  private async prepareDestination(destination: string): Promise<string> {
    if (!destination || destination.includes("\0")) throw new Error("Invalid restore destination");
    const target = path.resolve(destination);
    const parent = path.dirname(target);
    if (target === parent) throw new Error("Invalid restore destination");
    if (this.restoreRoot) {
      await mkdir(this.restoreRoot, { recursive: true, mode: 0o700 });
      assertContained(this.restoreRoot, target);
    }
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(parent)) !== parent)
      throw new Error("Invalid restore destination directory");
    if (this.restoreRoot && (await realpath(this.restoreRoot)) !== this.restoreRoot)
      throw new Error("Invalid restore root");
    assertContained(parent, target);
    try {
      await lstat(target);
      throw new Error("Restore destination already exists");
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    return target;
  }

  private assertId(id: string): void {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid quarantine identifier");
  }
}

function parseStored(value: unknown, expectedId: string): StoredValue {
  if (!isRecord(value) || !isRecord(value.record) || !isRecord(value.summary))
    throw new Error("Invalid quarantine record");
  const source = value.record;
  if (
    source.quarantineId !== expectedId ||
    typeof source.quarantineId !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.quarantineId)
  )
    throw new Error("Invalid quarantine record identifier");
  if (typeof source.fileId !== "string") throw new Error("Invalid quarantine record file identifier");
  validateText(source.fileId, "file identifier", 1024);
  if (typeof source.reason !== "string") throw new Error("Invalid quarantine record reason");
  validateText(source.reason, "quarantine reason", 128);
  if (typeof source.createdAt !== "string" || !validDate(source.createdAt))
    throw new Error("Invalid quarantine record timestamp");
  if (typeof source.checksum !== "string" || !/^[a-f0-9]{64}$/.test(source.checksum))
    throw new Error("Invalid quarantine record checksum");
  if (typeof source.released !== "boolean") throw new Error("Invalid quarantine release state");
  if (
    source.size !== undefined &&
    (typeof source.size !== "number" || !Number.isSafeInteger(source.size) || source.size < 0)
  )
    throw new Error("Invalid quarantine payload size");
  const record: QuarantineRecord = {
    fileId: source.fileId,
    quarantineId: source.quarantineId,
    reason: source.reason,
    createdAt: source.createdAt,
    checksum: source.checksum,
    released: source.released,
    ...(source.size !== undefined ? { size: source.size } : {}),
  };
  return { record, summary: parseSummary(value.summary) };
}

function parseSummary(value: Record<string, unknown>): ScanSummary {
  if (typeof value.fileId !== "string") throw new Error("Invalid scan summary file identifier");
  validateText(value.fileId, "file identifier", 1024);
  if (
    typeof value.verdict !== "string" ||
    !["clean", "suspicious", "malicious", "error", "pending"].includes(value.verdict)
  )
    throw new Error("Invalid scan summary verdict");
  if (
    typeof value.action !== "string" ||
    !["accept", "review", "quarantine", "reject"].includes(value.action)
  )
    throw new Error("Invalid scan summary action");
  if (!Array.isArray(value.results) || value.results.length > 10_000)
    throw new Error("Invalid scan summary results");
  if (
    typeof value.startedAt !== "string" ||
    !validDate(value.startedAt) ||
    typeof value.completedAt !== "string" ||
    !validDate(value.completedAt)
  )
    throw new Error("Invalid scan summary timestamps");
  if (
    value.checksum !== undefined &&
    (typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum))
  )
    throw new Error("Invalid scan summary checksum");
  if (value.whitelisted !== undefined && typeof value.whitelisted !== "boolean")
    throw new Error("Invalid scan summary whitelist state");
  return {
    fileId: value.fileId,
    verdict: value.verdict as ScanSummary["verdict"],
    action: value.action as ScanAction,
    results: value.results.map(parseEngineResult),
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    ...(value.checksum !== undefined ? { checksum: value.checksum } : {}),
    ...(value.whitelisted !== undefined ? { whitelisted: value.whitelisted } : {}),
  };
}

function parseEngineResult(value: unknown): EngineScanResult {
  if (
    !isRecord(value) ||
    typeof value.engine !== "string" ||
    typeof value.verdict !== "string" ||
    !["clean", "suspicious", "malicious", "error"].includes(value.verdict) ||
    !Array.isArray(value.details) ||
    value.details.length > 10_000 ||
    !value.details.every((detail) => typeof detail === "string" && detail.length <= 4096)
  )
    throw new Error("Invalid engine scan result");
  validateText(value.engine, "engine name", 256);
  if (
    value.signatureVersion !== undefined &&
    (typeof value.signatureVersion !== "string" || value.signatureVersion.length > 1024)
  )
    throw new Error("Invalid engine signature version");
  if (
    value.durationMs !== undefined &&
    (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0)
  )
    throw new Error("Invalid engine scan duration");
  return {
    engine: value.engine,
    verdict: value.verdict as ScanVerdict,
    details: [...value.details] as string[],
    ...(value.signatureVersion !== undefined ? { signatureVersion: value.signatureVersion } : {}),
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
  };
}

function cloneSummary(summary: ScanSummary): ScanSummary {
  return {
    ...summary,
    results: summary.results.map((result) => ({ ...result, details: [...result.details] })),
  };
}

async function closeHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if (!isErrorCode(error, "EBADF")) throw error;
  }
}

function verifyChecksum(actual: string, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid quarantine checksum");
  if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex")))
    throw new Error("Quarantine payload checksum mismatch");
}

function contained(root: string, name: string): string {
  const target = path.resolve(root, name);
  assertContained(root, target);
  return target;
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Path escapes configured security boundary");
}

function validateText(value: string, name: string, maximum: number): void {
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Invalid ${name}`);
}

function validDate(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
