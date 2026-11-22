import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ChunkedUploadManager } from "../../../src/upload/chunked";
import type { UploadError } from "../../../src/upload/chunked";
import { temporaryDirectory } from "../../helpers";

const expiry = () => new Date(Date.now() + 60_000).toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function managerWithSession(
  totalSize = 6,
  chunkSize = 4,
): Promise<{ manager: ChunkedUploadManager; id: string }> {
  const manager = new ChunkedUploadManager(await temporaryDirectory("chunks"));
  const session = await manager.create({
    fileName: "a.txt",
    mimeType: "text/plain",
    totalSize,
    chunkSize,
    totalChunks: Math.max(1, Math.ceil(totalSize / chunkSize)),
    tenantId: "t",
    expiresAt: expiry(),
  });
  return { manager, id: session.id };
}

describe("ChunkedUploadManager", () => {
  it("resumes chunks, verifies hashes and merges in order exactly once", async () => {
    const { manager, id } = await managerWithSession();
    const receipt = await manager.uploadChunk(id, 1, Readable.from(["ef"]), hash("ef"));
    expect(receipt).toEqual({ index: 1, size: 2, checksum: hash("ef") });
    await expect(manager.uploadChunk(id, 1, Readable.from(["ignored"]), hash("ef"))).resolves.toEqual(
      receipt,
    );
    await expect(manager.uploadChunk(id, 1, Readable.from(["xx"]), hash("xx"))).rejects.toMatchObject({
      status: 409,
    });
    await expect(manager.complete(id)).rejects.toThrow("Missing chunks: 0");
    await manager.uploadChunk(id, 0, Readable.from(["ab", "cd"]), hash("abcd"));
    const completed = await manager.complete(id);
    expect(completed.session.finalChecksum).toBe(hash("abcdef"));
    await expect(readFile(completed.filePath, "utf8")).resolves.toBe("abcdef");
    const again = await manager.complete(id);
    await expect(readFile(again.filePath, "utf8")).resolves.toBe("abcdef");
    expect(again.stream).toBeDefined();
    completed.stream.destroy();
    again.stream.destroy();
    await expect(manager.status(id)).rejects.toMatchObject({ status: 409 });
    await manager.discard(id);
    await expect(manager.status(id)).rejects.toMatchObject({ status: 404 });
  });

  it("handles empty files and rejects invalid sessions and chunks", async () => {
    const { manager, id } = await managerWithSession(0, 4);
    await manager.uploadChunk(id, 0, Readable.from([]), hash(""));
    const completed = await manager.complete(id);
    expect(completed.session.finalChecksum).toBe(hash(""));
    completed.stream.destroy();
    await expect(
      manager.create({
        fileName: "x",
        mimeType: "x",
        totalSize: -1,
        chunkSize: 0,
        totalChunks: 0,
        tenantId: "t",
        expiresAt: expiry(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      manager.create({
        fileName: "x",
        mimeType: "x",
        totalSize: 5,
        chunkSize: 4,
        totalChunks: 3,
        tenantId: "t",
        expiresAt: expiry(),
      }),
    ).rejects.toThrow("Chunk count");
    await expect(
      manager.create({
        fileName: "x",
        mimeType: "x",
        totalSize: 5,
        chunkSize: 4,
        totalChunks: 2,
        tenantId: "t",
        expiresAt: new Date(0).toISOString(),
      }),
    ).rejects.toThrow("already expired");
    await expect(manager.uploadChunk("invalid", 0, Readable.from([]))).rejects.toMatchObject({ status: 400 });
    await expect(manager.uploadChunk(crypto.randomUUID(), 0, Readable.from([]))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects out-of-range, wrong-sized, oversized and corrupt chunks without partial files", async () => {
    const { manager, id } = await managerWithSession();
    await expect(manager.uploadChunk(id, -1, Readable.from(["x"]))).rejects.toMatchObject({ status: 400 });
    await expect(manager.uploadChunk(id, 2, Readable.from(["x"]))).rejects.toMatchObject({ status: 400 });
    await expect(manager.uploadChunk(id, 0, Readable.from(["abc"]))).rejects.toThrow("Chunk size");
    await expect(manager.uploadChunk(id, 0, Readable.from(["abcde"]))).rejects.toMatchObject({ status: 413 });
    await expect(manager.uploadChunk(id, 0, Readable.from(["abcd"]), hash("wrong"))).rejects.toMatchObject({
      status: 422,
    });
    await expect(manager.uploadChunk(id, 0, Readable.from(["abcd"]), "invalid")).rejects.toMatchObject({
      status: 422,
    });
    const source = new Readable({
      read() {
        this.destroy(new Error("network"));
      },
    });
    await expect(manager.uploadChunk(id, 0, source)).rejects.toThrow("network");
    expect((await manager.status(id)).chunks).toEqual({});
  });

  it("serialises concurrent writes for one session and cleans expired sessions", async () => {
    const { manager, id } = await managerWithSession(4, 4);
    await Promise.all([
      manager.uploadChunk(id, 0, Readable.from(["abcd"]), hash("abcd")),
      manager.uploadChunk(id, 0, Readable.from(["abcd"]), hash("abcd")),
    ]);
    expect(Object.keys((await manager.status(id)).chunks)).toEqual(["0"]);
    const expired = new ChunkedUploadManager(await temporaryDirectory("expired"));
    const session = await expired.create({
      fileName: "x",
      mimeType: "x",
      totalSize: 1,
      chunkSize: 1,
      totalChunks: 1,
      tenantId: "t",
      expiresAt: expiry(),
    });
    await expect(expired.cleanupExpired(new Date(Date.now() + 120_000))).resolves.toEqual([session.id]);
    await expect(expired.cleanupExpired()).resolves.toEqual([]);
  });

  it("rejects expired active sessions with a specific status", async () => {
    const { manager, id } = await managerWithSession();
    const future = new Date(Date.now() + 120_000);
    await expect(manager.cleanupExpired(future)).resolves.toEqual([id]);
    await expect(manager.status(id)).rejects.toEqual(
      expect.objectContaining<Partial<UploadError>>({ status: 404 }),
    );
  });
});
