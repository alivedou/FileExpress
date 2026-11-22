import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { ChunkedUploadManager, UploadError } from "./chunked";
import { TusUploadManager } from "./tus";

export interface CompletedUpload { id: string; filePath: string; fileName: string; mimeType: string; size: number; tenantId: string; checksum?: string }
interface UploadRouterOptions {
  chunkSize: number;
  expiryHours: number;
  onCompleted?: (upload: CompletedUpload) => Promise<void>;
}

export function createUploadRouter(
  chunked: ChunkedUploadManager,
  tus: TusUploadManager,
  options: UploadRouterOptions,
): Router {
  const router = Router();
  const expiry = () => new Date(Date.now() + options.expiryHours * 3600_000).toISOString();

  router.options("/tus", (_req, res) => sendTusOptions(res));
  router.options("/tus/:id", (_req, res) => sendTusOptions(res));

  router.post("/tus", async (req, res) => {
    try {
      assertTusVersion(req);
      const lengthHeader = req.header("Upload-Length");
      const deferHeader = req.header("Upload-Defer-Length");
      if (deferHeader !== undefined && deferHeader !== "1") throw new UploadError(400, "Invalid Upload-Defer-Length");
      if (!lengthHeader && !deferHeader) throw new UploadError(400, "Upload-Length or Upload-Defer-Length is required");
      const metadata = parseTusMetadata(req.header("Upload-Metadata"));
      const session = await tus.create({
        fileName: metadata.filename ?? "upload.bin",
        mimeType: metadata.filetype ?? "application/octet-stream",
        uploadLength: lengthHeader ? Number.parseInt(lengthHeader, 10) : undefined,
        tenantId: req.header("X-Tenant-Id") ?? "default",
        expiresAt: expiry(),
        metadata,
      });
      res.setHeader("Location", `/api/upload/tus/${session.id}`);
      res.setHeader("Tus-Resumable", "1.0.0");
      res.status(201).end();
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.head("/tus/:id", async (req, res) => {
    try {
      const session = await tus.get(requiredParam(req, "id"));
      res.setHeader("Upload-Offset", String(session.offset));
      res.setHeader("Upload-Length", String(session.uploadLength ?? 0));
      res.setHeader("Upload-Defer-Length", session.uploadLength === undefined ? "1" : "0");
      res.setHeader("Upload-Metadata", encodeTusMetadata(session.metadata ?? {}));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Tus-Resumable", "1.0.0");
      res.status(200).end();
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.patch("/tus/:id", async (req, res) => {
    try {
      assertTusVersion(req);
      if (req.header("Content-Type") !== "application/offset+octet-stream") {
        throw new UploadError(415, "Unsupported Content-Type");
      }
      const session = await tus.append(
        requiredParam(req, "id"),
        Number.parseInt(req.header("Upload-Offset") ?? "-1", 10),
        req,
        req.header("Content-Length") ? Number.parseInt(req.header("Content-Length") ?? "0", 10) : undefined,
      );
      if (session.uploadLength !== undefined && session.offset === session.uploadLength) {
        const completed = await tus.complete(requiredParam(req, "id"));
        await options.onCompleted?.({ id: session.id, filePath: completed.filePath, fileName: session.fileName, mimeType: session.mimeType, size: session.offset, tenantId: session.tenantId });
      }
      res.setHeader("Upload-Offset", String(session.offset));
      res.setHeader("Tus-Resumable", "1.0.0");
      res.status(204).end();
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.delete("/tus/:id", async (req, res) => {
    try {
      assertTusVersion(req);
      await tus.terminate(requiredParam(req, "id"));
      res.setHeader("Tus-Resumable", "1.0.0");
      res.status(204).end();
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.post("/chunks", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const totalSize = positiveInteger(body.totalSize, "totalSize");
      const chunkSize = Math.min(positiveInteger(body.chunkSize, "chunkSize", options.chunkSize), options.chunkSize);
      const session = await chunked.create({
        fileName: requiredString(body.fileName, "fileName"),
        mimeType: optionalString(body.mimeType) ?? "application/octet-stream",
        totalSize,
        chunkSize,
        totalChunks: Math.max(1, Math.ceil(totalSize / chunkSize)),
        tenantId: req.header("X-Tenant-Id") ?? "default",
        expiresAt: expiry(),
      });
      res.status(201).json({ uploadId: session.id, chunkSize, totalChunks: session.totalChunks, expiresAt: session.expiresAt });
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.get("/chunks/:id", async (req, res) => {
    try {
      const session = await chunked.status(requiredParam(req, "id"));
      res.json({
        uploadId: session.id,
        status: session.status,
        receivedChunks: Object.values(session.chunks).map((chunk) => chunk.index),
        totalChunks: session.totalChunks,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.put("/chunks/:id/:index", async (req, res) => {
    try {
      const receipt = await chunked.uploadChunk(
        requiredParam(req, "id"),
        Number.parseInt(requiredParam(req, "index"), 10),
        req,
        req.header("X-Chunk-SHA256"),
      );
      res.status(200).json(receipt);
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.post("/chunks/:id/complete", async (req, res) => {
    try {
      const completed = await chunked.complete(requiredParam(req, "id"));
      await options.onCompleted?.({ id: completed.session.id, filePath: completed.filePath, fileName: completed.session.fileName, mimeType: completed.session.mimeType, size: completed.session.totalSize, tenantId: completed.session.tenantId, checksum: completed.session.finalChecksum });
      res.json({
        uploadId: completed.session.id,
        fileName: completed.session.fileName,
        mimeType: completed.session.mimeType,
        size: completed.session.totalSize,
        checksum: completed.session.finalChecksum,
        pickupCode: completed.session.id.replaceAll("-", "").slice(0, 6).toUpperCase(),
        expiresAt: completed.session.expiresAt,
        downloadToken: randomUUID(),
      });
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  router.delete("/chunks/:id", async (req, res) => {
    try {
      await chunked.discard(requiredParam(req, "id"));
      res.status(204).end();
    } catch (error) {
      sendUploadError(res, error);
    }
  });

  return router;
}

function sendTusOptions(res: Response): void {
  res.setHeader("Tus-Resumable", "1.0.0");
  res.setHeader("Tus-Version", "1.0.0");
  res.setHeader("Tus-Extension", "creation,creation-with-upload,termination,expiration");
  res.setHeader("Tus-Max-Size", String(Number.MAX_SAFE_INTEGER));
  res.status(204).end();
}

function assertTusVersion(req: Request): void {
  if (req.header("Tus-Resumable") !== "1.0.0") throw new UploadError(412, "Tus-Resumable 1.0.0 is required");
}

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new UploadError(400, `Missing path parameter: ${name}`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UploadError(400, `${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new UploadError(400, `${name} must be a positive integer`);
  return parsed;
}

function parseTusMetadata(value?: string): Record<string, string> {
  if (!value) return {};
  const entries: Record<string, string> = {};
  for (const item of value.split(",")) {
    const [key, encoded, ...rest] = item.trim().split(" ");
    if (!key || rest.length || !/^[a-zA-Z0-9_-]+$/.test(key)) throw new UploadError(400, "Invalid Upload-Metadata");
    if (encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      if (Buffer.from(decoded).toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
        throw new UploadError(400, "Invalid Upload-Metadata encoding");
      }
      entries[key] = decoded;
    } else entries[key] = "";
  }
  return entries;
}

function encodeTusMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`)
    .join(",");
}

function sendUploadError(res: Response, error: unknown): void {
  const status = error instanceof UploadError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Upload failed";
  if (!res.headersSent) res.status(status).json({ error: message });
}
