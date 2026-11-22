import { describe, expect, it } from "vitest";
import { enabledStorageBackends, loadConfig } from "../../src/config";

describe("configuration", () => {
  it("loads secure defaults and de-duplicates enabled backends", () => {
    const config = loadConfig({ STORAGE_BACKENDS: "s3, local, ipfs,s3" });
    expect(config).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      STORAGE_BACKEND: "local",
      MAX_CHUNK_SIZE_MB: 8,
      MAX_CONCURRENT_CHUNKS: 3,
      OTEL_SERVICE_NAME: "fileexpress",
    });
    expect(enabledStorageBackends(config)).toEqual(["local", "s3", "ipfs"]);
  });

  it("parses production values and optional secrets", () => {
    const secret = "x".repeat(32);
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8080",
      STORAGE_BACKEND: "s3",
      DATA_DIR: "/data",
      STORAGE_ENCRYPTION_KEY: secret,
      WEBHOOK_SIGNING_SECRET: secret,
      REDIS_URL: "redis://localhost:6379",
      DATABASE_URL: "postgres://db/test",
      MAX_CHUNK_SIZE_MB: "16",
      MAX_CONCURRENT_CHUNKS: "5",
      UPLOAD_EXPIRY_HOURS: "48",
      MAX_SINGLE_FILE_SIZE_MB: "20",
      MAX_ZIP_PAYLOAD_SIZE_MB: "100",
      MAX_TOTAL_STORAGE_MB: "2048",
      MAX_STORAGE_HOURS: "72",
      MAX_DOWNLOADS: "10",
      LARGE_FILE_THRESHOLD_MB: "200",
      OTEL_SERVICE_NAME: "files",
    });
    expect(config).toMatchObject({
      PORT: 8080,
      STORAGE_BACKEND: "s3",
      REDIS_URL: "redis://localhost:6379",
      MAX_CHUNK_SIZE_MB: 16,
      MAX_CONCURRENT_CHUNKS: 5,
      LARGE_FILE_THRESHOLD_MB: 200,
    });
  });

  it.each([
    [{ NODE_ENV: "qa" }, "Invalid NODE_ENV"],
    [{ STORAGE_BACKEND: "ftp" }, "Invalid STORAGE_BACKEND"],
    [{ STORAGE_BACKENDS: "local,ftp" }, "Invalid storage backend"],
    [{ PORT: "0" }, "PORT must be a positive integer"],
    [{ MAX_CHUNK_SIZE_MB: "1.5" }, "MAX_CHUNK_SIZE_MB must be a positive integer"],
    [{ DATA_DIR: " " }, "DATA_DIR must not be empty"],
    [{ STORAGE_ENCRYPTION_KEY: "short" }, "at least 32"],
    [{ WEBHOOK_SIGNING_SECRET: "short" }, "at least 32"],
    [{ REDIS_URL: "not a url" }, "Invalid URL"],
  ])("rejects invalid environment %j", (env, message) => {
    expect(() => enabledStorageBackends(loadConfig(env))).toThrow(message);
  });
});
