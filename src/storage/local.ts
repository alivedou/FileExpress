import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  BackendConfig,
  FileMeta,
  HealthStatus,
  ListOpts,
  PresignOpts,
  StorageBackend,
  UploadResult,
} from "./types";
import { readNumberOption, readStringOption } from "./types";

interface LocalMetadata {
  meta: FileMeta;
  checksum: string;
}

export class LocalStorageBackend implements StorageBackend {
  private root = "";
  private secret = "";
  private baseUrl = "";
  private config: BackendConfig | undefined;

  async init(config: BackendConfig): Promise<void> {
    this.root = path.resolve(readStringOption(config, "root", path.join(process.cwd(), "local_storage")));
    this.secret = readStringOption(config, "signingSecret", "local-development-secret");
    this.baseUrl = readStringOption(config, "baseUrl", "/api/storage/local");
    this.config = config;
    await mkdir(this.root, { recursive: true });
  }

  async upload(stream: Readable, meta: FileMeta): Promise<UploadResult> {
    const target = this.objectPath(meta.id);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, target);
      const checksum = hash.digest("hex");
      await this.writeMetadata(meta.id, { meta: { ...meta, size }, checksum });
      return { id: meta.id, backend: "local", size, checksum, location: target };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async download(id: string): Promise<Readable> {
    const target = this.objectPath(id);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Object is not a file");
    return createReadStream(target);
  }

  async delete(id: string): Promise<void> {
    await Promise.all([unlink(this.objectPath(id)), unlink(this.metadataPath(id))]);
  }

  async exists(id: string): Promise<boolean> {
    try {
      const info = await stat(this.objectPath(id));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async getPresignedUrl(id: string, opts: PresignOpts): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + opts.expiresIn;
    const operation = opts.operation ?? "download";
    const payload = `${id}:${expires}:${operation}`;
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const query = new URLSearchParams({ expires: String(expires), operation, signature });
    return `${this.baseUrl}/${encodeURIComponent(id)}?${query.toString()}`;
  }

  verifyPresignedUrl(id: string, expires: number, operation: string, signature: string): boolean {
    if (expires < Math.floor(Date.now() / 1000)) return false;
    const expected = createHmac("sha256", this.secret)
      .update(`${id}:${expires}:${operation}`)
      .digest("base64url");
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async list(prefix: string, opts: ListOpts): Promise<FileMeta[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const offset = Number.parseInt(opts.cursor ?? "0", 10) || 0;
    const names = await this.metadataFiles(this.root);
    const records: FileMeta[] = [];
    for (const name of names) {
      const record = JSON.parse(await readFile(name, "utf8")) as LocalMetadata;
      const matchesTenant = !opts.tenantId || record.meta.tenantId === opts.tenantId;
      if (matchesTenant && (record.meta.id.startsWith(prefix) || record.meta.name.startsWith(prefix))) {
        records.push(record.meta);
      }
    }
    return records
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(offset, offset + limit);
  }

  async healthCheck(): Promise<HealthStatus> {
    const started = performance.now();
    const base = {
      backend: this.config?.name ?? "local",
      kind: "local" as const,
      checkedAt: new Date().toISOString(),
    };
    try {
      await access(this.root);
      const probe = path.join(this.root, `.health-${process.pid}`);
      const handle = await open(probe, "w");
      await handle.close();
      await unlink(probe);
      return { ...base, healthy: true, latencyMs: performance.now() - started };
    } catch (error) {
      return {
        ...base,
        healthy: false,
        latencyMs: performance.now() - started,
        message: error instanceof Error ? error.message : "Unknown storage error",
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
    if (!id || id.includes("\0") || id.split("/").includes("..") || path.isAbsolute(id)) {
      throw new Error("Invalid object identifier");
    }
    const target = path.resolve(this.root, `${id}${suffix}`);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Object identifier escapes storage root");
    }
    return target;
  }

  private async writeMetadata(id: string, value: LocalMetadata): Promise<void> {
    const target = this.metadataPath(id);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }

  private async metadataFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return this.metadataFiles(target);
        return entry.isFile() && entry.name.endsWith(".json") ? [target] : [];
      }),
    );
    return nested.flat();
  }
}
