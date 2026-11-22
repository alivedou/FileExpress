export const PERMISSIONS = [
  "storage.read",
  "storage.write",
  "storage.delete",
  "settings.manage",
  "webhook.manage",
  "audit.read",
  "team.manage",
  "billing.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type BuiltinRole = "Owner" | "Admin" | "Member" | "Viewer" | "Guest";
export interface RoleDefinition {
  name: string;
  permissions: Permission[];
  inherits?: string[];
  tenantId?: string;
}
export interface Principal {
  userId: string;
  tenantId: string;
  roles: string[];
  projectId?: string;
  bucket?: string;
}
export interface Scope {
  tenantId: string;
  projectId?: string;
  bucket?: string;
  notBefore?: string;
  expiresAt?: string;
}

export const MAX_ROLE_DEPTH = 16;

const BUILTINS: Record<BuiltinRole, readonly Permission[]> = {
  Owner: [...PERMISSIONS],
  Admin: PERMISSIONS.filter((item) => item !== "billing.view"),
  Member: ["storage.read", "storage.write", "storage.delete"],
  Viewer: ["storage.read"],
  Guest: ["storage.read"],
};

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export class RbacService {
  private readonly custom = new Map<string, RoleDefinition>();

  defineRole(role: RoleDefinition): void {
    if (!isRecord(role)) throw new Error("Invalid role name");
    const name = roleName(role.name);
    if (isBuiltinRole(name)) throw new Error("Cannot override builtin role");
    const tenantId = optionalTenantId(role.tenantId);
    if (!Array.isArray(role.permissions)) throw new Error("Invalid permission set");
    const permissions: Permission[] = [];
    for (const permission of role.permissions) {
      if (!isPermission(permission)) throw new Error("Invalid permission set");
      if (!permissions.includes(permission)) permissions.push(permission);
    }
    const inherited = role.inherits ?? [];
    if (!Array.isArray(inherited)) throw new Error("Invalid role inheritance");
    const inherits: string[] = [];
    for (const parent of inherited) {
      if (typeof parent !== "string" || !isValidRoleName(parent)) throw new Error("Invalid role inheritance");
      if (!inherits.includes(parent)) inherits.push(parent);
    }
    if (!permissions.length && !inherits.length) throw new Error("Invalid permission set");
    const candidate: RoleDefinition = {
      name,
      permissions,
      inherits,
      ...(tenantId === undefined ? {} : { tenantId }),
    };
    const key = roleKey(name, tenantId);
    const previous = this.custom.get(key);
    this.custom.set(key, candidate);
    try {
      this.validateGraph();
    } catch (error) {
      if (previous) this.custom.set(key, previous);
      else this.custom.delete(key);
      throw error;
    }
  }

  defineTenantRole(tenantId: string, role: Omit<RoleDefinition, "tenantId">): void {
    this.defineRole({ ...role, tenantId });
  }

  removeRole(name: string, tenantId?: string): boolean {
    const key = roleKey(name, tenantId);
    if (!this.custom.has(key)) return false;
    for (const definition of this.custom.values()) {
      if (roleKey(definition.name, definition.tenantId) === key) continue;
      for (const parent of definition.inherits ?? []) {
        const resolved = this.findCustom(parent, definition.tenantId);
        if (resolved && roleKey(resolved.name, resolved.tenantId) === key) return false;
      }
    }
    return this.custom.delete(key);
  }

  removeTenantRole(tenantId: string, name: string): boolean {
    return this.removeRole(name, tenantId);
  }

  getRole(name: string, tenantId?: string): RoleDefinition | undefined {
    if (isBuiltinRole(name)) return { name, permissions: [...BUILTINS[name]], inherits: [] };
    const role = this.findCustom(name, tenantId);
    return role ? cloneRole(role) : undefined;
  }

  listRoles(tenantId?: string): RoleDefinition[] {
    return [...this.custom.values()]
      .filter((role) =>
        tenantId === undefined
          ? role.tenantId === undefined
          : role.tenantId === undefined || role.tenantId === tenantId,
      )
      .map(cloneRole);
  }

  can(principal: Principal, permission: Permission, scope: Scope, now = new Date()): boolean {
    if (!isRecord(principal) || !isRecord(scope) || !Array.isArray(principal.roles)) return false;
    if (
      typeof principal.tenantId !== "string" ||
      !principal.tenantId ||
      typeof scope.tenantId !== "string" ||
      principal.tenantId !== scope.tenantId
    )
      return false;
    if (
      scope.projectId !== undefined &&
      (typeof scope.projectId !== "string" || !scope.projectId || principal.projectId !== scope.projectId)
    )
      return false;
    if (
      scope.bucket !== undefined &&
      (typeof scope.bucket !== "string" || !scope.bucket || principal.bucket !== scope.bucket)
    )
      return false;
    if (!(now instanceof Date)) return false;
    const nowTime = now.getTime();
    if (!Number.isFinite(nowTime)) return false;
    let notBefore: number | undefined;
    let expiresAt: number | undefined;
    if (scope.notBefore !== undefined) {
      if (typeof scope.notBefore !== "string" || !scope.notBefore) return false;
      notBefore = Date.parse(scope.notBefore);
      if (!Number.isFinite(notBefore) || nowTime < notBefore) return false;
    }
    if (scope.expiresAt !== undefined) {
      if (typeof scope.expiresAt !== "string" || !scope.expiresAt) return false;
      expiresAt = Date.parse(scope.expiresAt);
      if (!Number.isFinite(expiresAt) || nowTime >= expiresAt) return false;
    }
    if (notBefore !== undefined && expiresAt !== undefined && notBefore >= expiresAt) return false;
    if (!isPermission(permission)) return false;
    return principal.roles.some(
      (role) => typeof role === "string" && this.permissions(role, principal.tenantId).includes(permission),
    );
  }

  assert(principal: Principal, permission: Permission, scope: Scope, now = new Date()): void {
    if (!this.can(principal, permission, scope, now)) throw new Error(`Permission denied: ${permission}`);
  }

  permissions(role: string, tenantId?: string): Permission[] {
    if (isBuiltinRole(role)) return [...BUILTINS[role]];
    if (!this.findCustom(role, tenantId)) return [];
    return this.resolvePermissions(role, tenantId);
  }

  private findCustom(name: string, tenantId?: string): RoleDefinition | undefined {
    if (tenantId !== undefined) {
      const tenantRole = this.custom.get(roleKey(name, tenantId));
      if (tenantRole) return tenantRole;
    }
    return this.custom.get(roleKey(name, undefined));
  }

  private resolvePermissions(role: string, tenantId?: string): Permission[] {
    const result = new Set<Permission>();
    const visiting = new Set<string>();
    const visit = (name: string, tenant: string | undefined, depth: number): void => {
      if (depth > MAX_ROLE_DEPTH) throw new Error("Role inheritance exceeds maximum depth");
      if (isBuiltinRole(name)) {
        for (const permission of BUILTINS[name]) result.add(permission);
        return;
      }
      const definition = this.findCustom(name, tenant);
      if (!definition) throw new Error("Inherited role does not exist");
      const key = roleKey(definition.name, definition.tenantId);
      if (visiting.has(key)) throw new Error("Role inheritance cycle detected");
      visiting.add(key);
      for (const parent of definition.inherits ?? []) visit(parent, definition.tenantId, depth + 1);
      for (const permission of definition.permissions) result.add(permission);
      visiting.delete(key);
    };
    visit(role, tenantId, 0);
    return [...result];
  }

  private validateGraph(): void {
    for (const role of this.custom.values()) this.resolvePermissions(role.name, role.tenantId);
  }
}

function isBuiltinRole(value: string): value is BuiltinRole {
  return Object.hasOwn(BUILTINS, value);
}

function isValidRoleName(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/.test(value);
}

function roleName(value: unknown): string {
  if (typeof value !== "string" || !isValidRoleName(value)) throw new Error("Invalid role name");
  return value;
}

function optionalTenantId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Invalid tenant");
  return value.trim();
}

function roleKey(name: string, tenantId: string | undefined): string {
  return JSON.stringify([tenantId ?? null, name]);
}

function cloneRole(role: RoleDefinition): RoleDefinition {
  return {
    name: role.name,
    permissions: [...role.permissions],
    inherits: [...(role.inherits ?? [])],
    ...(role.tenantId === undefined ? {} : { tenantId: role.tenantId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
