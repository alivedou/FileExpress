import { randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileMeta } from "./types";

export type CatalogScanStatus = "pending" | "clean" | "quarantined" | "error";

export interface CatalogEntry extends FileMeta {
  backendName: string;
  pickupCode: string;
  downloadCount: number;
  maxDownloads: number;
  expiresAt: string;
  scanStatus: CatalogScanStatus;
  scanDetails: Record<string, unknown>;
  drmPolicyId?: string;
}

interface CatalogData {
  version: 1;
  files: Record<string, CatalogEntry>;
}

export class FileCatalog {
  private readonly ready: Promise<void>;
  private data: CatalogData = { version: 1, files: {} };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.ready = this.load();
  }

  async createUpload(input: {
    meta: FileMeta;
    backendName: string;
    maxDownloads: number;
    expiresAt: string;
    drmPolicyId?: string;
  }): Promise<CatalogEntry> {
    await this.ready;
    return this.exclusive(async () => {
      if (this.data.files[input.meta.id]) throw new Error("File identifier already exists");
      const pickupCode = this.availableCode();
      const entry: CatalogEntry = {
        ...cloneMeta(input.meta),
        backendName: input.backendName,
        pickupCode,
        downloadCount: 0,
        maxDownloads: input.maxDownloads,
        expiresAt: input.expiresAt,
        scanStatus: "pending",
        scanDetails: {},
        ...(input.drmPolicyId ? { drmPolicyId: input.drmPolicyId } : {}),
      };
      validateEntry(entry);
      this.data.files[entry.id] = entry;
      await this.persist();
      return cloneEntry(entry);
    });
  }

  async byId(id: string): Promise<CatalogEntry | undefined> {
    await this.ready;
    const entry = this.data.files[id];
    return entry ? cloneEntry(entry) : undefined;
  }

  async byPickupCode(code: string): Promise<CatalogEntry | undefined> {
    await this.ready;
    const entry = Object.values(this.data.files).find((candidate) => candidate.pickupCode === code);
    return entry ? cloneEntry(entry) : undefined;
  }

  async markScan(
    id: string,
    status: CatalogScanStatus,
    details: Record<string, unknown>,
  ): Promise<CatalogEntry> {
    await this.ready;
    return this.exclusive(async () => {
      const entry = this.require(id);
      entry.scanStatus = status;
      entry.scanDetails = structuredClone(details);
      await this.persist();
      return cloneEntry(entry);
    });
  }

  async consumeDownload(id: string): Promise<CatalogEntry> {
    await this.ready;
    return this.exclusive(async () => {
      const entry = this.require(id);
      if (entry.scanStatus !== "clean")
        throw new CatalogError(409, `File is not available while scan status is ${entry.scanStatus}`);
      if (new Date(entry.expiresAt).getTime() <= Date.now()) throw new CatalogError(410, "File expired");
      if (entry.downloadCount >= entry.maxDownloads) throw new CatalogError(410, "Download limit reached");
      entry.downloadCount += 1;
      await this.persist();
      return cloneEntry(entry);
    });
  }

  async releaseDownload(id: string): Promise<void> {
    await this.ready;
    return this.exclusive(async () => {
      const entry = this.require(id);
      entry.downloadCount = Math.max(0, entry.downloadCount - 1);
      await this.persist();
    });
  }

  async remove(id: string): Promise<CatalogEntry> {
    await this.ready;
    return this.exclusive(async () => {
      const entry = this.require(id);
      delete this.data.files[id];
      await this.persist();
      return cloneEntry(entry);
    });
  }

  async list(tenantId?: string): Promise<CatalogEntry[]> {
    await this.ready;
    return Object.values(this.data.files)
      .filter((entry) => !tenantId || entry.tenantId === tenantId)
      .map(cloneEntry);
  }

  private availableCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomInt(100000, 1000000).toString();
      if (!Object.values(this.data.files).some((entry) => entry.pickupCode === code)) return code;
    }
    throw new Error("Unable to allocate a pickup code");
  }

  private require(id: string): CatalogEntry {
    const entry = this.data.files[id];
    if (!entry) throw new CatalogError(404, "File not found");
    return entry;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation);
    this.queue = result;
    return result;
  }

  private async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.data = parseCatalog(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw new Error("Unable to load file catalog", { cause: error });
    }
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.data)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      throw new Error("Unable to persist file catalog", { cause: error });
    }
  }
}

export class CatalogError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

function parseCatalog(value: unknown): CatalogData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.files))
    throw new Error("Invalid file catalog");
  const files: Record<string, CatalogEntry> = {};
  for (const [id, candidate] of Object.entries(value.files)) {
    if (!isRecord(candidate)) throw new Error("Invalid file catalog entry");
    const entry = candidate as unknown as CatalogEntry;
    validateEntry(entry);
    if (entry.id !== id) throw new Error("File catalog identifier mismatch");
    files[id] = cloneEntry(entry);
  }
  return { version: 1, files };
}

function validateEntry(entry: CatalogEntry): void {
  if (!entry.id || !entry.name || !entry.backendName || !/^\d{6}$/.test(entry.pickupCode))
    throw new Error("Invalid file catalog entry");
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Invalid file size");
  if (!Number.isSafeInteger(entry.downloadCount) || entry.downloadCount < 0)
    throw new Error("Invalid download count");
  if (!Number.isSafeInteger(entry.maxDownloads) || entry.maxDownloads < 1)
    throw new Error("Invalid download limit");
  if (!Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.expiresAt)))
    throw new Error("Invalid file dates");
  if (!["pending", "clean", "quarantined", "error"].includes(entry.scanStatus))
    throw new Error("Invalid scan status");
  if (!isRecord(entry.metadata) || !isRecord(entry.scanDetails)) throw new Error("Invalid file metadata");
}

function cloneMeta(meta: FileMeta): FileMeta {
  return { ...meta, metadata: { ...meta.metadata } };
}

function cloneEntry(entry: CatalogEntry): CatalogEntry {
  return { ...entry, metadata: { ...entry.metadata }, scanDetails: structuredClone(entry.scanDetails) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
