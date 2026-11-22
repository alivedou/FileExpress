import type { Readable } from "node:stream";

export type BackendKind = "local" | "s3" | "azure" | "db" | "ipfs";

export interface BackendConfig {
  name: string;
  kind: BackendKind;
  enabled: boolean;
  priority: number;
  default?: boolean;
  maxFileSize?: number;
  mimePatterns?: string[];
  options: Record<string, unknown>;
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  tenantId?: string;
  ownerId?: string;
  checksum?: string;
  backend?: BackendKind;
  versionId?: string;
  createdAt: string;
  expiresAt?: string;
  metadata: Record<string, string>;
}

export interface UploadResult {
  id: string;
  backend: BackendKind;
  backendName?: string;
  size: number;
  checksum: string;
  versionId?: string;
  location?: string;
}

export interface PresignOpts {
  expiresIn: number;
  operation?: "download" | "upload";
  contentType?: string;
  versionId?: string;
}

export interface ListOpts {
  limit?: number;
  cursor?: string;
  tenantId?: string;
}

export interface StorageListPage {
  files: FileMeta[];
  nextCursor?: string;
}

export interface HealthStatus {
  backend: string;
  kind: BackendKind;
  healthy: boolean;
  latencyMs: number;
  message?: string;
  checkedAt: string;
}

export interface StorageBackend {
  init(config: BackendConfig): Promise<void>;
  upload(stream: Readable, meta: FileMeta): Promise<UploadResult>;
  download(id: string): Promise<Readable>;
  delete(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
  getPresignedUrl(id: string, opts: PresignOpts): Promise<string>;
  list(prefix: string, opts: ListOpts): Promise<FileMeta[]>;
  listPage?(prefix: string, opts: ListOpts): Promise<StorageListPage>;
  healthCheck(): Promise<HealthStatus>;
}

export interface StorageRoute {
  backend: string;
  mimePattern?: string;
  minSize?: number;
  maxSize?: number;
}

export function readStringOption(config: BackendConfig, key: string, fallback = ""): string {
  const value = config.options[key];
  return typeof value === "string" ? value : fallback;
}

export function readNumberOption(config: BackendConfig, key: string, fallback: number): number {
  const value = config.options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
