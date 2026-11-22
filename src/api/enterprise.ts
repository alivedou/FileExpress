import { createReadStream } from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { AuditLogger } from "../audit/logger";
import { exportAuditCef, exportAuditJson } from "../audit/export";
import { DrmEnforcer } from "../drm/enforce";
import type { DrmPolicy } from "../drm/policy";
import { requireAdminToken } from "../auth/middleware";
import { RbacService, type RoleDefinition } from "../auth/rbac";
import { TeamService, type Team } from "../auth/team";
import { AlertManager, DEFAULT_ALERT_RULES } from "../observability/alerts";
import { httpDuration, metrics, scanQueueDepth } from "../observability/metrics";
import { HeuristicScanner } from "../security/heuristic";
import { ScanPipeline } from "../security/pipeline";
import { FileQuarantineStore } from "../security/quarantine";
import { createStorageBackend } from "../storage/factory";
import { LocalStorageBackend } from "../storage/local";
import { StorageRegistry } from "../storage/registry";
import type { BackendConfig } from "../storage/types";
import { ChunkedUploadManager, UploadError } from "../upload/chunked";
import { createUploadRouter } from "../upload/routes";
import { TusUploadManager } from "../upload/tus";
import { MemoryEventBus } from "../webhooks/bus";
import { createEnvelope } from "../webhooks/bus";
import { WebhookDeliveryService, type WebhookEndpoint } from "../webhooks/delivery";

