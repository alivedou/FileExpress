import type { BackendKind } from "./storage/types";

export interface AppConfig {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  DATA_DIR: string;
  STORAGE_BACKEND: BackendKind;
  STORAGE_BACKENDS?: string;
  MAX_CHUNK_SIZE_MB: number;
  MAX_CONCURRENT_CHUNKS: number;
  UPLOAD_EXPIRY_HOURS: number;
  MAX_SINGLE_FILE_SIZE_MB: number;
  MAX_ZIP_PAYLOAD_SIZE_MB: number;
  MAX_TOTAL_STORAGE_MB: number;
  MAX_STORAGE_HOURS: number;
  MAX_DOWNLOADS: number;
  LARGE_FILE_THRESHOLD_MB: number;
  STORAGE_ENCRYPTION_KEY?: string;
  WEBHOOK_SIGNING_SECRET?: string;
  REDIS_URL?: string;
  DATABASE_URL?: string;
  OTEL_SERVICE_NAME: string;
}

const backends: readonly BackendKind[] = ["local", "s3", "azure", "db", "ipfs"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) throw new Error("Invalid NODE_ENV");
  const backend = env.STORAGE_BACKEND ?? "local";
  if (!backends.includes(backend as BackendKind)) throw new Error("Invalid STORAGE_BACKEND");
  validateSecret(env.STORAGE_ENCRYPTION_KEY, "STORAGE_ENCRYPTION_KEY");
  validateSecret(env.WEBHOOK_SIGNING_SECRET, "WEBHOOK_SIGNING_SECRET");
  if (env.REDIS_URL !== undefined) new URL(env.REDIS_URL);
  return {
    NODE_ENV: nodeEnv as AppConfig["NODE_ENV"],
    PORT: positiveInteger(env.PORT, 3000, "PORT"),
    DATA_DIR: nonEmpty(env.DATA_DIR, process.cwd(), "DATA_DIR"),
    STORAGE_BACKEND: backend as BackendKind,
    ...(env.STORAGE_BACKENDS === undefined ? {} : { STORAGE_BACKENDS: env.STORAGE_BACKENDS }),
    MAX_CHUNK_SIZE_MB: positiveInteger(env.MAX_CHUNK_SIZE_MB, 8, "MAX_CHUNK_SIZE_MB"),
    MAX_CONCURRENT_CHUNKS: positiveInteger(env.MAX_CONCURRENT_CHUNKS, 3, "MAX_CONCURRENT_CHUNKS"),
    UPLOAD_EXPIRY_HOURS: positiveInteger(env.UPLOAD_EXPIRY_HOURS, 24, "UPLOAD_EXPIRY_HOURS"),
    MAX_SINGLE_FILE_SIZE_MB: positiveInteger(env.MAX_SINGLE_FILE_SIZE_MB, 10, "MAX_SINGLE_FILE_SIZE_MB"),
    MAX_ZIP_PAYLOAD_SIZE_MB: positiveInteger(env.MAX_ZIP_PAYLOAD_SIZE_MB, 50, "MAX_ZIP_PAYLOAD_SIZE_MB"),
    MAX_TOTAL_STORAGE_MB: positiveInteger(env.MAX_TOTAL_STORAGE_MB, 1024, "MAX_TOTAL_STORAGE_MB"),
    MAX_STORAGE_HOURS: positiveInteger(env.MAX_STORAGE_HOURS, 24, "MAX_STORAGE_HOURS"),
    MAX_DOWNLOADS: positiveInteger(env.MAX_DOWNLOADS, 100, "MAX_DOWNLOADS"),
    LARGE_FILE_THRESHOLD_MB: positiveInteger(env.LARGE_FILE_THRESHOLD_MB, 100, "LARGE_FILE_THRESHOLD_MB"),
    ...(env.STORAGE_ENCRYPTION_KEY === undefined
      ? {}
      : { STORAGE_ENCRYPTION_KEY: env.STORAGE_ENCRYPTION_KEY }),
    ...(env.WEBHOOK_SIGNING_SECRET === undefined
      ? {}
      : { WEBHOOK_SIGNING_SECRET: env.WEBHOOK_SIGNING_SECRET }),
    ...(env.REDIS_URL === undefined ? {} : { REDIS_URL: env.REDIS_URL }),
    ...(env.DATABASE_URL === undefined ? {} : { DATABASE_URL: env.DATABASE_URL }),
    OTEL_SERVICE_NAME: nonEmpty(env.OTEL_SERVICE_NAME, "fileexpress", "OTEL_SERVICE_NAME"),
  };
}

export function enabledStorageBackends(config: AppConfig): BackendKind[] {
  const configured =
    config.STORAGE_BACKENDS?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  for (const item of configured) {
    if (!backends.includes(item as BackendKind)) throw new Error(`Invalid storage backend: ${item}`);
  }
  return [...new Set([config.STORAGE_BACKEND, ...configured])] as BackendKind[];
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonEmpty(value: string | undefined, fallback: string, name: string): string {
  const result = value ?? fallback;
  if (!result.trim()) throw new Error(`${name} must not be empty`);
  return result;
}

function validateSecret(value: string | undefined, name: string): void {
  if (value !== undefined && value.length < 32)
    throw new Error(`${name} must contain at least 32 characters`);
}
