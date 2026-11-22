import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AzureBlobStorageBackend, type AzureClientAdapter } from "../../../src/storage/azure";
import { DatabaseBlobStorageBackend, type DatabaseClient, type QueryExecutor } from "../../../src/storage/database";
import { IpfsStorageBackend, type IpfsClientAdapter } from "../../../src/storage/ipfs";
import { S3StorageBackend, type S3ClientAdapter } from "../../../src/storage/s3";
import { backendConfig, fileMeta } from "../../helpers";

function s3Client(): S3ClientAdapter {
  return { putObject: vi.fn(async () => ({ versionId: "v1" })), getObject: vi.fn(async () => ({ body: Readable.from(["ok"]) })), deleteObject: vi.fn(async () => undefined), headObject: vi.fn(async () => true), listObjects: vi.fn(async () => [{ key: "root/t/a.txt", size: 2, etag: '"abc"', lastModified: "2026-01-01", metadata: { mimeType: "text/plain" } }]), headBucket: vi.fn(async () => undefined), presign: vi.fn(async () => "https://s3.test/signed"), createMultipartUpload: vi.fn(async () => "upload-1"), uploadPart: vi.fn(async () => "etag"), completeMultipartUpload: vi.fn(async () => ({ versionId: "v2" })), abortMultipartUpload: vi.fn(async () => undefined) };
}
const s3Options = { bucket: "bucket", prefix: "root", partSize: 5 * 1048576, multipartThreshold: 10 };

describe("S3StorageBackend", () => {
  it("uses put for small objects and exposes object operations", async () => {
    const client = s3Client(); const backend = new S3StorageBackend(client);
    await backend.init({ ...backendConfig("s3"), options: s3Options });
    await expect(backend.upload(Readable.from(["ab"]), fileMeta({ id: "t/a.txt", size: 2 }))).resolves.toMatchObject({ backend: "s3", size: 2, versionId: "v1", checksum: createHash("sha256").update("ab").digest("hex") });
    expect(client.putObject).toHaveBeenCalledWith(expect.objectContaining({ bucket: "bucket", key: "root/t/a.txt", contentType: "text/plain" }));
    expect(await backend.download("t/a.txt")).toBeInstanceOf(Readable);
    await expect(backend.exists("t/a.txt")).resolves.toBe(true);
    await expect(backend.getPresignedUrl("t/a.txt", { expiresIn: 60 })).resolves.toBe("https://s3.test/signed");
    await expect(backend.list("a", { tenantId: "t", cursor: "next" })).resolves.toEqual([expect.objectContaining({ id: "t/a.txt", checksum: "abc" })]);
    await backend.delete("t/a.txt");
    expect(client.deleteObject).toHaveBeenCalledWith("bucket", "root/t/a.txt");
    expect(await backend.healthCheck()).toMatchObject({ healthy: true });
  });
  it("uploads multipart content and aborts failed transfers", async () => {
    const client = s3Client(); const backend = new S3StorageBackend(client);
    await backend.init({ ...backendConfig("s3"), options: { ...s3Options, multipartThreshold: 1 } });
    const result = await backend.upload(Readable.from(["abcdef"]), fileMeta({ size: 6 }));
    expect(result).toMatchObject({ size: 6, versionId: "v2" });
    expect(client.uploadPart).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "upload-1", index: 1 }));
    expect(client.completeMultipartUpload).toHaveBeenCalledWith(expect.objectContaining({ parts: [{ index: 1, etag: "etag" }] }));
    vi.mocked(client.uploadPart).mockRejectedValueOnce(new Error("part failed"));
    await expect(backend.upload(Readable.from(["abcdef"]), fileMeta({ size: 6 }))).rejects.toThrow("part failed");
    expect(client.abortMultipartUpload).toHaveBeenCalledWith({ bucket: "bucket", key: "root/tenant/file.txt", uploadId: "upload-1" });
  });
  it("validates settings, URLs and identifiers", async () => {
    const backend = new S3StorageBackend(s3Client());
    await expect(backend.init({ ...backendConfig("s3"), options: {} })).rejects.toThrow("S3 bucket is required");
    await backend.init({ ...backendConfig("s3"), options: { ...s3Options, partSize: 1 } }).catch((error: unknown) => expect(error).toEqual(new Error("S3 multipart part size must be at least 5 MiB")));
    await expect(backend.getPresignedUrl("a", { expiresIn: 0 })).rejects.toThrow("expiry");
    await expect(backend.exists("../bad")).rejects.toThrow("Invalid object identifier");
  });
});