export function createEnterpriseRouter(dataDir = process.env.DATA_DIR ?? process.cwd()): Router {
  const router = Router();
  const registry = new StorageRegistry();
  const secret = signingSecret();
  const audit = new AuditLogger(secret);
  const teams = new TeamService();
  const roles = new RbacService();
  const drm = new DrmEnforcer();
  const alerts = new AlertManager(DEFAULT_ALERT_RULES);
  const bus = new MemoryEventBus();
  const delivery = new WebhookDeliveryService({ fetchImpl: fetch });
  const quarantine = new FileQuarantineStore(path.join(dataDir, "quarantine"));
  const scans = new ScanPipeline({ engines: [new HeuristicScanner()], quarantine, events: { publish: async (event, payload) => { await bus.publish(createEnvelope(event, String(payload.tenantId ?? "default"), payload)); } } });
  bus.subscribe("*", async (event) => { await delivery.publish(event); });
  const chunked = new ChunkedUploadManager(path.join(dataDir, "uploads", "chunks"));
  const tus = new TusUploadManager(path.join(dataDir, "uploads", "tus"));
  const ready = registry.register(new LocalStorageBackend(), { name: "local", kind: "local", enabled: true, priority: 0, default: true, options: { root: path.join(dataDir, "local_storage"), signingSecret: secret } });
  let initialisationError: unknown;
  void ready.catch((error: unknown) => { initialisationError = error; });

  router.use("/api", (_req, res, next) => {
    const started = performance.now();
    res.on("finish", () => { httpDuration.observe((performance.now() - started) / 1000, { route: String(_req.route?.path ?? "unmatched"), status: res.statusCode }); scanQueueDepth.set(scans.depth); });
    next();
  });
  router.use("/api/upload", createUploadRouter(chunked, tus, {
    chunkSize: Number(process.env.MAX_CHUNK_SIZE_MB ?? 8) * 1048576,
    expiryHours: Number(process.env.UPLOAD_EXPIRY_HOURS ?? 24),
    onCompleted: async (upload) => {
      await bus.publish(createEnvelope("file.uploaded", upload.tenantId, { id: upload.id, type: "private", size: upload.size, mime: upload.mimeType, user: "upload-api", backend: "local" })).catch(() => false);
      void scans.scan(upload.id, () => createReadStream(upload.filePath), { id: upload.id, name: upload.fileName, size: upload.size, mimeType: upload.mimeType, tenantId: upload.tenantId, createdAt: new Date().toISOString(), metadata: {} })
        .then(async (summary) => { await bus.publish(createEnvelope("file.scanned", upload.tenantId, { id: upload.id, verdict: summary.verdict, details: summary.results })).catch(() => false); })
        .catch(() => undefined);
    },
  }));

  router.get("/health/live", (_req, res) => { res.json({ status: "ok", alive: true }); });
  router.get("/health/ready", async (_req, res) => {
    await ready.catch(() => undefined);
    const backends = initialisationError ? [] : await registry.healthCheck();
    const healthy = !initialisationError && backends.length > 0 && backends.every((backend) => backend.healthy);
    res.status(healthy ? 200 : 503).json({ status: healthy ? "ready" : "not_ready", healthy, backends, ...(initialisationError instanceof Error ? { error: initialisationError.message } : {}) });
  });
  router.get("/metrics", async (_req, res) => { res.type("text/plain; version=0.0.4").send(await metrics.render()); });
  router.use("/api/admin", requireAdminToken);

  router.get("/api/admin/storage", async (_req, res) => { await ready; res.json({ items: registry.listConfigs(), health: await registry.healthCheck() }); });
  router.post("/api/admin/storage", async (req, res) => {
    try {
      const config = req.body as BackendConfig;
      const backend = createStorageBackend(config);
      await registry.register(backend, config);
      const health = await backend.healthCheck();
      res.status(health.healthy ? 201 : 503).json({ config: registry.listConfigs().find((item) => item.name === config.name), health });
    } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.get("/api/admin/security", (_req, res) => { res.json({ items: [{ id: "heuristic", name: "heuristic", healthy: true, queueDepth: scans.depth }] }); });
  router.post("/api/admin/security", async (req, res) => {
    const filePath = readString(req, "filePath");
    if (!filePath || path.resolve(filePath).startsWith(path.resolve(dataDir)) === false) return res.status(400).json({ error: "filePath must be inside DATA_DIR" });
    const result = await scans.scan(String(req.body.id ?? path.basename(filePath)), () => createReadStream(filePath), { id: String(req.body.id ?? path.basename(filePath)), name: path.basename(filePath), size: Number(req.body.size ?? 0), mimeType: String(req.body.mimeType ?? "application/octet-stream"), createdAt: new Date().toISOString(), metadata: {} });
    res.json(result);
  });
  router.get("/api/admin/webhooks", (req, res) => { res.json({ items: delivery.listEndpoints(String(req.query.tenantId ?? "default")), history: delivery.history() }); });
  router.post("/api/admin/webhooks", (req, res) => {
    try { const body = req.body as Omit<WebhookEndpoint, "id">; res.status(201).json(delivery.addEndpoint(body)); } catch (error) { res.status(400).json({ error: message(error) }); }
  });
  router.get("/api/admin/teams", (_req, res) => { res.json({ items: [] }); });
  router.post("/api/admin/teams", (req, res) => { try { res.status(201).json(teams.create(req.body as Team)); } catch (error) { res.status(400).json({ error: message(error) }); } });
  router.get("/api/admin/roles", (_req, res) => { res.json({ items: ["Owner", "Admin", "Member", "Viewer", "Guest"].map((name) => ({ name, permissions: roles.permissions(name) })) }); });
  router.post("/api/admin/roles", (req, res) => { try { roles.defineRole(req.body as RoleDefinition); res.status(201).json({ saved: true }); } catch (error) { res.status(400).json({ error: message(error) }); } });
  router.get("/api/admin/drm", (_req, res) => { res.json({ items: [] }); });
  router.post("/api/admin/drm", (req, res) => { try { drm.bind(req.body as DrmPolicy); res.status(201).json({ saved: true }); } catch (error) { res.status(400).json({ error: message(error) }); } });
  router.get("/api/admin/audit", (req, res) => {
    const tenantId = String(req.query.tenantId ?? "default");
    const items = audit.search({ tenantId, text: optionalQuery(req, "text"), limit: Number(req.query.limit ?? 100) });
    if (req.query.format === "cef") res.type("text/plain").send(exportAuditCef(items));
    else if (req.query.format === "jsonl") res.type("application/x-ndjson").send(exportAuditJson(items));
    else res.json({ items, chainValid: audit.verify() });
  });
  router.post("/api/admin/audit", (req, res) => { try { res.status(201).json(audit.append(req.body)); } catch (error) { res.status(400).json({ error: message(error) }); } });
  router.get("/api/admin/monitoring", async (_req, res) => { res.json({ items: alerts.history(), metrics: await metrics.render() }); });
  router.post("/api/admin/monitoring", (req, res) => { const rule = String(req.body.rule ?? ""); const until = new Date(String(req.body.until ?? "")); if (!rule || Number.isNaN(until.getTime())) return res.status(400).json({ error: "rule and until are required" }); alerts.silence(rule, until); res.json({ saved: true }); });

  router.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
    const status = error instanceof UploadError ? error.status : 500;
    if (!res.headersSent) res.status(status).json({ error: message(error) });
  });
  return router;
}
function readString(req: Request, key: string): string { const value = (req.body as Record<string, unknown>)[key]; return typeof value === "string" ? value : ""; }
function optionalQuery(req: Request, key: string): string | undefined { const value = req.query[key]; return typeof value === "string" && value ? value : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
function signingSecret(): string {
  if (process.env.WEBHOOK_SIGNING_SECRET) return process.env.WEBHOOK_SIGNING_SECRET;
  if (process.env.NODE_ENV === "production") throw new Error("WEBHOOK_SIGNING_SECRET is required in production");
  return "development-only-signing-secret";
}
