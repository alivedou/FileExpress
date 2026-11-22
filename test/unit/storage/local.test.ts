import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LocalStorageBackend } from "../../../src/storage/local";
import { backendConfig, fileMeta, temporaryDirectory } from "../../helpers";

async function backendAt(root: string): Promise<LocalStorageBackend> {
  const backend = new LocalStorageBackend();
  await backend.init({ ...backendConfig(), options: { root, signingSecret: "test-secret", baseUrl: "https://files.test/local" } });
  return backend;
}

describe("LocalStorageBackend", () => {
  it("streams uploads atomically and round-trips content and metadata", async () => {
    const root = await temporaryDirectory("local");
    const backend = await backendAt(root);
    const result = await backend.upload(Readable.from(["ab", "cd"]), fileMeta());
    expect(result).toMatchObject({ id: "tenant/file.txt", backend: "local", size: 4, checksum: createHash("sha256").update("abcd").digest("hex") });
    await expect(backend.exists(result.id)).resolves.toBe(true);
    await expect(readFile(result.location ?? "", "utf8")).resolves.toBe("abcd");
    const chunks: Buffer[] = [];
    for await (const chunk of await backend.download(result.id)) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe("abcd");
    await expect(backend.list("tenant", { tenantId: "tenant", limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: result.id, size: 4 }),
    ]);
    await backend.delete(result.id);
    await expect(backend.exists(result.id)).resolves.toBe(false);
  });

  it("filters, orders and paginates metadata", async () => {
    const backend = await backendAt(await temporaryDirectory("list"));
    await backend.upload(Readable.from(["a"]), fileMeta({ id: "a", name: "a.txt", createdAt: "2026-01-01" }));
    await backend.upload(Readable.from(["b"]), fileMeta({ id: "b", name: "b.txt", createdAt: "2026-01-02" }));
    await backend.upload(Readable.from(["c"]), fileMeta({ id: "c", name: "c.txt", tenantId: "other" }));
    expect((await backend.list("", { tenantId: "tenant", cursor: "0", limit: 1 })).map((item) => item.id)).toEqual(["b"]);
    expect((await backend.list("", { tenantId: "tenant", cursor: "1", limit: 5000 })).map((item) => item.id)).toEqual(["a"]);
    expect((await backend.list("c", {})).map((item) => item.id)).toEqual(["c"]);
  });

  it("signs URLs and validates expiry, operation and signatures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const backend = await backendAt(await temporaryDirectory("sign"));
    const url = new URL(await backend.getPresignedUrl("a/b", { expiresIn: 60, operation: "upload" }));
    expect(url.origin).toBe("https://files.test");
    const signature = url.searchParams.get("signature") ?? "";
    expect(backend.verifyPresignedUrl("a/b", Number(url.searchParams.get("expires")), "upload", signature)).toBe(true);
    expect(backend.verifyPresignedUrl("a/b", Number(url.searchParams.get("expires")), "download", signature)).toBe(false);
    expect(backend.verifyPresignedUrl("a/b", 1, "upload", signature)).toBe(false);
    expect(backend.verifyPresignedUrl("a/b", Number(url.searchParams.get("expires")), "upload", "bad")).toBe(false);
    vi.useRealTimers();
  });

  it("rejects traversal, missing downloads and directories", async () => {
    const root = await temporaryDirectory("errors");
    const backend = await backendAt(root);
    await expect(backend.upload(Readable.from(["x"]), fileMeta({ id: "../escape" }))).rejects.toThrow("Invalid object identifier");
    await expect(backend.exists("../escape")).rejects.toThrow("Invalid object identifier");
    await expect(backend.exists("missing")).resolves.toBe(false);
    await expect(backend.download("missing")).rejects.toThrow();
    await mkdir(path.join(root, "directory.blob"));
    await expect(backend.download("directory")).rejects.toThrow("Object is not a file");
  });

  it("cleans up temporary data after failed streams and reports health failures", async () => {
    const root = await temporaryDirectory("health");
    const backend = await backendAt(root);
    const failing = new Readable({ read() { this.destroy(new Error("source failed")); } });
    await expect(backend.upload(failing, fileMeta({ id: "failed" }))).rejects.toThrow("source failed");
    await expect(backend.exists("failed")).resolves.toBe(false);
    expect(await backend.healthCheck()).toMatchObject({ healthy: true, backend: "local", kind: "local" });
    await writeFile(root, "", { flag: "w" }).catch(() => undefined);
    const uninitialised = new LocalStorageBackend();
    expect(await uninitialised.healthCheck()).toMatchObject({ healthy: false });
  });

  it("uses defaults and exposes configuration utilities", async () => {
    const root = await temporaryDirectory("defaults");
    const backend = new LocalStorageBackend();
    await backend.init({ ...backendConfig(), options: { root } });
    const url = await backend.getPresignedUrl("id", { expiresIn: 30 });
    expect(url).toContain("/api/storage/local/id?");
    await expect(backend.upload(Readable.from(["x"]), fileMeta({ id: "id" }))).resolves.toMatchObject({ size: 1 });
    const record = JSON.parse(await readFile(path.join(root, "tenant/file.txt.json"), "utf8")) as { meta: { id: string } };
    expect(record.meta.id).toBe("tenant/file.txt");
  });
});
