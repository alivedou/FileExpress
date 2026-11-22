export const PERMISSIONS = ["storage.read", "storage.write", "storage.delete", "settings.manage", "webhook.manage", "audit.read", "team.manage", "billing.view"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type BuiltinRole = "Owner" | "Admin" | "Member" | "Viewer" | "Guest";
export interface RoleDefinition { name: string; permissions: Permission[] }
export interface Principal { userId: string; tenantId: string; roles: string[]; projectId?: string; bucket?: string }
export interface Scope { tenantId: string; projectId?: string; bucket?: string; notBefore?: string; expiresAt?: string }

const BUILTINS: Record<BuiltinRole, Permission[]> = {
  Owner: [...PERMISSIONS], Admin: PERMISSIONS.filter((item) => item !== "billing.view"),
  Member: ["storage.read", "storage.write", "storage.delete"], Viewer: ["storage.read"], Guest: ["storage.read"],
};

export class RbacService {
  private readonly custom = new Map<string, RoleDefinition>();
  defineRole(role: RoleDefinition): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/.test(role.name)) throw new Error("Invalid role name");
    if (!role.permissions.length || role.permissions.some((item) => !PERMISSIONS.includes(item))) throw new Error("Invalid permission set");
    this.custom.set(role.name, { ...role, permissions: [...new Set(role.permissions)] });
  }
  removeRole(name: string): boolean { return this.custom.delete(name); }
  can(principal: Principal, permission: Permission, scope: Scope, now = new Date()): boolean {
    if (principal.tenantId !== scope.tenantId) return false;
    if (scope.projectId && principal.projectId && principal.projectId !== scope.projectId) return false;
    if (scope.bucket && principal.bucket && principal.bucket !== scope.bucket) return false;
    if (scope.notBefore && new Date(scope.notBefore) > now) return false;
    if (scope.expiresAt && new Date(scope.expiresAt) <= now) return false;
    return principal.roles.some((role) => this.permissions(role).includes(permission));
  }
  assert(principal: Principal, permission: Permission, scope: Scope, now = new Date()): void {
    if (!this.can(principal, permission, scope, now)) throw new Error(`Permission denied: ${permission}`);
  }
  permissions(role: string): Permission[] {
    if (role in BUILTINS) return [...BUILTINS[role as BuiltinRole]];
    return [...(this.custom.get(role)?.permissions ?? [])];
  }
}
