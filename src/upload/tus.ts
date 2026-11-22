import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UploadError } from "./chunked";

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
}

export class TusUploadManager {
  constructor(private readonly root: string) {}

  async create(options: TusUploadOptions): Promise<TusUploadSession> {
    if (options.uploadLength !== undefined && (!Number.isSafeInteger(options.uploadLength) || options.uploadLength < 0)) {
      throw new UploadError(400, "Invalid Upload-Length");
    }
    const id = randomUUID();
    const session: TusUploadSession = { ...options, id, offset: 0, createdAt: new Date().toISOString() };
    await mkdir(this.sessionRoot(id), { recursive: true });
    await writeFile(this.payloadPath(id), new Uint8Array(0), { flag: "wx" });
    await this.save(session);
    return session;
  }

  async get(id: string): Promise<TusUploadSession> {
    this.assertId(id);
    try {
      const session = JSON.parse(await readFile(this.sessionPath(id), "utf8")) as TusUploadSession;
      if (new Date(session.expiresAt).getTime() <= Date.now()) throw new UploadError(410, "Upload session expired");
      return session;
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError(404, "Upload session not found");
    }
  }

  async append(id: string, offset: number, stream: Readable, chunkLength?: number): Promise<TusUploadSession> {
    const session = await this.get(id);
    if (offset !== session.offset) throw new UploadError(409, "Upload-Offset does not match");
    if (session.uploadLength === undefined) throw new UploadError(400, "Upload-Length is required before patching");
    const remaining = session.uploadLength - session.offset;
    if (chunkLength !== undefined && chunkLength > remaining) throw new UploadError(413, "Patch exceeds Upload-Length");
    let written = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        written += chunk.length;
        if (written > remaining) callback(new UploadError(413, "Patch exceeds Upload-Length"));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(this.payloadPath(id), { flags: "r+", start: offset }));
      if (chunkLength !== undefined && written !== chunkLength) {
        throw new UploadError(400, "Content-Length does not match patch size");
      }
      session.offset += written;
      await this.save(session);
      return session;
    } catch (error) {
      await truncate(this.payloadPath(id), session.offset).catch(() => undefined);
      throw error;
    }
  }

  async complete(id: string): Promise<{ session: TusUploadSession; stream: Readable; filePath: string }> {
    const session = await this.get(id);
    if (session.uploadLength === undefined || session.offset !== session.uploadLength) {
      throw new UploadError(409, "Upload is incomplete");
    }
    const filePath = this.payloadPath(id);
    return { session, stream: createReadStream(filePath), filePath };
  }

  async terminate(id: string): Promise<void> {
    await this.get(id);
    await rm(this.sessionRoot(id), { recursive: true, force: true });
  }

  async cleanupExpired(now = new Date()): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const session = JSON.parse(await readFile(this.sessionPath(entry.name), "utf8")) as TusUploadSession;
        if (new Date(session.expiresAt) <= now) {
          await rm(this.sessionRoot(entry.name), { recursive: true, force: true });
          removed.push(entry.name);
        }
      } catch {
        continue;
      }
    }
    return removed;
  }

  private async save(session: TusUploadSession): Promise<void> {
    const temporary = `${this.sessionPath(session.id)}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(session), "utf8");
    await rename(temporary, this.sessionPath(session.id));
  }

  private assertId(id: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new UploadError(400, "Invalid upload identifier");
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
