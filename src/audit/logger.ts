import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { AUDIT_ZERO_HASH, canonicalJson, isAuditHash, parseAuditInput, parseAuditRecord } from "./codec";
import { AuditStoreConflictError, FileAuditStore, MemoryAuditStore, isAuditChainHead } from "./store";
import type {
  AuditArchive,
  AuditArchiveManifest,
  AuditChainHead,
  AuditInput,
  AuditLoggerOptions,
  AuditRecord,
  AuditRetentionResult,
  AuditSearchQuery,
  AuditStore,
  AuditStoreSnapshot,
} from "./types";

const defaultMaximumRecords = 100_000;
const defaultSearchLimit = 100;
const maximumSearchLimit = 10_000;
const queryFields = new Set(["tenantId", "text", "actorId", "action", "from", "to", "limit"]);

export class AuditLogger {
  private readonly signingSecret: string;
  private readonly maxRecords: number;
  private readonly store: AuditStore;
  private records: AuditRecord[] = [];
  private anchor = AUDIT_ZERO_HASH;
  private nextId = 1;

  constructor(
    signingSecret: string,
    options: number | AuditLoggerOptions | AuditStore = defaultMaximumRecords,
    explicitStore?: AuditStore,
  ) {
    if (typeof signingSecret !== "string" || signingSecret.length < 16) {
      throw new Error("Audit signing secret is too short");
    }
    this.signingSecret = signingSecret;
    const configuration = resolveConfiguration(options, explicitStore);
    this.maxRecords = configuration.maxRecords;
    this.store = configuration.store ?? defaultStore();
    this.refresh();
  }