describe("AzureBlobStorageBackend", () => {
  function azureClient(): AzureClientAdapter {
    return { upload: vi.fn(async () => ({ versionId: "a1" })), download: vi.fn(async () => Readable.from(["azure"])), delete: vi.fn(async () => undefined), exists: vi.fn(async () => true), list: vi.fn(async () => [{ name: "p/t/a", size: 2, contentType: "text/plain", createdAt: "now" }]), presign: vi.fn(async () => "https://blob.test/p/t/a?sig=1"), probe: vi.fn(async () => undefined), stageBlock: vi.fn(async () => undefined), commitBlocks: vi.fn(async () => ({ versionId: "a2" })) };
  }
  it("supports immutable uploads, block commits and CDN URLs", async () => {
    const client = azureClient(); const backend = new AzureBlobStorageBackend(client);
    await backend.init({ ...backendConfig("azure"), options: { container: "c", prefix: "p", immutableUntil: "2027-01-01", cdnBaseUrl: "https://cdn.test", hierarchical: true, multipartThreshold: 100 } });
    await expect(backend.upload(Readable.from(["ab"]), fileMeta({ id: "t/a", size: 2 }))).resolves.toMatchObject({ versionId: "a1", size: 2 });
    expect(client.upload).toHaveBeenCalledWith(expect.objectContaining({ immutableUntil: "2027-01-01", name: "p/t/a" }));
    await expect(backend.getPresignedUrl("t/a", { expiresIn: 60 })).resolves.toBe("https://cdn.test/p/t/a?sig=1");
    expect(await backend.list("", { tenantId: "t" })).toEqual([expect.objectContaining({ id: "t/a", mimeType: "text/plain" })]);
    expect(await backend.healthCheck()).toMatchObject({ healthy: true });
    expect(await backend.download("t/a")).toBeInstanceOf(Readable);
    expect(await backend.exists("t/a")).toBe(true);
    await backend.delete("t/a");
  });
  it("uses block blobs over threshold and falls back when unsupported", async () => {
    const client = azureClient(); const backend = new AzureBlobStorageBackend(client);
    await backend.init({ ...backendConfig("azure"), options: { container: "c", multipartThreshold: 1, blockSize: 2 } });
    await expect(backend.upload(Readable.from(["abcde"]), fileMeta({ size: 5 }))).resolves.toMatchObject({ size: 5, versionId: "a2" });
    expect(client.stageBlock).toHaveBeenCalledTimes(3);
    expect(client.commitBlocks).toHaveBeenCalledWith(expect.objectContaining({ blockIds: expect.arrayContaining([expect.any(String)]) }));
    const simple = azureClient(); simple.stageBlock = undefined; simple.commitBlocks = undefined;
    const fallback = new AzureBlobStorageBackend(simple); await fallback.init({ ...backendConfig("azure"), options: { container: "c", multipartThreshold: 1 } });
    await expect(fallback.upload(Readable.from(["abc"]), fileMeta({ size: 3 }))).resolves.toMatchObject({ size: 3 });
  });
});

