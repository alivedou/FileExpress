import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TusUploadManager } from "../../../src/upload/tus";
import { temporaryDirectory } from "../../helpers";

async function createManager(uploadLength = 4): Promise<{ manager: TusUploadManager; id: string }> {
  const manager = new TusUploadManager(await temporaryDirectory("tus"));
  const session = await manager.create({
    fileName: "a.txt",
    mimeType: "text/plain",
    uploadLength,
    tenantId: "t",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    metadata: { filename: "a.txt" },
  });
  return { manager, id: session.id };
}

describe("TusUploadManager", () => {
  it("creates, appends at the current offset and completes", async () => {
    const { manager, id } = await createManager();
    expect((await manager.get(id)).offset).toBe(0);
    expect(await manager.append(id, 0, Readable.from(["ab"]), 2)).toMatchObject({ offset: 2 });
    expect(await manager.append(id, 2, Readable.from(["cd"]), 2)).toMatchObject({ offset: 4 });
    const complete = await manager.complete(id);
    expect(complete.session.fileName).toBe("a.txt");
    await expect(readFile(complete.filePath, "utf8")).resolves.toBe("abcd");
    complete.stream.destroy();
    await manager.terminate(id);
    await expect(manager.get(id)).rejects.toMatchObject({ status: 404 });
  });

  it("enforces protocol offsets, lengths, identifiers and completion", async () => {
    const { manager, id } = await createManager();
    await expect(manager.complete(id)).rejects.toMatchObject({ status: 409 });
    await expect(manager.append(id, 1, Readable.from(["a"]))).rejects.toMatchObject({ status: 409 });
    await expect(manager.append(id, 0, Readable.from(["abcde"]), 5)).rejects.toMatchObject({ status: 413 });
    await expect(manager.append(id, 0, Readable.from(["abcde"]))).rejects.toMatchObject({ status: 413 });
    await expect(manager.append(id, 0, Readable.from(["ab"]), 3)).rejects.toMatchObject({ status: 400 });
    expect((await manager.get(id)).offset).toBe(0);
    await expect(manager.get("bad")).rejects.toMatchObject({ status: 400 });
    await expect(manager.get(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(
      manager.create({
        fileName: "x",
        mimeType: "x",
        uploadLength: -1,
        tenantId: "t",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      manager.create({
        fileName: "x",
        mimeType: "x",
        uploadLength: 1.5,
        tenantId: "t",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("requires a declared length and propagates stream failures", async () => {
    const manager = new TusUploadManager(await temporaryDirectory("deferred"));
    const session = await manager.create({
      fileName: "x",
      mimeType: "x",
      tenantId: "t",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    await expect(manager.append(session.id, 0, Readable.from(["a"]))).rejects.toMatchObject({ status: 400 });
    const fixed = await createManager();
    const source = new Readable({
      read() {
        this.destroy(new Error("broken stream"));
      },
    });
    await expect(fixed.manager.append(fixed.id, 0, source)).rejects.toThrow("broken stream");
  });

  it("cleans only sessions expired at the supplied clock", async () => {
    const { manager, id } = await createManager();
    await expect(manager.cleanupExpired(new Date())).resolves.toEqual([]);
    await expect(manager.cleanupExpired(new Date(Date.now() + 120_000))).resolves.toEqual([id]);
    await expect(manager.cleanupExpired()).resolves.toEqual([]);
  });

  it("rejects expired sessions before returning metadata", async () => {
    const manager = new TusUploadManager(await temporaryDirectory("expiry"));
    const session = await manager.create({
      fileName: "x",
      mimeType: "x",
      uploadLength: 0,
      tenantId: "t",
      expiresAt: new Date(Date.now() + 10).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(manager.get(session.id)).rejects.toMatchObject({ status: 410 });
    await expect(manager.cleanupExpired()).resolves.toEqual([session.id]);
  });
});
