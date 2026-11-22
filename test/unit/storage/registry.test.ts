import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { StorageRegistry } from "../../../src/storage/registry";
import type { BackendConfig, HealthStatus, StorageBackend, UploadResult } from "../../../src/storage/types";
import { backendConfig, fileMeta } from "../../helpers";

function fakeBackend(kind: BackendConfig["kind"], name: string): StorageBackend {
  return {
    init: vi.fn(async () => undefined),
    upload: vi.fn(async (_stream, meta): Promise<UploadResult> => ({ id: meta.id, backend: kind, size: meta.size, checksum: "abc" })),
    download: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(async () => true),
    getPresignedUrl: vi.fn(async () => `https://${name}.test`),
    list: vi.fn(async () => []),
    healthCheck: vi.fn(async (): Promise<HealthStatus> => ({ backend: name, kind, healthy: true, latencyMs: 1, checkedAt: "now" })),
  };
}

describe("StorageRegistry", () => {
  it("registers, routes and fails over using a fresh stream", async () => {
    const registry = new StorageRegistry();
    const primary = fakeBackend("s3", "primary");
    const secondary = fakeBackend("local", "secondary");
    vi.mocked(primary.upload).mockRejectedValueOnce(new Error("offline"));
    await registry.register(primary, { ...backendConfig("s3", "primary"), priority: 1, default: true, options: { token: "secret" } });
    await registry.register(secondary, { ...backendConfig("local", "secondary"), priority: 2 });
    registry.configureRoutes([{ backend: "secondary", mimePattern: "^image/", minSize: 100, maxSize: 1000 }]);
    expect(registry.routeFor(fileMeta({ mimeType: "image/png", size: 100 }))).toEqual(["secondary", "primary"]);
    expect(registry.routeFor(fileMeta({ mimeType: "image/png", size: 99 }))).toEqual(["primary", "secondary"]);
    expect(registry.routeFor(fileMeta({ mimeType: "text/plain", size: 500 }))).toEqual(["primary", "secondary"]);
    let streams = 0;
    const result = await registry.uploadWithFailover(() => { streams += 1; return Readable.from(["data"]); }, fileMeta());
    expect(result.backend).toBe("local");
    expect(streams).toBe(2);
    expect(vi.mocked(secondary.upload)).toHaveBeenCalledWith(expect.any(Readable), expect.objectContaining({ backend: "local" }));
    expect(registry.get()).toBe(primary);
    expect(registry.get("secondary")).toBe(secondary);
    expect(registry.listConfigs()[0]?.options).toEqual({ token: "[REDACTED]" });
    expect(registry.listConfigs()[0]?.options).not.toBe(registry.listConfigs()[0]?.options);
    await expect(registry.healthCheck()).resolves.toEqual([expect.objectContaining({ healthy: true }), expect.objectContaining({ healthy: true })]);
  });

  it("aggregates failures and converts health exceptions", async () => {
    const registry = new StorageRegistry();
    const first = fakeBackend("s3", "first");
    vi.mocked(first.upload).mockRejectedValue(new Error("denied"));
    vi.mocked(first.healthCheck).mockRejectedValue(new Error("timeout"));
    await registry.register(first, backendConfig("s3", "first"));
    await expect(registry.uploadWithFailover(() => Readable.from(["x"]), fileMeta())).rejects.toThrow("All storage backends failed");
    await expect(registry.uploadWithFailover(() => Readable.from(["x"]), fileMeta())).rejects.toSatisfy((error: unknown) => error instanceof AggregateError && error.errors[0] instanceof Error && error.errors[0].message.includes("denied"));
    await expect(registry.healthCheck()).resolves.toEqual([expect.objectContaining({ healthy: false, message: "timeout" })]);
  });

  it("validates duplicate, disabled and unknown backends", async () => {
    const registry = new StorageRegistry();
    const backend = fakeBackend("local", "local");
    await registry.register(backend, backendConfig());
    await expect(registry.register(backend, backendConfig())).rejects.toThrow("already registered");
    expect(() => registry.configureRoutes([{ backend: "unknown" }])).toThrow("unavailable");
    expect(() => registry.configureRoutes([], "unknown")).toThrow("unavailable");
    expect(() => registry.get("unknown")).toThrow("unavailable");
    const disabled = new StorageRegistry();
    await disabled.register(fakeBackend("local", "off"), { ...backendConfig("local", "off"), enabled: false });
    expect(() => disabled.get()).toThrow("unavailable");
    await expect(registry.uploadWithFailover(() => Readable.from(["x"]), fileMeta())).resolves.toMatchObject({ backend: "local" });
  });
});
