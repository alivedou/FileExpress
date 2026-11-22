import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UploadError } from "./errors";
import {
  atomicWriteJson,
  assertFutureExpiry,
  assertSessionId,
  equalSha256Hex,
  hashFile,
  isIsoTimestamp,
  isRecord,
  isSafeInteger,
  isSessionId,
  isSha256Hex,
  withSessionLock,
  type CompletionCallback,
  type CompletionResult,
} from "./shared";

export { UploadError } from "./errors";

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
  completionNotifiedAt?: string;
  completionResult?: CompletionResult;
}

export interface ChunkCompletionOptions {
  finalChecksum?: string;
  onCompleted?: CompletionCallback;
}

type ChunkCompletionInput = ChunkCompletionOptions | CompletionCallback | string;

export class ChunkedUploadManager {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async create(options: ChunkedUploadOptions): Promise<ChunkedUploadSession> {
    this.assertDimensions(options);
    assertFutureExpiry(options.expiresAt);
    const id = randomUUID();
    const session: ChunkedUploadSession = {
      ...options,
      id,
      createdAt: new Date().toISOString(),
      status: "active",
      chunks: {},
    };
    return withSessionLock(this.root, id, async () => {
      try {
        await mkdir(this.partsPath(id), { recursive: true });
        await this.save(session);
        return session;
      } catch (error) {
        await rm(this.sessionRoot(id), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async status(id: string): Promise<ChunkedUploadSession> {
    assertSessionId(id);
    return withSessionLock(this.root, id, async () => {
      const session = await this.load(id);
      this.assertActive(session);
      return session;
    });
  }

  async uploadChunk(
    id: string,
    index: number,
    stream: Readable,
    expectedChecksum?: string,
  ): Promise<ChunkReceipt> {
    assertSessionId(id);
    return withSessionLock(this.root, id, async () => {
      const session = await this.load(id);
      this.assertActive(session);
      if (!isSafeInteger(index) || index >= session.totalChunks) {
        throw new UploadError(400, "Invalid chunk index");
      }
      const previous = session.chunks[String(index)];
      if (previous) {
        if (!expectedChecksum || equalSha256Hex(previous.checksum, expectedChecksum)) return previous;
        throw new UploadError(409, "Chunk already exists with another checksum");
      }
      const maximum = Math.min(session.chunkSize, session.totalSize - index * session.chunkSize);
      const target = this.partPath(id, index);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      let partMoved = false;
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          if (chunk.length > maximum - size) {
            callback(new UploadError(413, "Chunk exceeds expected size"));
            return;
          }
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(stream, meter, createWriteStream(temporary, { flags: "wx" }));
        if (size !== maximum) throw new UploadError(400, "Chunk size does not match expected size");
        const checksum = hash.digest("hex");
        if (expectedChecksum && !equalSha256Hex(checksum, expectedChecksum)) {
          throw new UploadError(422, "Chunk checksum mismatch");
        }
        await rename(temporary, target);
        partMoved = true;
        const receipt = { index, size, checksum };
        session.chunks[String(index)] = receipt;
        await this.save(session);
        return receipt;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (partMoved) await rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async complete(
    id: string,
    input?: ChunkCompletionInput,
    callback?: CompletionCallback,
  ): Promise<{ session: ChunkedUploadSession; stream: Readable; filePath: string }> {
    assertSessionId(id);
    const options = this.completionOptions(input, callback);
    if (options.finalChecksum !== undefined && !isSha256Hex(options.finalChecksum)) {
      throw new UploadError(400, "Invalid final checksum");
    }
    return withSessionLock(this.root, id, async () => {
      const session = await this.load(id);
      if (session.status === "completed") {
        if (options.finalChecksum && !equalSha256Hex(session.finalChecksum ?? "", options.finalChecksum)) {
          throw new UploadError(422, "Final checksum mismatch");
        }
        await this.verifyCompletedPayload(session);
        await rm(this.partsPath(id), { recursive: true, force: true }).catch(() => undefined);
        await this.notify(session, options.onCompleted);
        const filePath = this.finalPath(id);
        return { session, stream: createReadStream(filePath), filePath };
      }

      this.assertActive(session);
      const missing: number[] = [];
      for (let index = 0; index < session.totalChunks; index += 1) {
        if (!session.chunks[String(index)]) missing.push(index);
        if (missing.length === 100) break;
      }
      if (missing.length) throw new UploadError(409, `Missing chunks: ${missing.join(",")}`);

      const filePath = this.finalPath(id);
      const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      const hash = createHash("sha256");
      let totalSize = 0;
      try {
        for (let index = 0; index < session.totalChunks; index += 1) {
          const receipt = session.chunks[String(index)];
          if (!receipt) throw new UploadError(409, `Missing chunks: ${index}`);
          const expectedSize = Math.min(session.chunkSize, session.totalSize - index * session.chunkSize);
          if (receipt.size !== expectedSize)
            throw new UploadError(422, "Chunk size does not match expected size");
          const partHash = createHash("sha256");
          let partSize = 0;
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, transformCallback) {
              if (chunk.length > expectedSize - partSize) {
                transformCallback(new UploadError(422, "Chunk size does not match expected size"));
                return;
              }
              partSize += chunk.length;
              totalSize += chunk.length;
              partHash.update(chunk);
              hash.update(chunk);
              transformCallback(null, chunk);
            },
          });
          await pipeline(
            createReadStream(this.partPath(id, index)),
            meter,
            createWriteStream(temporary, { flags: index === 0 ? "wx" : "a" }),
          );
          if (partSize !== expectedSize || partSize !== receipt.size) {
            throw new UploadError(422, "Chunk size does not match expected size");
          }
          if (!equalSha256Hex(partHash.digest("hex"), receipt.checksum)) {
            throw new UploadError(422, "Chunk checksum mismatch");
          }
        }
        if (totalSize !== session.totalSize) throw new UploadError(422, "Total upload size does not match");
        const checksum = hash.digest("hex");
        if (options.finalChecksum && !equalSha256Hex(checksum, options.finalChecksum)) {
          throw new UploadError(422, "Final checksum mismatch");
        }
        await rename(temporary, filePath);
        session.finalChecksum = checksum;
        session.status = "completed";
        await this.save(session);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rm(filePath, { force: true }).catch(() => undefined);
        throw error;
      }

      await rm(this.partsPath(id), { recursive: true, force: true }).catch(() => undefined);
      await this.notify(session, options.onCompleted);
      return { session, stream: createReadStream(filePath), filePath };
    });
  }

  async discard(id: string): Promise<void> {
    assertSessionId(id);
    await withSessionLock(this.root, id, async () => {
      await rm(this.sessionRoot(id), { recursive: true, force: true });
    });
  }

  async cleanupExpired(now = new Date()): Promise<string[]> {
    if (!Number.isFinite(now.getTime())) throw new UploadError(400, "Invalid cleanup clock");
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSessionId(entry.name)) continue;
      await withSessionLock(this.root, entry.name, async () => {
        try {
          const session = await this.load(entry.name);
          if (Date.parse(session.expiresAt) <= now.getTime()) {
            await rm(this.sessionRoot(entry.name), { recursive: true, force: true });
            removed.push(entry.name);
          }
        } catch {
          return;
        }
      });
    }
    return removed;
  }

  private async load(id: string): Promise<ChunkedUploadSession> {
    try {
      const value: unknown = JSON.parse(await readFile(this.sessionPath(id), "utf8"));
      if (!this.isSession(value, id)) throw new Error("Invalid session");
      return value;
    } catch {
      throw new UploadError(404, "Upload session not found");
    }
  }

  private async save(session: ChunkedUploadSession): Promise<void> {
    await atomicWriteJson(this.sessionPath(session.id), session);
  }

  private async notify(session: ChunkedUploadSession, callback?: CompletionCallback): Promise<void> {
    if (!callback || session.completionNotifiedAt) return;
    const checksum = session.finalChecksum;
    if (!checksum) throw new UploadError(500, "Completed upload checksum is unavailable");
    const result = await callback({
      id: session.id,
      filePath: this.finalPath(session.id),
      fileName: session.fileName,
      mimeType: session.mimeType,
      size: session.totalSize,
      tenantId: session.tenantId,
      checksum,
    });
    if (result) session.completionResult = result;
    session.completionNotifiedAt = new Date().toISOString();
    await this.save(session);
  }

  private async verifyCompletedPayload(session: ChunkedUploadSession): Promise<void> {
    const filePath = this.finalPath(session.id);
    const digest = await hashFile(filePath);
    if (digest.size !== session.totalSize) throw new UploadError(409, "Completed upload size does not match");
    if (!equalSha256Hex(digest.checksum, session.finalChecksum ?? "")) {
      throw new UploadError(422, "Completed upload checksum mismatch");
    }
  }

  private completionOptions(
    input?: ChunkCompletionInput,
    callback?: CompletionCallback,
  ): ChunkCompletionOptions {
    if (typeof input === "string") return { finalChecksum: input, onCompleted: callback };
    if (typeof input === "function") return { onCompleted: input };
    return { ...input, onCompleted: input?.onCompleted ?? callback };
  }

  private assertDimensions(options: ChunkedUploadOptions): void {
    if (
      !isSafeInteger(options.totalSize) ||
      !isSafeInteger(options.chunkSize, 1) ||
      !isSafeInteger(options.totalChunks, 1)
    ) {
      throw new UploadError(400, "Invalid upload dimensions");
    }
    if (options.totalChunks !== Math.max(1, Math.ceil(options.totalSize / options.chunkSize))) {
      throw new UploadError(400, "Chunk count does not match upload size");
    }
  }

  private assertActive(session: ChunkedUploadSession): void {
    if (session.status !== "active") throw new UploadError(409, "Upload is already completed");
    if (Date.parse(session.expiresAt) <= Date.now()) throw new UploadError(410, "Upload session expired");
  }

  private isSession(value: unknown, id: string): value is ChunkedUploadSession {
    if (!isRecord(value) || value.id !== id || !isSessionId(value.id)) return false;
    if (
      typeof value.fileName !== "string" ||
      typeof value.mimeType !== "string" ||
      typeof value.tenantId !== "string"
    )
      return false;
    if (
      !isSafeInteger(value.totalSize) ||
      !isSafeInteger(value.chunkSize, 1) ||
      !isSafeInteger(value.totalChunks, 1)
    )
      return false;
    if (value.totalChunks !== Math.max(1, Math.ceil(value.totalSize / value.chunkSize))) return false;
    if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.expiresAt)) return false;
    if (value.status !== "active" && value.status !== "completed") return false;
    if (value.finalChecksum !== undefined && !isSha256Hex(value.finalChecksum)) return false;
    if (value.status === "completed" && !isSha256Hex(value.finalChecksum)) return false;
    if (value.completionNotifiedAt !== undefined && !isIsoTimestamp(value.completionNotifiedAt)) return false;
    if (
      value.completionResult !== undefined &&
      (!isRecord(value.completionResult) ||
        (value.completionResult.pickupCode !== undefined &&
          (typeof value.completionResult.pickupCode !== "string" ||
            !/^\d{6}$/.test(value.completionResult.pickupCode))))
    )
      return false;
    if (!isRecord(value.chunks)) return false;
    const totalSize = value.totalSize;
    const chunkSize = value.chunkSize;
    const totalChunks = value.totalChunks;
    return Object.entries(value.chunks).every(([key, receipt]) => {
      if (!isRecord(receipt) || !/^\d+$/.test(key) || String(receipt.index) !== key) return false;
      if (!isSafeInteger(receipt.index) || receipt.index >= totalChunks || !isSafeInteger(receipt.size))
        return false;
      if (!isSha256Hex(receipt.checksum)) return false;
      const expectedSize = Math.min(chunkSize, totalSize - receipt.index * chunkSize);
      return receipt.size === expectedSize;
    });
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
