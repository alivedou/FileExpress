export type ApiMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

export interface ApiOperation {
  method: ApiMethod;
  path: string;
  summary: string;
  tags: string[];
  example: { request: unknown; response: unknown };
  admin?: boolean;
  binary?: boolean;
  contentType?: string;
  successStatus?: number;
}

const publicTags = ["Public transfer"];
const uploadTags = ["Resumable upload"];
const adminTags = ["Administration"];
const systemTags = ["System"];

export const API_OPERATIONS: ApiOperation[] = [
  {
    method: "get",
    path: "/api/config",
    summary: "Read public application limits and branding",
    tags: systemTags,
    example: {
      request: {},
      response: { appName: "File Express", maxChunkSizeMB: 8, maxStorageHours: 24 },
    },
  },
  {
    method: "get",
    path: "/api/health",
    summary: "Read legacy liveness information",
    tags: systemTags,
    example: {
      request: {},
      response: { status: "ok", mode: "local", timestamp: "2026-11-22T00:00:00.000Z" },
    },
  },
  {
    method: "post",
    path: "/api/upload/public",
    summary: "Upload a public text document",
    tags: publicTags,
    contentType: "multipart/form-data",
    example: {
      request: { title: "release-notes", content: "FileExpress 2.0" },
      response: { success: true, id: "pub_release-notes.txt", url: "/view/pub_release-notes.txt" },
    },
  },
  {
    method: "post",
    path: "/api/upload/private",
    summary: "Upload small private files through the compatibility API",
    tags: publicTags,
    contentType: "multipart/form-data",
    example: {
      request: { files: ["<binary>"], duration: 24, maxDownloads: 5 },
      response: { success: true, pickupCode: "123456", expiresAt: "2026-11-23T00:00:00.000Z" },
    },
  },
  {
    method: "post",
    path: "/api/batch-upload",
    summary: "Upload one public text file for script clients",
    tags: publicTags,
    contentType: "multipart/form-data",
    successStatus: 200,
    example: {
      request: { file: "<binary text>" },
      response: "上传成功。访问链接: https://files.example.test/view/pub_notes.txt",
    },
  },
  {
    method: "post",
    path: "/api/extract",
    summary: "Resolve a six-digit pickup code",
    tags: publicTags,
    example: {
      request: { code: "123456" },
      response: {
        success: true,
        fileName: "video.mp4",
        scanStatus: "clean",
        downloadUrl: "/api/download/123456",
      },
    },
  },
  {
    method: "get",
    path: "/api/download/{code}",
    summary: "Stream an authorised private file",
    tags: publicTags,
    example: {
      request: { code: "123456", headers: { "X-Device-Id": "device-1234" } },
      response: {
        contentType: "video/mp4",
        headers: { "X-Content-SHA256": "a".repeat(64) },
        body: "<binary stream>",
      },
    },
  },
  {
    method: "get",
    path: "/api/view/{id}",
    summary: "Read an unexpired public text document",
    tags: publicTags,
    example: {
      request: { id: "pub_notes.txt" },
      response: { content: "FileExpress 2.0", fileName: "notes.txt", createdAt: "2026-11-22T00:00:00.000Z" },
    },
  },
  {
    method: "get",
    path: "/api/files/public",
    summary: "List the latest public documents",
    tags: publicTags,
    example: {
      request: {},
      response: [{ id: "pub_notes.txt", fileName: "notes.txt", expiryDate: "2026-11-25T00:00:00.000Z" }],
    },
  },
  {
    method: "options",
    path: "/api/upload/tus",
    summary: "Discover Tus 1.0.0 protocol capabilities",
    tags: uploadTags,
    successStatus: 204,
    example: {
      request: {},
      response: { headers: { "Tus-Resumable": "1.0.0", "Tus-Extension": "creation,termination,expiration" } },
    },
  },
  {
    method: "post",
    path: "/api/upload/tus",
    summary: "Create a Tus 1.0.0 resumable upload",
    tags: uploadTags,
    successStatus: 201,
    example: {
      request: {
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Length": 524288000,
          "Upload-Metadata": "filename dmlkZW8ubXA0,filetype dmlkZW8vbXA0",
        },
      },
      response: { headers: { Location: "/api/upload/tus/9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8" } },
    },
  },
  {
    method: "options",
    path: "/api/upload/tus/{id}",
    summary: "Discover capabilities for an existing Tus upload",
    tags: uploadTags,
    successStatus: 204,
    example: { request: { id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8" }, response: {} },
  },
  {
    method: "head",
    path: "/api/upload/tus/{id}",
    summary: "Read the current resumable offset",
    tags: uploadTags,
    example: {
      request: { id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8", headers: { "Tus-Resumable": "1.0.0" } },
      response: { headers: { "Upload-Offset": 8388608, "Upload-Length": 524288000 } },
    },
  },
  {
    method: "patch",
    path: "/api/upload/tus/{id}",
    summary: "Append bytes at the current offset",
    tags: uploadTags,
    binary: true,
    contentType: "application/offset+octet-stream",
    successStatus: 204,
    example: {
      request: {
        id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8",
        headers: { "Upload-Offset": 0, "Tus-Resumable": "1.0.0" },
        body: "<binary>",
      },
      response: { headers: { "Upload-Offset": 8388608 } },
    },
  },
  {
    method: "delete",
    path: "/api/upload/tus/{id}",
    summary: "Terminate a Tus upload and remove temporary data",
    tags: uploadTags,
    successStatus: 204,
    example: { request: { id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8" }, response: {} },
  },
  {
    method: "post",
    path: "/api/upload/chunks",
    summary: "Create a concurrent chunked upload",
    tags: uploadTags,
    successStatus: 201,
    example: {
      request: { fileName: "video.mp4", mimeType: "video/mp4", totalSize: 524288000, chunkSize: 8388608 },
      response: { uploadId: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8", totalChunks: 63, chunkSize: 8388608 },
    },
  },
  {
    method: "get",
    path: "/api/upload/chunks/{id}",
    summary: "Restore the list of verified chunks",
    tags: uploadTags,
    example: {
      request: { id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8" },
      response: {
        uploadId: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8",
        receivedChunks: [0, 1, 2],
        totalChunks: 63,
      },
    },
  },
  {
    method: "delete",
    path: "/api/upload/chunks/{id}",
    summary: "Discard a chunked upload",
    tags: uploadTags,
    successStatus: 204,
    example: { request: { id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8" }, response: {} },
  },
  {
    method: "put",
    path: "/api/upload/chunks/{id}/{index}",
    summary: "Upload one SHA-256 verified chunk",
    tags: uploadTags,
    binary: true,
    contentType: "application/octet-stream",
    example: {
      request: {
        id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8",
        index: 0,
        headers: { "X-Chunk-SHA256": "a".repeat(64) },
        body: "<binary>",
      },
      response: { index: 0, size: 8388608, checksum: "a".repeat(64) },
    },
  },
  {
    method: "post",
    path: "/api/upload/chunks/{id}/complete",
    summary: "Merge chunks and persist the file to a routed backend",
    tags: uploadTags,
    example: {
      request: { id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8", finalChecksum: "a".repeat(64) },
      response: {
        uploadId: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8",
        size: 524288000,
        checksum: "a".repeat(64),
        pickupCode: "123456",
      },
    },
  },
  {
    method: "post",
    path: "/api/webhook/virustotal",
    summary: "Receive a signed VirusTotal analysis callback",
    tags: ["Security"],
    successStatus: 202,
    example: {
      request: {
        headers: { "X-VirusTotal-Timestamp": "1767225600", "X-VirusTotal-Signature": "a".repeat(64) },
        data: { id: "analysis-id", attributes: { status: "completed", stats: { malicious: 0 } } },
        meta: { file_info: { sha256: "a".repeat(64) } },
      },
      response: { accepted: true, result: { engine: "virustotal", verdict: "clean", details: [] } },
    },
  },
  {
    method: "get",
    path: "/health/live",
    summary: "Kubernetes liveness probe",
    tags: systemTags,
    example: { request: {}, response: { status: "ok", alive: true } },
  },
  {
    method: "get",
    path: "/health/ready",
    summary: "Kubernetes readiness with every enabled backend",
    tags: systemTags,
    example: {
      request: {},
      response: {
        status: "ready",
        healthy: true,
        backends: [{ backend: "local", kind: "local", healthy: true }],
      },
    },
  },
  {
    method: "get",
    path: "/metrics",
    summary: "Prometheus text exposition",
    tags: systemTags,
    example: { request: {}, response: 'http_req_duration_seconds_bucket{le="1"} 42' },
  },
  {
    method: "get",
    path: "/api/admin/storage",
    summary: "List redacted backend configurations and health",
    tags: adminTags,
    admin: true,
    example: {
      request: { headers: { Authorization: "Bearer <admin-token>", "X-Tenant-Id": "team-a" } },
      response: {
        items: [{ name: "s3", kind: "s3", options: { secretAccessKey: "[REDACTED]" } }],
        health: [{ backend: "s3", healthy: true }],
      },
    },
  },
  {
    method: "post",
    path: "/api/admin/storage",
    summary: "Register and test a storage backend",
    tags: adminTags,
    admin: true,
    successStatus: 201,
    example: {
      request: {
        name: "s3",
        kind: "s3",
        enabled: true,
        priority: 1,
        options: { bucket: "fileexpress", region: "us-east-1", secretAccessKey: "<secret>" },
      },
      response: { health: { backend: "s3", healthy: true } },
    },
  },
  {
    method: "get",
    path: "/api/admin/security",
    summary: "Read scanner versions, health and queue depth",
    tags: ["Security"],
    admin: true,
    example: {
      request: {},
      response: { items: [{ id: "clamav-daemon", healthy: true, signatureVersion: "ClamAV 1.4" }] },
    },
  },
  {
    method: "post",
    path: "/api/admin/security",
    summary: "Scan an existing file inside DATA_DIR",
    tags: ["Security"],
    admin: true,
    example: {
      request: { filePath: "/data/uploads/example.bin", id: "example", mimeType: "application/octet-stream" },
      response: { fileId: "example", verdict: "clean", action: "accept", results: [] },
    },
  },
  {
    method: "get",
    path: "/api/admin/webhooks",
    summary: "List tenant endpoints and delivery history",
    tags: ["Webhooks"],
    admin: true,
    example: { request: { query: { tenantId: "team-a" } }, response: { items: [], history: [] } },
  },
  {
    method: "post",
    path: "/api/admin/webhooks",
    summary: "Create an HMAC-signed webhook endpoint",
    tags: ["Webhooks"],
    admin: true,
    successStatus: 201,
    example: {
      request: {
        tenantId: "team-a",
        url: "https://hooks.example.test/fileexpress",
        secret: "<secret>",
        events: ["file.uploaded", "file.scanned"],
        enabled: true,
      },
      response: { id: "9b7d2a4e-0e6c-4df0-a9b0-72d6240e56e8", secret: "[REDACTED]" },
    },
  },
  {
    method: "get",
    path: "/api/admin/teams",
    summary: "List teams in the authorised hierarchy",
    tags: ["Tenancy"],
    admin: true,
    example: {
      request: {},
      response: { items: [{ id: "team-a", name: "Team A", quotaBytes: 107374182400 }] },
    },
  },
  {
    method: "post",
    path: "/api/admin/teams",
    summary: "Create a team with branding and quota",
    tags: ["Tenancy"],
    admin: true,
    successStatus: 201,
    example: {
      request: {
        id: "team-a",
        name: "Team A",
        quotaBytes: 107374182400,
        branding: { primaryColor: "#06b6d4" },
      },
      response: { id: "team-a", name: "Team A" },
    },
  },
  {
    method: "get",
    path: "/api/admin/roles",
    summary: "List builtin and custom role permissions",
    tags: ["Tenancy"],
    admin: true,
    example: {
      request: {},
      response: { items: [{ name: "Owner", permissions: ["storage.read", "team.manage"] }] },
    },
  },
  {
    method: "post",
    path: "/api/admin/roles",
    summary: "Define a custom tenant role",
    tags: ["Tenancy"],
    admin: true,
    successStatus: 201,
    example: {
      request: { name: "Auditor", tenantId: "team-a", inherits: ["Viewer"], permissions: ["audit.read"] },
      response: { saved: true },
    },
  },
  {
    method: "get",
    path: "/api/admin/api-keys",
    summary: "List API keys without secret hashes",
    tags: ["Tenancy"],
    admin: true,
    example: {
      request: { query: { tenantId: "team-a" } },
      response: { items: [{ id: "key-id", prefix: "fe_abcd", revoked: false }] },
    },
  },
  {
    method: "post",
    path: "/api/admin/api-keys",
    summary: "Issue a scoped API key and reveal its secret once",
    tags: ["Tenancy"],
    admin: true,
    successStatus: 201,
    example: {
      request: {
        name: "CI uploader",
        scope: {
          tenantId: "team-a",
          permissions: ["storage.write"],
          requestsPerMinute: 60,
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
      },
      response: { secret: "fe_<reveal-once>", record: { id: "key-id", revoked: false } },
    },
  },
  {
    method: "delete",
    path: "/api/admin/api-keys/{id}",
    summary: "Revoke an API key in the same tenant",
    tags: ["Tenancy"],
    admin: true,
    successStatus: 204,
    example: { request: { id: "key-id" }, response: {} },
  },
  {
    method: "get",
    path: "/api/admin/drm",
    summary: "List DRM policy templates",
    tags: ["DRM"],
    admin: true,
    example: {
      request: {},
      response: { items: [{ id: "read-only", allowedActions: ["view"], watermarkDensity: "high" }] },
    },
  },
  {
    method: "post",
    path: "/api/admin/drm",
    summary: "Bind a DRM policy template",
    tags: ["DRM"],
    admin: true,
    successStatus: 201,
    example: {
      request: {
        id: "read-only",
        tenantId: "team-a",
        name: "Read only",
        allowedActions: ["view"],
        allowedIps: ["*"],
        allowedDevices: [],
        mimePatterns: [],
        userIds: [],
        visibleWatermark: true,
        invisibleWatermark: true,
        watermarkDensity: "high",
        destructAfterExpiry: false,
      },
      response: { saved: true },
    },
  },
  {
    method: "get",
    path: "/api/admin/audit",
    summary: "Search, verify or export the signed audit chain",
    tags: ["Audit"],
    admin: true,
    example: {
      request: { query: { tenantId: "team-a", text: "storage", format: "jsonl", limit: 100 } },
      response: {
        items: [{ id: 1, action: "admin.post", outcome: "success", previousHash: "0".repeat(64) }],
        chainValid: true,
      },
    },
  },
  {
    method: "get",
    path: "/api/admin/monitoring",
    summary: "Read alert history and current metrics",
    tags: ["Observability"],
    admin: true,
    example: {
      request: {},
      response: { items: [{ rule: "ScanQueueDepth", active: false }], metrics: "scan_queue_depth 0" },
    },
  },
  {
    method: "post",
    path: "/api/admin/monitoring",
    summary: "Silence an alert rule until a timestamp",
    tags: ["Observability"],
    admin: true,
    example: {
      request: { rule: "ScanQueueDepth", until: "2026-11-23T00:00:00.000Z" },
      response: { saved: true },
    },
  },
];

export const OPENAPI_DOCUMENT = buildOpenApiDocument(API_OPERATIONS);

function buildOpenApiDocument(operations: ApiOperation[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const pathItem = paths[operation.path] ?? {};
    const responses: Record<string, unknown> = {
      [String(operation.successStatus ?? 200)]: responseDefinition(operation),
      "400": errorResponse("Invalid request", "INVALID_REQUEST"),
    };
    if (operation.admin) {
      responses["401"] = errorResponse("Authentication required", "UNAUTHENTICATED");
      responses["403"] = errorResponse("Permission or tenant scope denied", "FORBIDDEN");
    }
    pathItem[operation.method] = {
      operationId: operationId(operation),
      summary: operation.summary,
      tags: operation.tags,
      parameters: pathParameters(operation.path),
      ...(operation.admin ? { security: [{ bearerAuth: [] }, { apiKeyAuth: [] }] } : {}),
      ...(requiresBody(operation) ? { requestBody: requestBodyDefinition(operation) } : {}),
      responses,
      "x-codeSamples": [{ lang: "json", label: "Request and response", source: operation.example }],
    };
    paths[operation.path] = pathItem;
  }
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "FileExpress Enterprise API",
      version: "2.0.0",
      description: "Multi-tenant file transfer, resumable upload, storage, security, DRM and operations API.",
      license: { name: "UNLICENSED" },
    },
    servers: [{ url: "/", description: "Current FileExpress origin" }],
    tags: [...new Set(operations.flatMap((operation) => operation.tags))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
        apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string", description: "Stable human-readable error detail" } },
        },
        UploadSession: {
          type: "object",
          required: ["uploadId", "chunkSize", "totalChunks", "expiresAt"],
          properties: {
            uploadId: { type: "string", format: "uuid" },
            chunkSize: { type: "integer", minimum: 1 },
            totalChunks: { type: "integer", minimum: 1 },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        StorageHealth: {
          type: "object",
          required: ["backend", "kind", "healthy", "latencyMs", "checkedAt"],
          properties: {
            backend: { type: "string" },
            kind: { type: "string", enum: ["local", "s3", "azure", "db", "ipfs"] },
            healthy: { type: "boolean" },
            latencyMs: { type: "number", minimum: 0 },
            checkedAt: { type: "string", format: "date-time" },
          },
        },
        WebhookEvent: {
          type: "object",
          required: ["id", "type", "tenantId", "occurredAt", "idempotencyKey", "data"],
          properties: {
            id: { type: "string", format: "uuid" },
            type: {
              type: "string",
              enum: [
                "file.uploaded",
                "file.downloaded",
                "file.expired",
                "file.scanned",
                "scan.completed",
                "scan.threat_detected",
                "scan.error",
                "storage.quota_warning",
                "storage.backend_failed",
              ],
            },
            tenantId: { type: "string" },
            occurredAt: { type: "string", format: "date-time" },
            idempotencyKey: { type: "string" },
            data: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  };
}

function requiresBody(operation: ApiOperation): boolean {
  return !["get", "head", "delete", "options"].includes(operation.method);
}

function requestBodyDefinition(operation: ApiOperation): Record<string, unknown> {
  const contentType = operation.contentType ?? "application/json";
  return {
    required: true,
    content: {
      [contentType]: {
        schema: operation.binary
          ? { type: "string", format: "binary" }
          : { type: "object", additionalProperties: true },
        examples: { request: { value: operation.example.request } },
      },
    },
  };
}

function responseDefinition(operation: ApiOperation): Record<string, unknown> {
  if (
    (operation.successStatus ?? 200) === 204 ||
    operation.method === "head" ||
    operation.method === "options"
  ) {
    return { description: "Successful operation", headers: responseHeaders(operation.example.response) };
  }
  const contentType =
    operation.path === "/metrics"
      ? "text/plain; version=0.0.4"
      : operation.path === "/api/download/{code}"
        ? "application/octet-stream"
        : "application/json";
  return {
    description: "Successful operation",
    headers: responseHeaders(operation.example.response),
    content: {
      [contentType]: {
        schema: contentType === "application/octet-stream" ? { type: "string", format: "binary" } : {},
        examples: { success: { value: operation.example.response } },
      },
    },
  };
}

function responseHeaders(example: unknown): Record<string, unknown> {
  if (!example || typeof example !== "object" || !("headers" in example)) return {};
  const headers = (example as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      { schema: { type: "string" }, example: String(value) },
    ]),
  );
}

function pathParameters(path: string): Array<Record<string, unknown>> {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1 },
  }));
}

function operationId(operation: ApiOperation): string {
  const suffix = operation.path
    .replace(/^\//, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
  return `${operation.method}${suffix
    .split(" ")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("")}`;
}

function errorResponse(description: string, code: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
        example: { error: code },
      },
    },
  };
}
