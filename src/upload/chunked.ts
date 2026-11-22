import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ChunkedUploadOptions {
  fileName: string;
  mimeType: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  tenantId: string;
  expiresAt: string;
}

export interface ChunkReceipt {
  index: number;
  size: number;
  checksum: string;
}

export interface ChunkedUploadSession extends ChunkedUploadOptions {
  id: string;
  createdAt: string;
  status: "active" | "completed";
  chunks: Record<string, ChunkReceipt>;
  finalChecksum?: string;
}

export class ChunkedUploadManager {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  async create(options: ChunkedUploadOptions): Promise<ChunkedUploadSession> {
    if (options.totalSize < 0 || options.chunkSize <= 0 || options.totalChunks <= 0) {
      throw new UploadError(400, "Invalid upload dimensions");
    }
    if (options.totalChunks !== Math.max(1, Math.ceil(options.totalSize / options.chunkSize))) {
      throw new UploadError(400, "Chunk count does not match upload size");
    }
    if (new Date(options.expiresAt).getTime() <= Date.now()) throw new UploadError(400, "Upload already expired");
    const id = randomUUID();
    const session: ChunkedUploadSession = {
      ...options,
      id,
      createdAt: new Date().toISOString(),
      status: "active",
      chunks: {},
    };
    await mkdir(this.partsPath(id), { recursive: true });
    await this.save(session);
    return session;
  }

  async status(id: string): Promise<ChunkedUploadSession> {
    const session = await this.load(id);
    this.assertActive(session);
    return session;
  }

  async uploadChunk(
    id: string,
    index: number,
    stream: Readable,
    expectedChecksum?: string,
  ): Promise<ChunkReceipt> {
    return this.withLock(id, async () => {
      const session = await this.load(id);
      this.assertActive(session);
      if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
        throw new UploadError(400, "Invalid chunk index");
      }
      const previous = session.chunks[String(index)];
      if (previous) {
        if (!expectedChecksum || this.equalHashes(previous.checksum, expectedChecksum)) return previous;
        throw new UploadError(409, "Chunk already exists with another checksum");
      }
      const maximum = Math.min(session.chunkSize, session.totalSize - index * session.chunkSize);
      const target = this.partPath(id, index);
      const temporary = `${target}.${process.pid}.tmp`;
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          size += chunk.length;
          if (size > maximum) callback(new UploadError(413, "Chunk exceeds expected size"));
          else {
            hash.update(chunk);
            callback(null, chunk);
          }
        },
      });
      try {
        await pipeline(stream, meter, createWriteStream(temporary, { flags: "wx" }));
        if (size !== maximum) throw new UploadError(400, "Chunk size does not match expected size");
        const checksum = hash.digest("hex");
        if (expectedChecksum && !this.equalHashes(checksum, expectedChecksum)) {
          throw new UploadError(422, "Chunk checksum mismatch");
        }
        await rename(temporary, target);
        const receipt = { index, size, checksum };
        session.chunks[String(index)] = receipt;
        await this.save(session);
        return receipt;
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  }

  async complete(id: string): Promise<{ session: ChunkedUploadSession; stream: Readable; filePath: string }> {
    return this.withLock(id, async () => {
      const session = await this.load(id);
      if (session.status === "completed") {
        const filePath = this.finalPath(id);
        await stat(filePath);
        return { session, stream: createReadStream(filePath), filePath };
      }
      const missing = Array.from({ length: session.totalChunks }, (_, index) => index).filter(
        (index) => !session.chunks[String(index)],
      );
      if (missing.length) throw new UploadError(409, `Missing chunks: ${missing.join(",")}`);
      const filePath = this.finalPath(id);
      const handle = await open(filePath, "wx");
      await handle.close();
      const hash = createHash("sha256");
      try {
        for (let index = 0; index < session.totalChunks; index += 1) {
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(createReadStream(this.partPath(id, index)), meter, createWriteStream(filePath, { flags: "a" }));
        }
        session.finalChecksum = hash.digest("hex");
        session.status = "completed";
        await this.save(session);
        await rm(this.partsPath(id), { recursive: true, force: true });
        return { session, stream: createReadStream(filePath), filePath };
      } catch (error) {
        await unlink(filePath).catch(() => undefined);
        throw error;
      }
    });
  }

  async discard(id: string): Promise<void> {
    await rm(this.sessionRoot(id), { recursive: true, force: true });
  }

  async cleanupExpired(now = new Date()): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const session = await this.load(entry.name);
        if (new Date(session.expiresAt) <= now) {
          await this.discard(entry.name);
          removed.push(entry.name);
        }
      } catch {
        continue;
      }
    }
    return removed;
  }

  private async load(id: string): Promise<ChunkedUploadSession> {
    this.assertId(id);
    try {
      return JSON.parse(await readFile(this.sessionPath(id), "utf8")) as ChunkedUploadSession;
    } catch {
      throw new UploadError(404, "Upload session not found");
    }
  }

  private async save(session: ChunkedUploadSession): Promise<void> {
    const temporary = `${this.sessionPath(session.id)}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(session), { encoding: "utf8", flag: "w" });
    await rename(temporary, this.sessionPath(session.id));
  }

  private assertActive(session: ChunkedUploadSession): void {
    if (session.status !== "active") throw new UploadError(409, "Upload is already completed");
    if (new Date(session.expiresAt).getTime() <= Date.now()) throw new UploadError(410, "Upload session expired");
  }

  private assertId(id: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new UploadError(400, "Invalid upload identifier");
  }

  private equalHashes(left: string, right: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  private sessionRoot(id: string): string {
    return path.join(this.root, id);
  }

  private sessionPath(id: string): string {
    return path.join(this.sessionRoot(id), "session.json");
  }

  private partsPath(id: string): string {
    return path.join(this.sessionRoot(id), "parts");
  }

  private partPath(id: string, index: number): string {
    return path.join(this.partsPath(id), `${index}.part`);
  }

  private finalPath(id: string): string {
    return path.join(this.sessionRoot(id), "payload.bin");
  }
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}
