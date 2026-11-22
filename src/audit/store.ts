import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { AUDIT_HASH_PATTERN, AUDIT_ZERO_HASH, canonicalJson, isAuditHash, parseAuditRecord } from "./codec";
import type { AuditArchive, AuditChainHead, AuditRecord, AuditStore, AuditStoreSnapshot } from "./types";

export class AuditStoreConflictError extends Error {
  constructor() {
    super("Audit store changed during write");
    this.name = "AuditStoreConflictError";
  }
}

export class MemoryAuditStore implements AuditStore {
  private state: AuditStoreSnapshot = { records: [], anchor: AUDIT_ZERO_HASH, nextId: 1 };

  constructor(records: readonly AuditRecord[] = []) {
    if (records.length > 0) {
      this.state = normalizeSnapshot({
        records: [...records],
        anchor: records[0]!.previousHash,
        nextId: records.at(-1)!.id + 1,
      });
    }
  }

  load(): AuditRecord[] {
    return this.snapshot().records;
  }

  read(): AuditRecord[] {
    return this.load();
  }

  snapshot(): AuditStoreSnapshot {
    return cloneSnapshot(this.state);
  }

  append(record: AuditRecord, expected?: AuditChainHead): void {
    const parsed = parseAuditRecord(record);
    assertExpected(this.state, expected);
    assertNextRecord(this.state, parsed);
    this.state.records.push(parsed);
    this.state.nextId = parsed.id + 1;
  }

  replace(snapshot: AuditStoreSnapshot, expected?: AuditChainHead): void {
    assertExpected(this.state, expected);
    this.state = normalizeSnapshot(snapshot);
  }
}

export type FileAuditStoreTarget = string | { filePath: string } | { directory: string };

export class FileAuditStore implements AuditStore {
  readonly filePath: string;
  private readonly metadataPath: string;
  private readonly lockPath: string;
  private readonly archivePath: string;

  constructor(target: FileAuditStoreTarget) {
    this.filePath = resolveFilePath(target);
    this.metadataPath = `${this.filePath}.meta.json`;
    this.lockPath = `${this.filePath}.lock`;
    this.archivePath = `${this.filePath}.archives`;
    ensureDirectory(path.dirname(this.filePath));
    ensureRegularFile(this.filePath);
    this.withLock(() => {
      this.recoverIncompleteTail();
      this.readState();
    });
  }

  load(): AuditRecord[] {
    return this.snapshot().records;
  }

  read(): AuditRecord[] {
    return this.load();
  }

  snapshot(): AuditStoreSnapshot {
    return this.withLock(() => {
      this.recoverIncompleteTail();
      return this.readState();
    });
  }

