export interface ApiOperation { method: "get" | "post" | "put" | "patch" | "delete" | "head" | "options"; path: string; summary: string; example: Record<string, unknown> }
export const API_OPERATIONS: ApiOperation[] = [
  { method: "post", path: "/api/upload/tus", summary: "Create a Tus 1.0.0 resumable upload", example: { headers: { "Tus-Resumable": "1.0.0", "Upload-Length": 104857600 }, response: { status: 201 } } },
  { method: "patch", path: "/api/upload/tus/{id}", summary: "Append bytes at the current offset", example: { headers: { "Upload-Offset": 0, "Content-Type": "application/offset+octet-stream" }, body: "<binary>" } },
  { method: "post", path: "/api/upload/chunks", summary: "Create a concurrent chunked upload", example: { fileName: "video.mp4", mimeType: "video/mp4", totalSize: 524288000, chunkSize: 8388608 } },
  { method: "put", path: "/api/upload/chunks/{id}/{index}", summary: "Upload a SHA-256 verified chunk", example: { headers: { "X-Chunk-SHA256": "64-lowercase-hex-characters" }, body: "<binary>" } },
  { method: "post", path: "/api/upload/chunks/{id}/complete", summary: "Merge all verified chunks", example: { uploadId: "uuid", checksum: "sha256", pickupCode: "A1B2C3" } },
  { method: "post", path: "/api/download/{code}", summary: "Download an authorised file", example: { code: "123456", policyId: "read-only" } },
  { method: "post", path: "/api/webhook/{endpointId}", summary: "Receive a signed event callback", example: { headers: { "X-FileExpress-Signature": "sha256=..." }, data: { id: "file-id" } } },
  { method: "get", path: "/health/ready", summary: "Kubernetes readiness with backend health", example: { healthy: true, backends: [{ backend: "local", healthy: true }] } },
  { method: "get", path: "/metrics", summary: "Prometheus text exposition", example: { contentType: "text/plain; version=0.0.4" } },
];
export const OPENAPI_DOCUMENT = { openapi: "3.1.0", info: { title: "FileExpress Enterprise API", version: "2.0.0" }, paths: Object.fromEntries(API_OPERATIONS.map((operation) => [operation.path, { [operation.method]: { summary: operation.summary, "x-codeSamples": [{ lang: "json", source: operation.example }], responses: { "200": { description: "Success" }, "400": { description: "Invalid request" } } } }])) };
