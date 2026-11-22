import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./file-lock";
import type { BackendKind, FileMeta } from "./types";

export interface IpfsMappingRecord {
  id: string;
  cid: string;
  meta: FileMeta;
  checksum: string;
  size: number;
}

const mappingLocks = new Map<string, Promise<void>>();

export function createIpfsMappingRoot(configuredRoot: string, backendName: string): string {
  const nameHash = createHash("sha256").update(backendName).digest("hex");
  return path.resolve(configuredRoot || path.join(process.cwd(), "local_storage", "ipfs-mappings", nameHash));
}

export async function ensureIpfsMappingRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
}

export async function readIpfsMapping(root: string, id: string): Promise<IpfsMappingRecord | undefined> {
  return readRecord(mappingPath(root, id));
}

export async function listIpfsMappings(root: string): Promise<IpfsMappingRecord[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const records: IpfsMappingRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const record = await readRecord(path.join(root, entry.name));
    if (record && mappingPath(root, record.id) === path.join(root, entry.name)) records.push(record);
  }
  return records;
}

export async function writeIpfsMapping(root: string, record: IpfsMappingRecord): Promise<void> {
  await mkdir(root, { recursive: true });
  const target = mappingPath(root, record.id);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function deleteIpfsMapping(root: string, id: string): Promise<void> {
  try {
    await unlink(mappingPath(root, id));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function withIpfsMappingLock<T>(
  root: string,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([root, id]);
  const previous = mappingLocks.get(key) ?? Promise.resolve();
  const lockPath = path.join(root, ".locks", `${createHash("sha256").update(id).digest("hex")}.lock`);
  const run = previous.then(() => withFileLock(lockPath, operation));
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  mappingLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (mappingLocks.get(key) === tail) mappingLocks.delete(key);
  }
}

function mappingPath(root: string, id: string): string {
  return path.join(root, `${createHash("sha256").update(id).digest("hex")}.json`);
}

async function readRecord(target: string): Promise<IpfsMappingRecord | undefined> {
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parseRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function parseRecord(value: unknown): IpfsMappingRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.cid !== "string" ||
    !value.cid ||
    typeof value.checksum !== "string" ||
    !isSize(value.size)
  )
    return undefined;
  const meta = parseFileMeta(value.meta);
  if (!meta || meta.id !== value.id) return undefined;
  return { id: value.id, cid: value.cid, meta, checksum: value.checksum, size: value.size };
}

function parseFileMeta(value: unknown): FileMeta | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isSize(value.size) ||
    typeof value.mimeType !== "string" ||
    typeof value.createdAt !== "string"
  )
    return undefined;
  const metadata = parseStringRecord(value.metadata);
  if (
    !metadata ||
    !optionalString(value.tenantId) ||
    !optionalString(value.ownerId) ||
    !optionalString(value.checksum) ||
    !optionalString(value.versionId) ||
    !optionalString(value.expiresAt) ||
    !optionalBackend(value.backend)
  )
    return undefined;
  return {
    id: value.id,
    name: value.name,
    size: value.size,
    mimeType: value.mimeType,
    createdAt: value.createdAt,
    metadata,
    ...(typeof value.tenantId === "string" ? { tenantId: value.tenantId } : {}),
    ...(typeof value.ownerId === "string" ? { ownerId: value.ownerId } : {}),
    ...(typeof value.checksum === "string" ? { checksum: value.checksum } : {}),
    ...(value.backend ? { backend: value.backend } : {}),
    ...(typeof value.versionId === "string" ? { versionId: value.versionId } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    result[key] = entry;
  }
  return result;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBackend(value: unknown): value is BackendKind | undefined {
  return (
    value === undefined ||
    value === "local" ||
    value === "s3" ||
    value === "azure" ||
    value === "db" ||
    value === "ipfs"
  );
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
