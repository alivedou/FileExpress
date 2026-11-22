import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ChunkedUploadManager} from "./chunked";
import { UploadError } from "./chunked";
import { isRecord, type CompletionNotification, type CompletionResult } from "./shared";
import type { TusUploadManager } from "./tus";

export type CompletedUpload = CompletionNotification;

interface UploadRouterOptions {
  chunkSize: number;
  expiryHours: number;
  onCompleted?: (upload: CompletedUpload) => Promise<CompletionResult | void>;
}

export function createUploadRouter(
  chunked: ChunkedUploadManager,
  tus: TusUploadManager,
  options: UploadRouterOptions,
): Router {
  const router = Router();
  const expiry = () => {
    const timestamp = Date.now() + options.expiryHours * 3600_000;
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
      throw new UploadError(400, "Invalid upload expiration");
    }
    return new Date(timestamp).toISOString();
  };

  router.options("/tus", (_req, res) => sendTusOptions(res));
  router.options("/tus/:id", (_req, res) => sendTusOptions(res));

  router.post("/tus", async (req, res) => {
    try {
      assertTusVersion(req);
      const lengthHeader = req.header("Upload-Length");
      const deferHeader = req.header("Upload-Defer-Length");
      if (deferHeader !== undefined && deferHeader !== "1")
        throw new UploadError(400, "Invalid Upload-Defer-Length");
      if (lengthHeader !== undefined && deferHeader !== undefined) {
        throw new UploadError(400, "Upload-Length and Upload-Defer-Length cannot be combined");
      }
      if (lengthHeader === undefined && deferHeader === undefined) {
        throw new UploadError(400, "Upload-Length or Upload-Defer-Length is required");
      }
      const uploadLength =
        lengthHeader === undefined ? undefined : decimalHeader(lengthHeader, "Upload-Length");
      const contentType = req.header("Content-Type");
      const creationWithUpload = contentType !== undefined;
      if (creationWithUpload && contentType !== "application/offset+octet-stream") {
        throw new UploadError(415, "Unsupported Content-Type");
      }
      if (creationWithUpload && uploadLength === undefined) {
        throw new UploadError(400, "Creation with upload requires Upload-Length");
      }
      const checksum = parseUploadChecksum(req.header("Upload-Checksum"));
      if (checksum && !creationWithUpload)
        throw new UploadError(400, "Upload-Checksum requires request content");
      const contentLength = creationWithUpload ? optionalDecimalHeader(req, "Content-Length") : undefined;
      const metadata = parseTusMetadata(req.header("Upload-Metadata"));
      let session = await tus.create({
        fileName: metadata.filename ?? "upload.bin",
        mimeType: metadata.filetype ?? "application/octet-stream",
        uploadLength,
        tenantId: req.header("X-Tenant-Id") ?? "default",
        expiresAt: expiry(),
        metadata,
      });
      res.setHeader("Location", `/api/upload/tus/${session.id}`);
      if (creationWithUpload) {
        session = await tus.append(session.id, 0, req, contentLength, { checksum });
      }
      if (session.uploadLength !== undefined && session.offset === session.uploadLength) {
        const completed = await tus.complete(session.id, { onCompleted: options.onCompleted });
        session = completed.session;
      }
      if (session.completionResult?.pickupCode)
        res.setHeader("Pickup-Code", session.completionResult.pickupCode);
      res.setHeader("Upload-Offset", String(session.offset));
      res.setHeader("Upload-Expires", httpDate(session.expiresAt));
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
      if (session.uploadLength !== undefined) res.setHeader("Upload-Length", String(session.uploadLength));
      res.setHeader("Upload-Defer-Length", session.uploadLength === undefined ? "1" : "0");
      res.setHeader("Upload-Metadata", encodeTusMetadata(session.metadata ?? {}));
      res.setHeader("Upload-Expires", httpDate(session.expiresAt));
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
      const id = requiredParam(req, "id");
      const offsetHeader = req.header("Upload-Offset");
      if (offsetHeader === undefined) throw new UploadError(400, "Upload-Offset is required");
      let session = await tus.append(
        id,
        decimalHeader(offsetHeader, "Upload-Offset"),
        req,
        optionalDecimalHeader(req, "Content-Length"),
        {
          uploadLength: optionalDecimalHeader(req, "Upload-Length"),
          checksum: parseUploadChecksum(req.header("Upload-Checksum")),
        },
      );
      if (session.uploadLength !== undefined && session.offset === session.uploadLength) {
        const completed = await tus.complete(id, { onCompleted: options.onCompleted });
        session = completed.session;
      }
      if (session.completionResult?.pickupCode)
        res.setHeader("Pickup-Code", session.completionResult.pickupCode);
      res.setHeader("Upload-Offset", String(session.offset));
      res.setHeader("Upload-Expires", httpDate(session.expiresAt));
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
      const body = requestBody(req.body);
      const totalSize = positiveInteger(body.totalSize, "totalSize");
      const chunkSize = Math.min(
        positiveInteger(body.chunkSize, "chunkSize", options.chunkSize),
        options.chunkSize,
      );
      const session = await chunked.create({
        fileName: requiredString(body.fileName, "fileName"),
        mimeType: optionalString(body.mimeType) ?? "application/octet-stream",
        totalSize,
        chunkSize,
        totalChunks: Math.max(1, Math.ceil(totalSize / chunkSize)),
        tenantId: req.header("X-Tenant-Id") ?? "default",
        expiresAt: expiry(),
      });
      res.status(201).json({
        uploadId: session.id,
        chunkSize,
        totalChunks: session.totalChunks,
        expiresAt: session.expiresAt,
      });
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
        totalSize: session.totalSize,
        chunkSize: session.chunkSize,
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
        decimalHeader(requiredParam(req, "index"), "Chunk index"),
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
      const body = req.body === undefined ? {} : requestBody(req.body);
      const bodyChecksum = body.finalChecksum;
      if (bodyChecksum !== undefined && typeof bodyChecksum !== "string")
        throw new UploadError(400, "Invalid final checksum");
      const headerChecksum = req.header("X-Final-SHA256");
      if (bodyChecksum !== undefined && headerChecksum !== undefined && bodyChecksum !== headerChecksum) {
        throw new UploadError(400, "Conflicting final checksums");
      }
      const completed = await chunked.complete(requiredParam(req, "id"), {
        finalChecksum: bodyChecksum ?? headerChecksum,
        onCompleted: options.onCompleted,
      });
      res.json({
        uploadId: completed.session.id,
        fileName: completed.session.fileName,
        mimeType: completed.session.mimeType,
        size: completed.session.totalSize,
        checksum: completed.session.finalChecksum,
        pickupCode:
          completed.session.completionResult?.pickupCode ??
          String(
            100000 + (Number.parseInt(completed.session.id.replaceAll("-", "").slice(0, 8), 16) % 900000),
          ),
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
  res.setHeader("Tus-Extension", "creation,creation-with-upload,termination,expiration,checksum");
  res.setHeader("Tus-Checksum-Algorithm", "sha256");
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

function requestBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new UploadError(400, "JSON object body is required");
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UploadError(400, `${name} must be a positive integer`);
  }
  return value;
}

function decimalHeader(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new UploadError(400, `Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UploadError(400, `Invalid ${name}`);
  return parsed;
}

function optionalDecimalHeader(req: Request, name: string): number | undefined {
  const value = req.header(name);
  return value === undefined ? undefined : decimalHeader(value, name);
}

function parseUploadChecksum(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const match = /^sha256 ([A-Za-z0-9+/]{43}=)$/.exec(value);
  if (!match) throw new UploadError(400, "Invalid Upload-Checksum");
  const encoded = match[1];
  if (encoded === undefined) throw new UploadError(400, "Invalid Upload-Checksum");
  const checksum = Buffer.from(encoded, "base64");
  if (checksum.length !== 32 || checksum.toString("base64") !== encoded) {
    throw new UploadError(400, "Invalid Upload-Checksum");
  }
  return encoded;
}

function parseTusMetadata(value?: string): Record<string, string> {
  if (!value) return {};
  const entries: Record<string, string> = {};
  for (const item of value.split(",")) {
    const [key, encoded, ...rest] = item.trim().split(" ");
    if (!key || rest.length || !/^[a-zA-Z0-9_-]+$/.test(key))
      throw new UploadError(400, "Invalid Upload-Metadata");
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

function httpDate(value: string): string {
  return new Date(value).toUTCString();
}

function sendUploadError(res: Response, error: unknown): void {
  const status = error instanceof UploadError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Upload failed";
  if (!res.headersSent) res.status(status).json({ error: message });
}