  append(input: AuditInput, timestamp = new Date()): AuditRecord {
    const parsed = parseAuditInput(input);
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Invalid audit timestamp");
    }
    const isoTimestamp = timestamp.toISOString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) this.refresh();
      if (this.records.length >= this.maxRecords) {
        this.refresh();
        if (this.records.length >= this.maxRecords) {
          throw new Error("Audit retention capacity exceeded; export before appending");
        }
      }
      const previousHash = this.records.at(-1)?.hash ?? this.anchor;
      const base: Omit<AuditRecord, "hash"> = {
        ...parsed,
        details: parsed.details ?? {},
        id: this.nextId,
        timestamp: isoTimestamp,
        previousHash,
      };
      const record: AuditRecord = { ...base, hash: this.sign(base) };
      try {
        this.store.append(record, this.head());
      } catch (error) {
        if (error instanceof AuditStoreConflictError) continue;
        throw error;
      }
      this.records.push(parseAuditRecord(record));
      this.nextId += 1;
      return parseAuditRecord(record);
    }
    throw new Error("Audit store is contended; retry the append");
  }

  search(query: AuditSearchQuery): AuditRecord[] {
    const parsed = parseSearchQuery(query);
    this.refresh();
    if (parsed.limit === 0 || (parsed.from && parsed.to && parsed.from > parsed.to)) return [];
    const text = parsed.text?.toLowerCase();
    const results = this.records.filter((record) => {
      const milliseconds = Date.parse(record.timestamp);
      return (
        record.tenantId === parsed.tenantId &&
        (!parsed.actorId || record.actorId === parsed.actorId) &&
        (!parsed.action || record.action === parsed.action) &&
        (!parsed.from || milliseconds >= parsed.from.getTime()) &&
        (!parsed.to || milliseconds <= parsed.to.getTime()) &&
        (!text || canonicalJson(record).toLowerCase().includes(text))
      );
    });
    return results.slice(-parsed.limit).map((record) => parseAuditRecord(record));
  }

  verify(records?: readonly AuditRecord[], anchor?: string): boolean {
    if (records !== undefined) {
      const expectedAnchor =
        anchor ?? (records[0]?.previousHash === this.anchor ? this.anchor : AUDIT_ZERO_HASH);
      return this.verifyRecords(records, expectedAnchor);
    }
    try {
      const snapshot = this.store.snapshot();
      if (!this.verifySnapshot(snapshot)) return false;
      this.adopt(snapshot);
      return true;
    } catch {
      return false;
    }
  }

  purgeBefore(cutoff: Date): { anchor: string; removed: number } {
    const time = validCutoff(cutoff);
    this.refresh();
    const removed = this.records.filter((record) => Date.parse(record.timestamp) < time).length;
    if (removed > 0) {
      throw new Error("Online audit log is append-only; use exportArchive before retention purge");
    }
    return { anchor: this.records.at(-1)?.hash ?? this.anchor, removed: 0 };
  }

  exportArchive(cutoff: Date): AuditArchive {
    const time = validCutoff(cutoff);
    this.refresh();
    return this.createArchive(time, this.archivePrefix(time));
  }

  retainBefore(cutoff: Date): AuditRetentionResult {
    const time = validCutoff(cutoff);
    this.refresh();
    const archived = this.archivePrefix(time);
    const archive = this.createArchive(time, archived);
    if (archived.length === 0) {
      return { removed: 0, anchor: this.records.at(-1)?.hash ?? this.anchor, archive };
    }
    const retained = this.records.slice(archived.length).map((record) => parseAuditRecord(record));
    const replacement: AuditStoreSnapshot = {
      records: retained,
      anchor: archive.anchor,
      nextId: this.nextId,
    };
    const expected = this.head();
    this.store.writeArchive?.(archive);
    this.store.replace(replacement, expected);
    this.adopt(replacement);
    return { removed: archived.length, anchor: archive.anchor, archive };
  }

  close(): void {
    this.store.close?.();
  }

  private refresh(): void {
    const snapshot = this.store.snapshot();
    if (!this.verifySnapshot(snapshot)) throw new Error("Audit chain verification failed");
    this.adopt(snapshot);
  }

  private verifySnapshot(snapshot: AuditStoreSnapshot): boolean {
    if (!Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < 1) return false;
    if (!this.verifyRecords(snapshot.records, snapshot.anchor)) return false;
    if (snapshot.records.length === 0 && snapshot.anchor === AUDIT_ZERO_HASH && snapshot.nextId !== 1) {
      return false;
    }
    if (snapshot.records.length === 0 && snapshot.anchor !== AUDIT_ZERO_HASH && snapshot.nextId < 2) {
      return false;
    }
    const expectedNextId = snapshot.records.length > 0 ? snapshot.records.at(-1)!.id + 1 : snapshot.nextId;
    return snapshot.nextId === expectedNextId;
  }

  private verifyRecords(records: readonly AuditRecord[], anchor: string): boolean {
    if (!Array.isArray(records) || !isAuditHash(anchor)) return false;
    try {
      let previousHash = anchor;
      let previousId = 0;
      for (const [index, supplied] of records.entries()) {
        const record = parseAuditRecord(supplied);
        if (index === 0) {
          if (anchor === AUDIT_ZERO_HASH ? record.id !== 1 : record.id < 2) return false;
        } else if (record.id !== previousId + 1) {
          return false;
        }
        if (!hashesEqual(record.previousHash, previousHash)) return false;
        const { hash, ...base } = record;
        if (!hashesEqual(hash, this.sign(base))) return false;
        previousHash = hash;
        previousId = record.id;
      }
      return true;
    } catch {
      return false;
    }
  }

  private sign(value: Omit<AuditRecord, "hash">): string {
    return createHmac("sha256", this.signingSecret).update(canonicalJson(value), "utf8").digest("hex");
  }

  private createArchive(cutoff: number, records: AuditRecord[]): AuditArchive {
    const copies = records.map((record) => parseAuditRecord(record));
    const merkleRoot = this.merkleRoot(copies.map((record) => record.hash));
    const anchor = copies.at(-1)?.hash ?? this.anchor;
    const manifest: AuditArchiveManifest = {
      version: 1,
      cutoff: new Date(cutoff).toISOString(),
      recordCount: copies.length,
      firstId: copies[0]?.id ?? null,
      lastId: copies.at(-1)?.id ?? null,
      firstHash: copies[0]?.hash ?? null,
      lastHash: copies.at(-1)?.hash ?? null,
      previousAnchor: this.anchor,
      anchor,
      merkleRoot,
    };
    return { records: copies, merkleRoot, anchor, manifest };
  }

  private merkleRoot(hashes: string[]): string {
    let level = [...hashes];
    while (level.length > 1) {
      const next: string[] = [];
      for (let index = 0; index < level.length; index += 2) {
        const left = level[index]!;
        const right = level[index + 1] ?? left;
        next.push(createHmac("sha256", this.signingSecret).update(`${left}:${right}`, "utf8").digest("hex"));
      }
      level = next;
    }
    return level[0] ?? AUDIT_ZERO_HASH;
  }

  private archivePrefix(milliseconds: number): AuditRecord[] {
    const records: AuditRecord[] = [];
    for (const record of this.records) {
      if (Date.parse(record.timestamp) >= milliseconds) break;
      records.push(record);
    }
    return records;
  }

  private head(): AuditChainHead {
    return isAuditChainHead({ records: this.records, anchor: this.anchor, nextId: this.nextId });
  }

  private adopt(snapshot: AuditStoreSnapshot): void {
    this.records = snapshot.records.map((record) => parseAuditRecord(record));
    this.anchor = snapshot.anchor;
    this.nextId = snapshot.nextId;
  }
}

