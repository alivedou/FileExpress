import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.ADMIN_API_TOKEN ?? (process.env.NODE_ENV === "production" ? "" : "development-admin-token");
  if (!configured) { res.status(503).json({ error: "ADMIN_API_TOKEN is not configured" }); return; }
  const header = req.header("Authorization") ?? "";
  const expected = `Bearer ${configured}`;
  const left = Buffer.from(header); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) { res.status(401).json({ error: "Administrator authentication required" }); return; }
  next();
}