  append(record: AuditRecord, expected?: AuditChainHead): void {
    const parsed = parseAuditRecord(record);
    this.withLock(() => {
      this.recoverIncompleteTail();
      const current = this.readState();
      assertExpected(current, expected);
      assertNextRecord(current, parsed);
      const descriptor = openSync(
        this.filePath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fchmodSync(descriptor, 0o600);
        const bytes = Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
        writeAll(descriptor, bytes);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.writeMetadata({ anchor: current.anchor, nextId: parsed.id + 1 });
    });
  }

  replace(snapshot: AuditStoreSnapshot, expected?: AuditChainHead): void {
    const replacement = normalizeSnapshot(snapshot);
    this.withLock(() => {
      this.recoverIncompleteTail();
      const current = this.readState();
      assertExpected(current, expected);
      this.writeMetadata({ anchor: replacement.anchor, nextId: replacement.nextId });
      try {
        this.atomicWrite(this.filePath, serializeRecords(replacement.records));
        syncDirectory(path.dirname(this.filePath));
      } catch (error) {
        this.writeMetadata({ anchor: current.anchor, nextId: current.nextId });
        throw error;
      }
    });
  }

  writeArchive(archive: AuditArchive): void {
    ensureDirectory(this.archivePath);
    const identifier = randomUUID();
    const recordsPath = path.join(this.archivePath, `${identifier}.jsonl`);
    const manifestPath = path.join(this.archivePath, `${identifier}.manifest.json`);
    this.atomicWrite(recordsPath, serializeRecords(archive.records));
    this.atomicWrite(manifestPath, `${canonicalJson(archive.manifest)}\n`);
    syncDirectory(this.archivePath);
  }

  close(): void {}

  private readState(): AuditStoreSnapshot {
    const records = this.readRecords();
    const metadata = this.readMetadata();
    const derivedNextId = records.length > 0 ? records.at(-1)!.id + 1 : 1;
    if (!metadata) {
      if (records.length === 0 && existsSync(this.archivePath)) {
        throw new Error("Audit retention metadata is missing");
      }
      return normalizeSnapshot({
        records,
        anchor: records[0]?.previousHash ?? AUDIT_ZERO_HASH,
        nextId: derivedNextId,
      });
    }
    if (records.length === 0) return normalizeSnapshot({ records, ...metadata });
    return normalizeSnapshot({ records, anchor: records[0]!.previousHash, nextId: derivedNextId });
  }

  private readRecords(): AuditRecord[] {
    const data = readSecureFile(this.filePath);
    if (data.length === 0) return [];
    if (data[data.length - 1] !== 10) throw new Error("Audit JSONL has an unterminated frame");
    const text = decodeUtf8(data);
    const lines = text.slice(0, -1).split("\n");
    return lines.map((line) => {
      if (line.length === 0) throw new Error("Audit JSONL contains an empty frame");
      return parseJsonRecord(line);
    });
  }

  private recoverIncompleteTail(): void {
    const data = readSecureFile(this.filePath);
    if (data.length === 0 || data[data.length - 1] === 10) return;
    const lastNewline = data.lastIndexOf(10);
    if (lastNewline >= 0) this.readRecordsFromBuffer(data.subarray(0, lastNewline + 1));
    const tail = decodeUtf8(data.subarray(lastNewline + 1));
    if (!tail.startsWith("{") || /[\u0000-\u001f]/.test(tail)) {
      throw new Error("Audit JSONL has an unsafe unterminated frame");
    }
    const descriptor = openSync(this.filePath, constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      ftruncateSync(descriptor, lastNewline + 1);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private readRecordsFromBuffer(data: Buffer): AuditRecord[] {
    if (data.length === 0) return [];
    const text = decodeUtf8(data);
    return text
      .slice(0, -1)
      .split("\n")
      .map((line) => parseJsonRecord(line));
  }

  private readMetadata(): { anchor: string; nextId: number } | null {
    if (!existsSync(this.metadataPath)) return null;
    const value: unknown = JSON.parse(decodeUtf8(readSecureFile(this.metadataPath))) as unknown;
    if (!isPlainObject(value)) throw new Error("Invalid audit metadata");
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "anchor,nextId,version" || value.version !== 1) {
      throw new Error("Invalid audit metadata");
    }
    if (
      !isAuditHash(value.anchor) ||
      !Number.isSafeInteger(value.nextId) ||
      typeof value.nextId !== "number" ||
      value.nextId < 1
    ) {
      throw new Error("Invalid audit metadata");
    }
    return { anchor: value.anchor, nextId: value.nextId };
  }

  private writeMetadata(metadata: { anchor: string; nextId: number }): void {
    this.atomicWrite(this.metadataPath, `${canonicalJson({ version: 1, ...metadata })}\n`);
    syncDirectory(path.dirname(this.filePath));
  }

  private atomicWrite(target: string, contents: string): void {
    if (existsSync(target) && !lstatSync(target).isFile())
      throw new Error("Audit storage path is not a regular file");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      const opened = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      descriptor = opened;
      fchmodSync(opened, 0o600);
      writeAll(opened, Buffer.from(contents, "utf8"));
      fsyncSync(opened);
      closeSync(opened);
      descriptor = undefined;
      renameSync(temporary, target);
      chmodSync(target, 0o600);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private withLock<T>(operation: () => T): T {
    ensureDirectory(path.dirname(this.filePath));
    let descriptor: number;
    try {
      descriptor = openSync(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        removeStaleLock(this.lockPath);
        descriptor = openSync(
          this.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } else {
        throw error;
      }
    }
    try {
      writeAll(descriptor, Buffer.from(`${process.pid}\t${hostname()}\n`, "utf8"));
      fsyncSync(descriptor);
      return operation();
    } finally {
      closeSync(descriptor);
      unlinkSync(this.lockPath);
    }
  }
}

function normalizeSnapshot(snapshot: AuditStoreSnapshot): AuditStoreSnapshot {
  if (!isAuditHash(snapshot.anchor) || !Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < 1) {
    throw new Error("Invalid audit chain state");
  }
  const records = snapshot.records.map((record) => parseAuditRecord(record));
  let previousHash = snapshot.anchor;
  let previousId = 0;
  for (const [index, record] of records.entries()) {
    if (index === 0) {
      if (snapshot.anchor === AUDIT_ZERO_HASH ? record.id !== 1 : record.id < 2) {
        throw new Error("Invalid audit chain start");
      }
    } else if (record.id !== previousId + 1) {
      throw new Error("Audit record IDs are not continuous");
    }
    if (record.previousHash !== previousHash) throw new Error("Audit record anchor mismatch");
    previousHash = record.hash;
    previousId = record.id;
  }
  const expectedNextId = records.length > 0 ? previousId + 1 : snapshot.nextId;
  if (
    snapshot.nextId !== expectedNextId ||
    (records.length === 0 && snapshot.anchor === AUDIT_ZERO_HASH && snapshot.nextId !== 1)
  ) {
    throw new Error("Invalid audit next record ID");
  }
  if (records.length === 0 && snapshot.anchor !== AUDIT_ZERO_HASH && snapshot.nextId < 2) {
    throw new Error("Invalid retained audit anchor");
  }
  return { records, anchor: snapshot.anchor, nextId: snapshot.nextId };
}

function assertNextRecord(snapshot: AuditStoreSnapshot, record: AuditRecord): void {
  const head = chainHead(snapshot);
  if (record.id !== snapshot.nextId || record.previousHash !== head.hash) {
    throw new AuditStoreConflictError();
  }
}

function assertExpected(snapshot: AuditStoreSnapshot, expected?: AuditChainHead): void {
  if (!expected) return;
  const current = chainHead(snapshot);
  if (
    current.anchor !== expected.anchor ||
    current.hash !== expected.hash ||
    current.nextId !== expected.nextId
  ) {
    throw new AuditStoreConflictError();
  }
}

function chainHead(snapshot: AuditStoreSnapshot): AuditChainHead {
  return {
    anchor: snapshot.anchor,
    hash: snapshot.records.at(-1)?.hash ?? snapshot.anchor,
    nextId: snapshot.nextId,
  };
}

function cloneSnapshot(snapshot: AuditStoreSnapshot): AuditStoreSnapshot {
  return {
    records: snapshot.records.map((record) => parseAuditRecord(record)),
    anchor: snapshot.anchor,
    nextId: snapshot.nextId,
  };
}

function serializeRecords(records: readonly AuditRecord[]): string {
  return records.map((record) => `${canonicalJson(parseAuditRecord(record))}\n`).join("");
}

function resolveFilePath(target: FileAuditStoreTarget): string {
  if (typeof target !== "string") {
    return "filePath" in target
      ? path.resolve(target.filePath)
      : path.resolve(target.directory, "audit.jsonl");
  }
  if (existsSync(target)) {
    return statSync(target).isDirectory() ? path.resolve(target, "audit.jsonl") : path.resolve(target);
  }
  return path.extname(target) === "" ? path.resolve(target, "audit.jsonl") : path.resolve(target);
}

function ensureDirectory(directory: string): void {
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Audit data directory is unsafe");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function ensureRegularFile(filePath: string): void {
  if (existsSync(filePath)) {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Audit log path is not a regular file");
  }
  const descriptor = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readSecureFile(filePath: string): Buffer {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseJsonRecord(line: string): AuditRecord {
  try {
    const value: unknown = JSON.parse(line) as unknown;
    const record = parseAuditRecord(value);
    if (canonicalJson(record) !== line) throw new Error("Audit JSONL frame is not canonical");
    return record;
  } catch {
    throw new Error("Audit JSONL contains a corrupt complete frame");
  }
}

function decodeUtf8(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("Audit storage contains invalid UTF-8");
  }
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset);
    if (written <= 0) throw new Error("Unable to write audit data");
    offset += written;
  }
}

function removeStaleLock(lockPath: string): void {
  const stat = lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 1_000) {
    throw new Error("Audit store is locked by another writer");
  }
  let contents = "";
  try {
    contents = readSecureFile(lockPath).toString("utf8");
  } catch {
    throw new Error("Audit store lock is unsafe");
  }
  const [pidText, lockHost] = contents.trim().split("\t");
  const pid = Number(pidText);
  if (lockHost !== hostname() || !Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Audit store is locked by another writer");
  }
  try {
    process.kill(pid, 0);
    throw new Error("Audit store is locked by another writer");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") {
      throw new Error("Audit store is locked by another writer");
    }
  }
  unlinkSync(lockPath);
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isAuditChainHead(value: AuditStoreSnapshot): AuditChainHead {
  return chainHead(value);
}

export { AUDIT_HASH_PATTERN };
