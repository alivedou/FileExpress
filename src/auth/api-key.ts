import { createHash, randomBytes } from "node:crypto";
import type { Permission } from "./rbac";
import type { Scope } from "./rbac";

export interface ApiKeyScope extends Scope { permissions: Permission[]; requestsPerMinute: number }
export interface ApiKeyRecord { id: string; name: string; hash: string; prefix: string; scope: ApiKeyScope; revoked: boolean; createdAt: string }

export class ApiKeyService {
  private readonly keys = new Map<string, ApiKeyRecord>();
  private readonly windows = new Map<string, { minute: number; count: number }>();
  issue(name: string, scope: ApiKeyScope, now = new Date()): { secret: string; record: ApiKeyRecord } {
    if (!scope.permissions.length || scope.requestsPerMinute <= 0) throw new Error("Invalid API key scope");
    const secret = `fe_${randomBytes(32).toString("base64url")}`;
    const record: ApiKeyRecord = { id: randomBytes(16).toString("hex"), name, hash: digest(secret), prefix: secret.slice(0, 11), scope: structuredClone(scope), revoked: false, createdAt: now.toISOString() };
    this.keys.set(record.id, record);
    return { secret, record: structuredClone(record) };
  }
  authenticate(secret: string, permission: Permission, scope: Scope, now = new Date()): ApiKeyRecord {
    const hash = digest(secret);
    const record = [...this.keys.values()].find((item) => item.hash === hash);
    if (!record || record.revoked) throw new Error("Invalid or revoked API key");
    if (record.scope.tenantId !== scope.tenantId || !record.scope.permissions.includes(permission)) throw new Error("API key scope does not permit operation");
    if (record.scope.projectId && record.scope.projectId !== scope.projectId) throw new Error("API key project mismatch");
    if (record.scope.bucket && record.scope.bucket !== scope.bucket) throw new Error("API key bucket mismatch");
    if (record.scope.notBefore && new Date(record.scope.notBefore) > now) throw new Error("API key is not active");
    if (record.scope.expiresAt && new Date(record.scope.expiresAt) <= now) throw new Error("API key expired");
    const minute = Math.floor(now.getTime() / 60_000);
    const window = this.windows.get(record.id);
    if (!window || window.minute !== minute) this.windows.set(record.id, { minute, count: 1 });
    else if (window.count >= record.scope.requestsPerMinute) throw new Error("API key rate limit exceeded");
    else window.count += 1;
    return structuredClone(record);
  }
  revoke(id: string): boolean { const key = this.keys.get(id); if (!key) return false; key.revoked = true; return true; }
  list(tenantId: string): ApiKeyRecord[] { return [...this.keys.values()].filter((key) => key.scope.tenantId === tenantId).map((key) => structuredClone(key)); }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
