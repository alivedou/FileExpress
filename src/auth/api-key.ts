import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isPermission, type Permission, type Scope } from "./rbac";

export interface ApiKeyScope extends Scope {
  permissions: Permission[];
  requestsPerMinute: number;
}
export interface ApiKeyRecord {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  scope: ApiKeyScope;
  revoked: boolean;
  createdAt: string;
}
export type ApiKeyDto = Omit<ApiKeyRecord, "hash">;
export type ApiKeyPublicRecord = ApiKeyDto;

export const MAX_API_KEY_REQUESTS_PER_MINUTE = 100_000;

interface RateWindow {
  minute: number;
  count: number;
}

export class ApiKeyService {
  private readonly keys = new Map<string, ApiKeyRecord>();
  private readonly hashIndex = new Map<string, string>();
  private readonly windows = new Map<string, RateWindow>();

  issue(name: string, scope: ApiKeyScope, now = new Date()): { secret: string; record: ApiKeyRecord } {
    const normalisedName = keyName(name);
    const normalisedScope = validateScope(scope, now);
    const secret = `fe_${randomBytes(32).toString("base64url")}`;
    const hash = digest(secret);
    if (this.hashIndex.has(hash)) throw new Error("Unable to issue API key");
    const record: ApiKeyRecord = {
      id: randomBytes(16).toString("hex"),
      name: normalisedName,
      hash,
      prefix: secret.slice(0, 11),
      scope: normalisedScope,
      revoked: false,
      createdAt: now.toISOString(),
    };
    if (this.keys.has(record.id)) throw new Error("Unable to issue API key");
    this.keys.set(record.id, record);
    this.hashIndex.set(hash, record.id);
    return { secret, record: structuredClone(record) };
  }

  authenticate(secret: string, permission: Permission, scope: Scope, now = new Date()): ApiKeyRecord {
    if (typeof secret !== "string" || secret.length < 16 || secret.length > 512 || !isRecord(scope))
      throw new Error("Invalid or revoked API key");
    const candidate = digest(secret);
    const id = this.hashIndex.get(candidate);
    const record = id ? this.keys.get(id) : undefined;
    if (!record || !equalHash(record.hash, candidate) || record.revoked)
      throw new Error("Invalid or revoked API key");
    if (record.scope.tenantId !== scope.tenantId || !record.scope.permissions.includes(permission))
      throw new Error("API key scope does not permit operation");
    if (record.scope.projectId !== undefined && record.scope.projectId !== scope.projectId)
      throw new Error("API key project mismatch");
    if (record.scope.bucket !== undefined && record.scope.bucket !== scope.bucket)
      throw new Error("API key bucket mismatch");
    if (!(now instanceof Date)) throw new Error("Invalid API key time window");
    const nowTime = now.getTime();
    if (!Number.isFinite(nowTime)) throw new Error("Invalid API key time window");
    if (record.scope.notBefore !== undefined) {
      const notBefore = Date.parse(record.scope.notBefore);
      if (!Number.isFinite(notBefore)) throw new Error("Invalid API key time window");
      if (nowTime < notBefore) throw new Error("API key is not active");
    }
    const expiresAt = Date.parse(record.scope.expiresAt ?? "");
    if (!Number.isFinite(expiresAt)) throw new Error("Invalid API key time window");
    if (nowTime >= expiresAt) throw new Error("API key expired");
    const minute = Math.floor(nowTime / 60_000);
    if (!Number.isSafeInteger(minute)) throw new Error("Invalid API key time window");
    const window = this.windows.get(record.id);
    if (!window || window.minute !== minute) this.windows.set(record.id, { minute, count: 1 });
    else if (!Number.isSafeInteger(window.count) || window.count >= record.scope.requestsPerMinute)
      throw new Error("API key rate limit exceeded");
    else window.count += 1;
    return structuredClone(record);
  }

  get(id: string): ApiKeyRecord | undefined {
    const record = this.keys.get(id);
    return record ? structuredClone(record) : undefined;
  }

  getDto(id: string): ApiKeyDto | undefined {
    const record = this.keys.get(id);
    return record ? toApiKeyDto(record) : undefined;
  }

  revoke(id: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;
    key.revoked = true;
    this.windows.delete(id);
    return true;
  }

  list(tenantId: string): ApiKeyRecord[] {
    return [...this.keys.values()]
      .filter((key) => key.scope.tenantId === tenantId)
      .map((key) => structuredClone(key));
  }

  listDto(tenantId: string): ApiKeyDto[] {
    return [...this.keys.values()].filter((key) => key.scope.tenantId === tenantId).map(toApiKeyDto);
  }
}

export function toApiKeyDto(record: ApiKeyRecord): ApiKeyDto {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scope: structuredClone(record.scope),
    revoked: record.revoked,
    createdAt: record.createdAt,
  };
}

function keyName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid API key name");
  const name = value.trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error("Invalid API key name");
  return name;
}

function validateScope(scope: ApiKeyScope, now: Date): ApiKeyScope {
  if (!isRecord(scope) || !(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error("Invalid API key scope");
  const tenantId = identifier(scope.tenantId);
  const projectId = scope.projectId === undefined ? undefined : identifier(scope.projectId);
  const bucket = scope.bucket === undefined ? undefined : identifier(scope.bucket);
  if (!Array.isArray(scope.permissions) || !scope.permissions.length)
    throw new Error("Invalid API key scope");
  const permissions: Permission[] = [];
  for (const permission of scope.permissions) {
    if (!isPermission(permission)) throw new Error("Invalid API key scope");
    if (!permissions.includes(permission)) permissions.push(permission);
  }
  if (
    !Number.isSafeInteger(scope.requestsPerMinute) ||
    scope.requestsPerMinute < 1 ||
    scope.requestsPerMinute > MAX_API_KEY_REQUESTS_PER_MINUTE
  )
    throw new Error("Invalid API key scope");
  if (typeof scope.expiresAt !== "string" || !scope.expiresAt) throw new Error("Invalid API key scope");
  const expiresAt = Date.parse(scope.expiresAt);
  const nowTime = now.getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= nowTime) throw new Error("Invalid API key scope");
  let notBefore: string | undefined;
  if (scope.notBefore !== undefined) {
    if (typeof scope.notBefore !== "string" || !scope.notBefore) throw new Error("Invalid API key scope");
    const timestamp = Date.parse(scope.notBefore);
    if (!Number.isFinite(timestamp) || timestamp >= expiresAt) throw new Error("Invalid API key scope");
    notBefore = new Date(timestamp).toISOString();
  }
  return {
    tenantId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(bucket === undefined ? {} : { bucket }),
    ...(notBefore === undefined ? {} : { notBefore }),
    expiresAt: new Date(expiresAt).toISOString(),
    permissions,
    requestsPerMinute: scope.requestsPerMinute,
  };
}

function identifier(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid API key scope");
  const result = value.trim();
  if (!result || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result))
    throw new Error("Invalid API key scope");
  return result;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
