import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiKeyService } from "./api-key";
import type { Permission, Scope } from "./rbac";

export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (validAdministratorToken(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Administrator authentication required" });
}

export function requireAdminAccess(keys: ApiKeyService): RequestHandler {
  return (req, res, next) => {
    if (validAdministratorToken(req)) {
      next();
      return;
    }
    const secret = req.header("X-API-Key") ?? bearerToken(req);
    if (!secret) {
      res.status(401).json({ error: "Administrator token or API key required" });
      return;
    }
    const tenantId = req.header("X-Tenant-Id");
    if (!tenantId) {
      res.status(400).json({ error: "X-Tenant-Id is required for API key authentication" });
      return;
    }
    const scope: Scope = {
      tenantId,
      ...(req.header("X-Project-Id") ? { projectId: req.header("X-Project-Id") } : {}),
      ...(req.header("X-Storage-Bucket") ? { bucket: req.header("X-Storage-Bucket") } : {}),
    };
    const body = req.body as Record<string, unknown> | undefined;
    const nestedScope =
      typeof body?.scope === "object" && body.scope !== null
        ? (body.scope as Record<string, unknown>)
        : undefined;
    const requestedTenants = [req.query.tenantId, body?.tenantId, nestedScope?.tenantId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (requestedTenants.some((value) => value !== tenantId)) {
      res.status(403).json({ error: "Tenant scope mismatch" });
      return;
    }
    try {
      keys.authenticate(secret, permissionFor(req), scope);
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : "API key rejected";
      const status = message.includes("rate limit") ? 429 : 403;
      res.status(status).json({ error: message });
    }
  };
}

function validAdministratorToken(req: Request): boolean {
  const configured =
    process.env.ADMIN_API_TOKEN ?? (process.env.NODE_ENV === "production" ? "" : "development-admin-token");
  if (!configured) return false;
  const header = req.header("Authorization") ?? "";
  const expected = `Bearer ${configured}`;
  const left = Buffer.from(header);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(req: Request): string | undefined {
  const value = req.header("Authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function permissionFor(req: Request): Permission {
  const path = req.path;
  const read = req.method === "GET" || req.method === "HEAD";
  if (path.startsWith("/audit")) return "audit.read";
  if (path.startsWith("/webhooks")) return "webhook.manage";
  if (path.startsWith("/teams") || path.startsWith("/roles") || path.startsWith("/api-keys"))
    return "team.manage";
  if (path.startsWith("/security")) return read ? "storage.read" : "storage.write";
  if (path.startsWith("/storage")) return read ? "storage.read" : "settings.manage";
  if (path.startsWith("/monitoring")) return read ? "storage.read" : "settings.manage";
  return "settings.manage";
}