describe("DatabaseBlobStorageBackend", () => {
  it("executes transactional chunk writes and metadata queries", async () => {
    const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const executor: QueryExecutor = { query: vi.fn(async <Row>(sql: string, parameters: readonly unknown[]) => { queries.push({ sql, parameters }); return { rows: [] as Row[] }; }) };
    const client = { query: executor.query, transaction: vi.fn(async (operation: (executor: QueryExecutor) => Promise<unknown>) => operation(executor)) } as unknown as DatabaseClient;
    const backend = new DatabaseBlobStorageBackend(client);
    await backend.init({ ...backendConfig("db"), options: { chunkSize: 2 } });
    await expect(backend.upload(Readable.from(["abcde"]), fileMeta({ id: "id" }))).resolves.toMatchObject({ id: "id", backend: "db", size: 5 });
    expect(queries.filter((item) => item.sql.includes("INTO fileexpress_objects_chunks"))).toHaveLength(3);
    expect(queries.at(-1)?.parameters).toEqual(["id", 5, createHash("sha256").update("abcde").digest("hex")]);
    expect(await backend.healthCheck()).toMatchObject({ healthy: true });
    expect(await backend.exists("id")).toBe(false);
    expect(await backend.list("", {})).toEqual([]);
    expect(await backend.search("t", "report")).toEqual([]);
    expect(await backend.getPresignedUrl("id", { expiresIn: 30 })).toContain("signature=");
    await backend.delete("id");
  });
  it("reads chunks and wraps upload rollback failures", async () => {
    const transaction = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ sequence: 0, content: Buffer.from("a") }] }), transaction: async (operation: (executor: QueryExecutor) => Promise<unknown>) => operation(transaction) } as unknown as DatabaseClient;
    const backend = new DatabaseBlobStorageBackend(client); await backend.init({ ...backendConfig("db"), options: {} });
    expect(await backend.download("id")).toBeInstanceOf(Readable);
    vi.mocked(transaction.query).mockRejectedValueOnce(new Error("constraint"));
    await expect(backend.upload(Readable.from(["a"]), fileMeta())).rejects.toThrow("rolled back");
    await expect(backend.init({ ...backendConfig("db"), options: { table: "bad;drop" } })).rejects.toThrow("Invalid database table");
  });
});

describe("IpfsStorageBackend", () => {
  it("pins content, resolves CIDs and verifies gateway operations", async () => {
    const client: IpfsClientAdapter = { add: vi.fn(async ({ content }) => { for await (const _chunk of content) { /* consume */ } return { cid: "bafyabcdefghijklmnopqrstuvwxyz", size: 2 }; }), cat: vi.fn(async () => Readable.from(["ipfs"])), unpin: vi.fn(async () => undefined), stat: vi.fn(async () => true), pins: vi.fn(async () => [{ cid: "bafyabcdefghijklmnopqrstuvwxyz", name: "t/a", size: 2, createdAt: "now" }]), gatewayUrl: vi.fn((cid) => `https://ipfs.test/${cid}`), version: vi.fn(async () => undefined) };
    const backend = new IpfsStorageBackend(client); await backend.init({ ...backendConfig("ipfs"), options: {} });
    await expect(backend.upload(Readable.from(["ab"]), fileMeta({ id: "t/a" }))).resolves.toMatchObject({ size: 2, versionId: "bafyabcdefghijklmnopqrstuvwxyz" });
    expect(await backend.list("", { tenantId: "t" })).toEqual([expect.objectContaining({ id: "t/a" })]);
    expect(await backend.getPresignedUrl("t/a", { expiresIn: 30 })).toContain("bafyabcdefghijklmnopqrstuvwxyz?");
    expect(await backend.exists("t/a")).toBe(true);
    expect(await backend.download("t/a")).toBeInstanceOf(Readable);
    await backend.delete("t/a");
    expect(client.unpin).toHaveBeenCalledWith("bafyabcdefghijklmnopqrstuvwxyz");
    expect(await backend.healthCheck()).toMatchObject({ healthy: true });
    await expect(backend.download("unknown")).rejects.toThrow("unknown");
  });
});
