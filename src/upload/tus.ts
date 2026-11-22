import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable} from "node:stream";
import { Transform, Writable } from "node:stream";
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

export interface TusUploadOptions {
  fileName: string;
  mimeType: string;
  uploadLength?: number;
  tenantId: string;
  expiresAt: string;
  metadata?: Record<string, string>;
}

export interface TusUploadSession extends TusUploadOptions {
  id: string;
  offset: number;
  createdAt: string;
  completedAt?: string;
  finalChecksum?: string;
  completionNotifiedAt?: string;
  completionResult?: CompletionResult;
  lastPatch?: { offset: number; length: number; checksum: string };
}

export interface TusAppendOptions {
  uploadLength?: number;
  checksum?: string;
}

export interface TusCompletionOptions {
  finalChecksum?: string;
  onCompleted?: CompletionCallback;
}

type TusCompletionInput = TusCompletionOptions | CompletionCallback | string;

export class TusUploadManager {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async create(options: TusUploadOptions): Promise<TusUploadSession> {
    if (options.uploadLength !== undefined && !isSafeInteger(options.uploadLength)) {
      throw new UploadError(400, "Invalid Upload-Length");
    }
    assertFutureExpiry(options.expiresAt);
    const id = randomUUID();
    const session: TusUploadSession = { ...options, id, offset: 0, createdAt: new Date().toISOString() };
    return withSessionLock(this.root, id, async () => {
      try {
        await mkdir(this.sessionRoot(id), { recursive: true });
        await writeFile(this.payloadPath(id), new Uint8Array(0), { flag: "wx" });
        await this.save(session);
        return session;
      } catch (error) {
        await rm(this.sessionRoot(id), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async get(id: string): Promise<TusUploadSession> {
    assertSessionId(id);
    return withSessionLock(this.root, id, async () => {
      const session = await this.load(id);
      this.assertNotExpired(session);
      return session;
    });
  }

  async append(
    id: string,
    offset: number,
    stream: Readable,
    chunkLength?: number,
    options: TusAppendOptions = {},
  ): Promise<TusUploadSession> {
    assertSessionId(id);
    if (!isSafeInteger(offset)) throw new UploadError(400, "Invalid Upload-Offset");
    if (chunkLength !== undefined && !isSafeInteger(chunkLength))
      throw new UploadError(400, "Invalid Content-Length");
    if (options.uploadLength !== undefined && !isSafeInteger(options.uploadLength)) {
      throw new UploadError(400, "Invalid Upload-Length");
    }
    const expectedChecksum =
      options.checksum === undefined ? undefined : this.decodeChecksum(options.checksum);
    return withSessionLock(this.root, id, async () => {
      const session = await this.load(id);
      this.assertNotExpired(session);
      if (offset !== session.offset) {
        if (options.uploadLength !== undefined && options.uploadLength !== session.uploadLength)
          throw new UploadError(400, "Upload-Length conflicts with the upload session");
        return this.replayPatch(session, offset, stream, chunkLength, expectedChecksum);
      }
      let uploadLength = session.uploadLength;
      if (options.uploadLength !== undefined) {
        if (uploadLength !== undefined) throw new UploadError(400, "Upload-Length is already set");
        if (session.offset !== 0)
          throw new UploadError(400, "Upload-Length can only be set on the first patch");
        uploadLength = options.uploadLength;
      }
      if (uploadLength === undefined) throw new UploadError(400, "Upload-Length is required before patching");
      const oldOffset = session.offset;
      const remaining = uploadLength - oldOffset;
      if (chunkLength !== undefined && chunkLength > remaining)
        throw new UploadError(413, "Patch exceeds Upload-Length");
      let written = 0;
      const hash = createHash("sha256");
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          if (chunk.length > remaining - written) {
            callback(new UploadError(413, "Patch exceeds Upload-Length"));
            return;
          }
          written += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await truncate(this.payloadPath(id), oldOffset);
        await pipeline(
          stream,
          meter,
          createWriteStream(this.payloadPath(id), { flags: "r+", start: offset }),
        );
        if (chunkLength !== undefined && written !== chunkLength) {
          throw new UploadError(400, "Content-Length does not match patch size");
        }
        const patchChecksum = hash.digest("hex");
        if (expectedChecksum && !timingSafeEqual(Buffer.from(patchChecksum, "hex"), expectedChecksum)) {
          throw new UploadError(422, "Upload-Checksum mismatch");
        }
        const nextOffset = oldOffset + written;
        await truncate(this.payloadPath(id), nextOffset);
        session.uploadLength = uploadLength;
        session.offset = nextOffset;
        session.lastPatch = { offset: oldOffset, length: written, checksum: patchChecksum };
        await this.save(session);
        return session;
      } catch (error) {
        await truncate(this.payloadPath(id), oldOffset).catch(() => undefined);
        throw error;
      }
    });
  }

  async complete(
    id: string,
    input?: TusCompletionInput,
    callback?: CompletionCallback,
  ): Promise<{ session: TusUploadSession; stream: Readable; filePath: string }> {
    assertSessionId(id);
    const options = this.completionOptions(input, callback);
    if (options.finalChecksum !== undefined && !isSha256Hex(options.finalChecksum)) {
      throw new UploadError(400, "Invalid final checksum");
    }
    return withSessionLock(this.root, id, async () => {
      const session = await this.load(id);
      this.assertNotExpired(session);
      if (session.uploadLength === undefined || session.offset !== session.uploadLength) {
        throw new UploadError(409, "Upload is incomplete");
      }
      const filePath = this.payloadPath(id);
      const digest = await hashFile(filePath);
      if (digest.size !== session.uploadLength) {
        throw new UploadError(409, "Upload payload length does not match Upload-Length");
      }
      const expectedChecksum = options.finalChecksum ?? session.finalChecksum;
      if (expectedChecksum && !equalSha256Hex(digest.checksum, expectedChecksum)) {
        throw new UploadError(422, "Final checksum mismatch");
      }
      let changed = false;
      if (session.finalChecksum !== digest.checksum) {
        session.finalChecksum = digest.checksum;
        changed = true;
      }
      if (!session.completedAt) {
        session.completedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) await this.save(session);
      if (options.onCompleted && !session.completionNotifiedAt) {
        const result = await options.onCompleted({
          id: session.id,
          filePath,
          fileName: session.fileName,
          mimeType: session.mimeType,
          size: session.uploadLength,
          tenantId: session.tenantId,
          checksum: digest.checksum,
        });
        if (result) session.completionResult = result;
        session.completionNotifiedAt = new Date().toISOString();
        await this.save(session);
      }
      return { session, stream: createReadStream(filePath), filePath };
    });
  }

  async terminate(id: string): Promise<void> {
    assertSessionId(id);
    await withSessionLock(this.root, id, async () => {
      const session = await this.load(id);
      this.assertNotExpired(session);
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

  private async load(id: string): Promise<TusUploadSession> {
    try {
      const value: unknown = JSON.parse(await readFile(this.sessionPath(id), "utf8"));
      if (!this.isSession(value, id)) throw new Error("Invalid session");
      return value;
    } catch {
      throw new UploadError(404, "Upload session not found");
    }
  }

  private async save(session: TusUploadSession): Promise<void> {
    await atomicWriteJson(this.sessionPath(session.id), session);
  }

  private async replayPatch(
    session: TusUploadSession,
    offset: number,
    stream: Readable,
    chunkLength: number | undefined,
    expectedChecksum: Buffer | undefined,
  ): Promise<TusUploadSession> {
    const previous = session.lastPatch;
    if (
      !previous ||
      previous.offset !== offset ||
      (chunkLength !== undefined && chunkLength !== previous.length)
    )
      throw new UploadError(409, "Upload-Offset does not match");
    const hash = createHash("sha256");
    let written = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (chunk.length > previous.length - written) {
          callback(new UploadError(409, "Patch does not match the previous patch"));
          return;
        }
        written += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await pipeline(stream, meter, sink);
    const checksum = hash.digest("hex");
    if (written !== previous.length || !equalSha256Hex(checksum, previous.checksum))
      throw new UploadError(409, "Patch does not match the previous patch");
    if (expectedChecksum && !timingSafeEqual(Buffer.from(checksum, "hex"), expectedChecksum))
      throw new UploadError(422, "Upload-Checksum mismatch");
    return session;
  }

  private assertNotExpired(session: TusUploadSession): void {
    if (Date.parse(session.expiresAt) <= Date.now()) throw new UploadError(410, "Upload session expired");
  }

  private decodeChecksum(value: string): Buffer {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new UploadError(400, "Invalid Upload-Checksum");
    const checksum = Buffer.from(value, "base64");
    if (checksum.length !== 32 || checksum.toString("base64") !== value) {
      throw new UploadError(400, "Invalid Upload-Checksum");
    }
    return checksum;
  }

  private completionOptions(input?: TusCompletionInput, callback?: CompletionCallback): TusCompletionOptions {
    if (typeof input === "string") return { finalChecksum: input, onCompleted: callback };
    if (typeof input === "function") return { onCompleted: input };
    return { ...input, onCompleted: input?.onCompleted ?? callback };
  }

  private isSession(value: unknown, id: string): value is TusUploadSession {
    if (!isRecord(value) || value.id !== id || !isSessionId(value.id)) return false;
    if (
      typeof value.fileName !== "string" ||
      typeof value.mimeType !== "string" ||
      typeof value.tenantId !== "string"
    )
      return false;
    if (!isSafeInteger(value.offset) || !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.expiresAt))
      return false;
    if (value.uploadLength !== undefined && !isSafeInteger(value.uploadLength)) return false;
    if (value.uploadLength !== undefined && value.offset > value.uploadLength) return false;
    if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
    if (value.finalChecksum !== undefined && !isSha256Hex(value.finalChecksum)) return false;
    if (value.completionNotifiedAt !== undefined && !isIsoTimestamp(value.completionNotifiedAt)) return false;
    if (
      value.completionResult !== undefined &&
      (!isRecord(value.completionResult) ||
        (value.completionResult.pickupCode !== undefined &&
          (typeof value.completionResult.pickupCode !== "string" ||
            !/^\d{6}$/.test(value.completionResult.pickupCode))))
    )
      return false;
    if (
      value.completedAt !== undefined &&
      (!isSha256Hex(value.finalChecksum) || value.offset !== value.uploadLength)
    )
      return false;
    if (value.lastPatch !== undefined) {
      if (
        !isRecord(value.lastPatch) ||
        !isSafeInteger(value.lastPatch.offset) ||
        !isSafeInteger(value.lastPatch.length) ||
        !isSha256Hex(value.lastPatch.checksum)
      )
        return false;
      if (
        !Number.isSafeInteger(value.lastPatch.offset + value.lastPatch.length) ||
        value.lastPatch.offset + value.lastPatch.length !== value.offset
      )
        return false;
    }
    if (value.metadata !== undefined) {
      if (
        !isRecord(value.metadata) ||
        !Object.values(value.metadata).every((item) => typeof item === "string")
      )
        return false;
    }
    return true;
  }

  private sessionRoot(id: string): string {
    return path.join(this.root, id);
  }

  private sessionPath(id: string): string {
    return path.join(this.sessionRoot(id), "session.json");
  }

  private payloadPath(id: string): string {
    return path.join(this.sessionRoot(id), "payload.bin");
  }
}
