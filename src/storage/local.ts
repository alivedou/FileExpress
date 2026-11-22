import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withStorageLock } from "./concurrency";
import { withFileLock } from "./file-lock";
import type {
  BackendConfig,
  FileMeta,
  HealthStatus,
  ListOpts,
  PresignOpts,
  StorageBackend,
  StorageListPage,
  UploadResult,
} from "./types";
import { readNumberOption, readStringOption } from "./types";
import { safeErrorMessage } from "./utils";

interface LocalMetadata {
  meta: FileMeta;
  checksum: string;
}

export class LocalStorageBackend implements StorageBackend {
  private root = "";
  private secret = "";
  private baseUrl = "";
  private maxFileSize = Number.MAX_SAFE_INTEGER;
  private config: BackendConfig | undefined;

  async init(config: BackendConfig): Promise<void> {
    this.root = path.resolve(readStringOption(config, "root", path.join(process.cwd(), "local_storage")));
    this.secret = readStringOption(config, "signingSecret", "local-development-secret");
    this.baseUrl = readStringOption(config, "baseUrl", "/api/storage/local");
    this.maxFileSize = config.maxFileSize ?? readNumberOption(config, "maxFileSize", Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(this.maxFileSize) || this.maxFileSize < 0)
      throw new Error("Invalid local file size limit");
    this.config = config;
    await mkdir(this.root, { recursive: true });
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    this.assertInitialized();
    const target = this.objectPath(meta.id);
    return withStorageLock(`local:${target}`, () =>
      withFileLock(this.lockPath(target), async () => {
        await mkdir(path.dirname(target), { recursive: true });
        const suffix = `${process.pid}.${randomUUID()}`;
        const temporary = `${target}.${suffix}.tmp`;
        const metadataTarget = this.metadataPath(meta.id);
        const metadataTemporary = `${metadataTarget}.${suffix}.tmp`;
        const blobBackup = `${target}.${suffix}.bak`;
        const metadataBackup = `${metadataTarget}.${suffix}.bak`;
        const hash = createHash("sha256");
        let size = 0;
        let blobMoved = false;
        let metadataMoved = false;
        let oldBlobMoved = false;
        let oldMetadataMoved = false;
        const maximum = this.maxFileSize;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (!Number.isSafeInteger(size) || size > maximum) {
              callback(new Error("Stream exceeds configured size limit"));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        try {
          await pipeline(stream, meter, createWriteStream(temporary, { flags: "wx" }));
          const checksum = hash.digest("hex");
          if (meta.checksum && !equalHashes(meta.checksum, checksum)) {
            throw new Error("Object checksum mismatch");
          }
          const storedMeta: FileMeta = {
            ...meta,
            size,
            checksum,
            backend: "local",
            metadata: { ...meta.metadata },
          };
          await writeJsonAtomic(metadataTemporary, { meta: storedMeta, checksum } satisfies LocalMetadata);
          oldBlobMoved = await moveIfPresent(target, blobBackup);
          oldMetadataMoved = await moveIfPresent(metadataTarget, metadataBackup);
          await rename(temporary, target);
          blobMoved = true;
          await rename(metadataTemporary, metadataTarget);
          metadataMoved = true;
          await Promise.all([
            unlinkIfPresent(blobBackup).catch(() => undefined),
            unlinkIfPresent(metadataBackup).catch(() => undefined),
          ]);
          return { id: meta.id, backend: "local", size, checksum, location: target };
        } catch (error) {
          if (metadataMoved) await unlinkIfPresent(metadataTarget);
          if (blobMoved) await unlinkIfPresent(target);
          if (oldMetadataMoved) await rename(metadataBackup, metadataTarget).catch(() => undefined);
          if (oldBlobMoved) await rename(blobBackup, target).catch(() => undefined);
          await Promise.all([
            unlinkIfPresent(temporary),
            unlinkIfPresent(metadataTemporary),
            unlinkIfPresent(blobBackup),
            unlinkIfPresent(metadataBackup),
          ]);
          throw error;
        }
      }),
    );
  }

  async download(id: string): Promise<Readable> {
    this.assertInitialized();
    const target = this.objectPath(id);
    const stored = await this.readMetadata(id);
    if (stored?.meta.expiresAt && new Date(stored.meta.expiresAt).getTime() <= Date.now())
      throw new Error("Object has expired");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Object is not a file");
    return createReadStream(target);
  }

  async delete(id: string): Promise<void> {
    this.assertInitialized();
    const target = this.objectPath(id);
    await withStorageLock(`local:${target}`, () =>
      withFileLock(this.lockPath(target), async () => {
        await Promise.all([unlinkIfPresent(target), unlinkIfPresent(this.metadataPath(id))]);
      }),
    );
  }

  async exists(id: string): Promise<boolean> {
    this.assertInitialized();
    const stored = await this.readMetadata(id);
    if (stored?.meta.expiresAt && new Date(stored.meta.expiresAt).getTime() <= Date.now()) return false;
    return fileExists(this.objectPath(id));
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    this.assertInitialized();
    this.objectPath(id);
    assertExpiry(opts.expiresIn);
    const expires = Math.floor(Date.now() / 1000) + opts.expiresIn;
    const operation = opts.operation ?? "download";
    const payload = `${id}:${expires}:${operation}`;
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const query = new URLSearchParams({ expires: String(expires), operation, signature });
    return `${this.baseUrl}/${encodeURIComponent(id)}?${query.toString()}`;
  }

  verifyPresignedUrl(id: string, expires: number, operation: string, signature: string): boolean {
    try {
      this.objectPath(id);
      if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
      if (operation !== "download" && operation !== "upload") return false;
      const expected = createHmac("sha256", this.secret)
        .update(`${id}:${expires}:${operation}`)
        .digest("base64url");
      const left = Buffer.from(expected);
      const right = Buffer.from(signature);
      return left.length === right.length && timingSafeEqual(left, right);
    } catch {
      return false;
    }
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    return (await this.listPage(prefix, opts)).files;
  }

  async listPage(prefix: string, opts: ListOpts): Promise<StorageListPage> {
    this.assertInitialized();
    const limit = boundedLimit(opts.limit, 100, 1000);
    const offset = cursorOffset(opts.cursor);
    const names = await this.metadataFiles(this.root);
    const records: FileMeta[] = [];
    for (const name of names) {
      try {
        const record = JSON.parse(await readFile(name, "utf8")) as LocalMetadata;
        if (!record.meta || typeof record.meta.id !== "string") continue;
        if (record.meta.expiresAt && new Date(record.meta.expiresAt).getTime() <= Date.now()) continue;
        const matchesTenant = !opts.tenantId || record.meta.tenantId === opts.tenantId;
        if (matchesTenant && (record.meta.id.startsWith(prefix) || record.meta.name.startsWith(prefix)))
          records.push(record.meta);
      } catch {
        continue;
      }
    }
    const files = records.sort(compareMetadata).slice(offset, offset + limit);
    return { files, ...(offset + limit < records.length ? { nextCursor: String(offset + limit) } : {}) };
  }

  async cleanupExpired(now = new Date()): Promise<string[]> {
    this.assertInitialized();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid cleanup clock");
    const removed: string[] = [];
    for (const name of await this.metadataFiles(this.root)) {
      try {
        const record = JSON.parse(await readFile(name, "utf8")) as LocalMetadata;
        if (record.meta.expiresAt && new Date(record.meta.expiresAt).getTime() <= now.getTime()) {
          await this.delete(record.meta.id);
          removed.push(record.meta.id);
        }
      } catch {
        continue;
      }
    }
    return removed;
  }

  async healthCheck(): Promise<HealthStatus> {
    const started = performance.now();
    const base = {
      backend: this.config?.name ?? "local",
      kind: "local" as const,
      checkedAt: new Date().toISOString(),
    };
    try {
      this.assertInitialized();
      await access(this.root);
      const probe = path.join(this.root, `.health-${process.pid}-${randomUUID()}`);
      const handle = await open(probe, "wx");
      await handle.close();
      await unlink(probe);
      return { ...base, healthy: true, latencyMs: performance.now() - started };
    } catch (error) {
      return {
        ...base,
        healthy: false,
        latencyMs: performance.now() - started,
        message: safeErrorMessage(error),
      };
    }
  }

  private objectPath(id: string): string {
    return this.safePath(id, ".blob");
  }

  private metadataPath(id: string): string {
    return this.safePath(id, ".json");
  }

  private safePath(id: string, suffix: string): string {
    const segments = id.split("/");
    if (
      !id ||
      id.includes("\0") ||
      id.includes("\\") ||
      path.isAbsolute(id) ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("Invalid object identifier");
    }
    const target = path.resolve(this.root, `${id}${suffix}`);
    if (!target.startsWith(`${this.root}${path.sep}`))
      throw new Error("Object identifier escapes storage root");
    return target;
  }

  private async readMetadata(id: string): Promise<LocalMetadata | undefined> {
    try {
      const value = JSON.parse(await readFile(this.metadataPath(id), "utf8")) as LocalMetadata;
      return value.meta && typeof value.checksum === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async metadataFiles(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) return this.metadataFiles(target);
          return entry.isFile() && entry.name.endsWith(".json") ? [target] : [];
        }),
      );
      return nested.flat();
    } catch {
      return [];
    }
  }

  private lockPath(target: string): string {
    return path.join(this.root, ".locks", `${createHash("sha256").update(target).digest("hex")}.lock`);
  }

  private assertInitialized(): void {
    if (!this.root) throw new Error("Local storage is not initialized");
  }
}

async function writeJsonAtomic(target: string, value: LocalMetadata): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "wx");
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function moveIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function unlinkIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function equalHashes(left: string, right: string): boolean {
  return (
    isSha256(left) && isSha256(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function assertExpiry(expiresIn: number): void {
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > 604800)
    throw new Error("Local URL expiry must be between 1 second and 7 days");
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid list limit");
  return Math.min(limit, maximum);
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error("Invalid list cursor");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid list cursor");
  return offset;
}

function compareMetadata(left: FileMeta, right: FileMeta): number {
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}