function resolveConfiguration(
  options: number | AuditLoggerOptions | AuditStore,
  explicitStore?: AuditStore,
): { maxRecords: number; store?: AuditStore } {
  if (typeof options === "number") {
    return { maxRecords: validateMaximumRecords(options), store: explicitStore };
  }
  if (isAuditStore(options)) {
    if (explicitStore && explicitStore !== options) throw new Error("Conflicting audit stores");
    return { maxRecords: defaultMaximumRecords, store: options };
  }
  if (!isPlainObject(options)) throw new Error("Invalid audit logger options");
  for (const key of Object.keys(options)) {
    if (key !== "maxRecords" && key !== "store") throw new Error(`Unsupported audit logger option: ${key}`);
  }
  if (options.store !== undefined && !isAuditStore(options.store)) throw new Error("Invalid audit store");
  if (explicitStore && options.store && explicitStore !== options.store)
    throw new Error("Conflicting audit stores");
  return {
    maxRecords: validateMaximumRecords(options.maxRecords ?? defaultMaximumRecords),
    store: options.store ?? explicitStore,
  };
}

function validateMaximumRecords(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Audit retention capacity must be positive");
  }
  return value;
}

function defaultStore(): AuditStore {
  const directory = process.env.AUDIT_DATA_DIR?.trim();
  return directory ? new FileAuditStore(path.resolve(directory, "audit.jsonl")) : new MemoryAuditStore();
}

function isAuditStore(value: unknown): value is AuditStore {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.load === "function" &&
    typeof value.snapshot === "function" &&
    typeof value.append === "function" &&
    typeof value.replace === "function"
  );
}

function parseSearchQuery(
  query: AuditSearchQuery,
): Required<Omit<AuditSearchQuery, "text" | "actorId" | "action" | "from" | "to">> &
  Pick<AuditSearchQuery, "text" | "actorId" | "action" | "from" | "to"> {
  if (!isPlainObject(query)) throw new Error("Audit search query must be an object");
  for (const key of Object.keys(query)) {
    if (!queryFields.has(key)) throw new Error(`Unsupported audit search field: ${key}`);
  }
  if (typeof query.tenantId !== "string" || query.tenantId.length === 0) {
    throw new Error("Invalid audit search tenant");
  }
  for (const field of ["text", "actorId", "action"] as const) {
    if (query[field] !== undefined && typeof query[field] !== "string") {
      throw new Error(`Invalid audit search field: ${field}`);
    }
  }
  if (query.text !== undefined && query.text.length > 1_048_576)
    throw new Error("Audit search text is too long");
  const from = validOptionalDate(query.from, "from");
  const to = validOptionalDate(query.to, "to");
  const limit = query.limit ?? defaultSearchLimit;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid audit search limit");
  return {
    tenantId: query.tenantId,
    text: query.text,
    actorId: query.actorId,
    action: query.action,
    from,
    to,
    limit: Math.min(limit, maximumSearchLimit),
  };
}

function validOptionalDate(value: Date | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Invalid audit search boundary: ${field}`);
  }
  return value;
}

function validCutoff(cutoff: Date): number {
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime()))
    throw new Error("Invalid audit cutoff");
  return cutoff.getTime();
}

function hashesEqual(left: string, right: string): boolean {
  if (!isAuditHash(left) || !isAuditHash(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type {
  AuditArchive,
  AuditArchiveManifest,
  AuditInput,
  AuditLoggerOptions,
  AuditRecord,
  AuditRetentionResult,
  AuditSearchQuery,
  AuditStore,
  AuditStoreSnapshot,
} from "./types";
export { MemoryAuditStore, FileAuditStore, AuditStoreConflictError } from "./store";
