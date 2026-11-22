import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { AuditLogger } from "../audit/logger";
import { FileAuditStore } from "../audit/store";
import { exportAuditCef, exportAuditJson } from "../audit/export";
import { DrmEnforcer } from "../drm/enforce";
import type { DrmPolicy } from "../drm/policy";
import { requireAdminAccess } from "../auth/middleware";
import { ApiKeyService, type ApiKeyScope } from "../auth/api-key";
import { RbacService, type RoleDefinition } from "../auth/rbac";
import { TeamService, type Team } from "../auth/team";
import { AlertManager, DEFAULT_ALERT_RULES } from "../observability/alerts";
import { httpDuration, metrics, scanQueueDepth } from "../observability/metrics";
import { HeuristicScanner } from "../security/heuristic";
import { ClamAvScanner } from "../security/clamav";
import { ClamAvDaemonScanner } from "../security/clamav-daemon";
import { VirusTotalScanner } from "../security/virustotal";
import { YaraScanner } from "../security/yara";
import { YaraCliRunner } from "../security/yara-cli";
import type { ScanEngine } from "../security/types";
import { ScanPipeline } from "../security/pipeline";
import { FileQuarantineStore } from "../security/quarantine";
import { createStorageBackend } from "../storage/factory";
import { CatalogError, FileCatalog } from "../storage/catalog";
import { StorageRegistry } from "../storage/registry";
import type { BackendConfig, BackendKind, FileMeta } from "../storage/types";
import { enabledStorageBackends, loadConfig } from "../config";
import { ChunkedUploadManager, UploadError } from "../upload/chunked";
import { createUploadRouter } from "../upload/routes";
import { TusUploadManager } from "../upload/tus";
import { MemoryEventBus } from "../webhooks/bus";
import { createEnvelope } from "../webhooks/bus";
import { WebhookDeliveryService, type WebhookEndpoint } from "../webhooks/delivery";

export function createEnterpriseRouter(dataDir = process.env.DATA_DIR ?? process.cwd()): Router {
  const router = Router();
  const registry = new StorageRegistry();
  const catalog = new FileCatalog(path.join(dataDir, "enterprise_catalog.json"));
  const secret = signingSecret();
  const audit = new AuditLogger(secret, new FileAuditStore(path.join(dataDir, "audit", "audit.jsonl")));
  const teams = new TeamService();
  const roles = new RbacService();
  const apiKeys = new ApiKeyService();
  const drm = new DrmEnforcer();
  const alerts = new AlertManager(DEFAULT_ALERT_RULES);
  const bus = new MemoryEventBus();
  const delivery = new WebhookDeliveryService({ fetchImpl: fetch });
  const quarantine = new FileQuarantineStore(path.join(dataDir, "quarantine"));
  const engines: ScanEngine[] = [new HeuristicScanner()];
  const clamavUrl = process.env.CLAMAV_URL;
  if (clamavUrl) {
    const endpoint = new URL(clamavUrl);
    if (endpoint.protocol === "tcp:")
      engines.push(new ClamAvDaemonScanner({ host: endpoint.hostname, port: Number(endpoint.port || 3310) }));
    else engines.push(new ClamAvScanner({ baseUrl: clamavUrl }));
  }
  if (process.env.YARA_RULES_PATH)
    engines.push(new YaraScanner(new YaraCliRunner({ rulesPath: process.env.YARA_RULES_PATH })));
  const virusTotal = process.env.VIRUSTOTAL_API_KEY
    ? new VirusTotalScanner({ apiKey: process.env.VIRUSTOTAL_API_KEY, callbackSecret: secret })
    : undefined;
  if (virusTotal) engines.push(virusTotal);
  const scans = new ScanPipeline({
    engines,
    quarantine,
    events: {
      publish: async (event, payload) => {
        await bus.publish(createEnvelope(event, String(payload.tenantId ?? "default"), payload));
      },
    },
  });
  bus.subscribe("*", async (event) => {
    await delivery.publish(event);
  });
  const chunked = new ChunkedUploadManager(path.join(dataDir, "uploads", "chunks"));
  const tus = new TusUploadManager(path.join(dataDir, "uploads", "tus"));
  const ready = (async () => {
    const config = loadConfig();
    const kinds = enabledStorageBackends(config);
    for (const [index, kind] of kinds.entries()) {
      const backendConfig = environmentBackendConfig(
        kind,
        dataDir,
        secret,
        kind === config.STORAGE_BACKEND,
        index,
      );
      await registry.register(createStorageBackend(backendConfig), backendConfig);
    }
  })();
  let initialisationError: unknown;
  void ready.catch((error: unknown) => {
    initialisationError = error;
  });

  router.use("/api", (_req, res, next) => {
    const started = performance.now();
    res.on("finish", () => {
      httpDuration.observe((performance.now() - started) / 1000, {
        route: String(_req.route?.path ?? "unmatched"),
        status: res.statusCode,
      });
      scanQueueDepth.set(scans.depth);
    });
    next();
  });
  router.use(
    "/api/upload",
    createUploadRouter(chunked, tus, {
      chunkSize: Number(process.env.MAX_CHUNK_SIZE_MB ?? 8) * 1048576,
      expiryHours: Number(process.env.UPLOAD_EXPIRY_HOURS ?? 24),
      onCompleted: async (upload) => {
        await ready;
        const expiresAt = new Date(
          Date.now() + Number(process.env.MAX_STORAGE_HOURS ?? 24) * 3600_000,
        ).toISOString();
        const meta: FileMeta = {
          id: upload.id,
          name: upload.fileName,
          size: upload.size,
          mimeType: upload.mimeType,
          tenantId: upload.tenantId,
          checksum: upload.checksum,
          createdAt: new Date().toISOString(),
          expiresAt,
          metadata: {},
        };
        const stored = await registry.uploadWithFailover(() => createReadStream(upload.filePath), meta);
        const backendName = stored.backendName ?? stored.backend;
        const entry = await catalog.createUpload({
          meta: {
            ...meta,
            size: stored.size,
            checksum: stored.checksum,
            backend: stored.backend,
            versionId: stored.versionId,
          },
          backendName,
          maxDownloads: Number(process.env.MAX_DOWNLOADS ?? 100),
          expiresAt,
        });
        await bus
          .publish(
            createEnvelope("file.uploaded", upload.tenantId, {
              id: upload.id,
              type: "private",
              size: stored.size,
              mime: upload.mimeType,
              user: "upload-api",
              backend: stored.backend,
            }),
          )
          .catch(() => false);
        void scans
          .scan(upload.id, () => createReadStream(upload.filePath), meta)
          .then(async (summary) => {
            const scanStatus =
              summary.verdict === "clean" && summary.action === "accept"
                ? "clean"
                : summary.action === "quarantine" || summary.action === "reject"
                  ? "quarantined"
                  : summary.verdict === "error"
                    ? "error"
                    : "pending";
            await catalog.markScan(upload.id, scanStatus, {
              verdict: summary.verdict,
              action: summary.action,
              results: summary.results,
            });
            if (scanStatus === "quarantined")
              await registry
                .get(backendName)
                .delete(upload.id)
                .catch(() => undefined);
            await bus
              .publish(
                createEnvelope("file.scanned", upload.tenantId, {
                  id: upload.id,
                  verdict: summary.verdict,
                  details: summary.results,
                }),
              )
              .catch(() => false);
          })
          .catch(async (error: unknown) => {
            await catalog.markScan(upload.id, "error", { error: message(error) }).catch(() => undefined);
          });
        return { pickupCode: entry.pickupCode };
      },
    }),
  );

  router.post("/api/webhook/virustotal", async (req, res) => {
    if (!virusTotal) return res.status(503).json({ error: "VirusTotal integration is disabled" });
    try {
      const payload = rawRequestBody(req);
      const timestamp = req.header("X-VirusTotal-Timestamp") ?? req.header("X-Timestamp") ?? "";
      const signature = req.header("X-VirusTotal-Signature") ?? req.header("X-Signature") ?? "";
      const result = virusTotal.handleCallback(payload, timestamp, signature);
      const checksum = callbackFileHash(req.body);
      const entry = checksum ? (await catalog.list()).find((file) => file.checksum === checksum) : undefined;
      if (entry) {
        const scanStatus =
          result.verdict === "malicious"
            ? "quarantined"
            : result.verdict === "error"
              ? "error"
              : entry.scanStatus;
        await catalog.markScan(entry.id, scanStatus, { ...entry.scanDetails, virustotal: result });
        if (scanStatus === "quarantined") {
          await registry
            .get(entry.backendName)
            .delete(entry.id)
            .catch(() => undefined);
          await bus
            .publish(
              createEnvelope("scan.threat_detected", entry.tenantId ?? "default", {
                id: entry.id,
                engine: result.engine,
                verdict: result.verdict,
                details: result.details,
              }),
            )
            .catch(() => false);
        }
      }
      return res.status(202).json({ accepted: true, result });
    } catch (error) {
      return res.status(400).json({ error: message(error) });
    }
  });

  router.post("/api/extract", async (req, res, next) => {
    try {
      const code = (req.body as Record<string, unknown>).code;
      if (typeof code !== "string") return next();
      const entry = await catalog.byPickupCode(code);
      if (!entry) return next();
      return res.json({
        success: true,
        fileName: entry.name,
        mimeType: entry.mimeType,
        scanStatus: entry.scanStatus,
        expiresAt: entry.expiresAt,
        remainingDownloads: Math.max(0, entry.maxDownloads - entry.downloadCount),
        downloadUrl: `/api/download/${entry.pickupCode}`,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/api/download/:code", async (req, res, next) => {
    try {
      const code = req.params.code;
      const candidate = code ? await catalog.byPickupCode(code) : undefined;
      if (!candidate || !code) return next();
      if (candidate.drmPolicyId) {
        drm.authorizeAndConsume(candidate.drmPolicyId, {
          userId: req.header("X-User-Id") ?? "anonymous",
          action: "download",
          ip: req.ip ?? "unknown",
          ...(req.header("X-Device-Id") ? { deviceId: req.header("X-Device-Id") } : {}),
          mimeType: candidate.mimeType,
          viewCount: candidate.downloadCount,
          tenantId: candidate.tenantId,
          ...(req.header("X-Project-Id") ? { projectId: req.header("X-Project-Id") } : {}),
        });
      }
      const entry = await catalog.consumeDownload(candidate.id);
      let completed = false;
      const rollback = () => {
        if (!completed) {
          completed = true;
          void catalog.releaseDownload(entry.id).catch(() => undefined);
        }
      };
      let stream: Readable;
      try {
        stream = await registry.get(entry.backendName).download(entry.id);
      } catch (error) {
        rollback();
        throw error;
      }
      res.attachment(entry.name);
      res.setHeader("Content-Type", entry.mimeType || "application/octet-stream");
      res.setHeader("Content-Length", String(entry.size));
      res.setHeader("X-Content-SHA256", entry.checksum ?? "");
      stream.on("error", (error) => {
        rollback();
        if (!res.headersSent) res.status(500).json({ error: message(error) });
        else res.destroy(error);
      });
      res.on("close", () => {
        if (!res.writableFinished) {
          stream.destroy();
          rollback();
        }
      });
      res.on("finish", () => {
        if (completed) return;
        completed = true;
        const remaining = Math.max(0, entry.maxDownloads - entry.downloadCount);
        void bus
          .publish(
            createEnvelope("file.downloaded", entry.tenantId ?? "default", {
              id: entry.id,
              code: entry.pickupCode,
              ip: req.ip,
              ua: req.header("User-Agent"),
              count: entry.downloadCount,
              remaining,
            }),
          )
          .catch(() => false);
        if (remaining === 0) {
          void registry
            .get(entry.backendName)
            .delete(entry.id)
            .then(() => catalog.remove(entry.id))
            .then(() =>
              bus.publish(
                createEnvelope("file.expired", entry.tenantId ?? "default", {
                  id: entry.id,
                  reason: "downloads",
                }),
              ),
            )
            .catch(() => undefined);
        }
      });
      return stream.pipe(res);
    } catch (error) {
      if (error instanceof CatalogError) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  });

  router.get("/health/live", (_req, res) => {
    res.json({ status: "ok", alive: true });
  });
  router.get("/health/ready", async (_req, res) => {
    await ready.catch(() => undefined);
    const backends = initialisationError ? [] : await registry.healthCheck();
    const healthy =
      !initialisationError && backends.length > 0 && backends.every((backend) => backend.healthy);
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ready" : "not_ready",
      healthy,
      backends,
      ...(initialisationError instanceof Error ? { error: initialisationError.message } : {}),
    });
  });
  router.get("/metrics", async (_req, res) => {
    res.type("text/plain; version=0.0.4").send(await metrics.render());
  });
  router.use("/api/admin", requireAdminAccess(apiKeys));
  router.use("/api/admin", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      res.on("finish", () => {
        try {
          audit.append({
            tenantId: req.header("X-Tenant-Id") ?? "default",
            actorId: req.header("X-User-Id") ?? "api-client",
            action: `admin.${req.method.toLowerCase()}`,
            resourceType: "admin_api",
            resourceId: req.path,
            ip: req.ip ?? "unknown",
            userAgent: req.header("User-Agent") ?? "unknown",
            outcome: res.statusCode < 400 ? "success" : "failure",
            details: { status: res.statusCode },
          });
        } catch (error) {
          console.error("Audit append failed", error);
        }
      });
    }
    next();
  });

  router.get("/api/admin/storage", async (_req, res) => {
    await ready;
    res.json({ items: registry.listConfigs(), health: await registry.healthCheck() });
  });
  router.post("/api/admin/storage", async (req, res) => {
    try {
      const config = req.body as BackendConfig;
      const backend = createStorageBackend(config);
      await registry.register(backend, config);
      const health = await backend.healthCheck();
      res
        .status(health.healthy ? 201 : 503)
        .json({ config: registry.listConfigs().find((item) => item.name === config.name), health });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });
  router.get("/api/admin/security", async (_req, res) => {
    const items = await Promise.all(
      engines.map(async (engine) => {
        try {
          return {
            id: engine.name,
            name: engine.name,
            healthy: true,
            signatureVersion: await engine.version(),
            queueDepth: scans.depth,
          };
        } catch (error) {
          return {
            id: engine.name,
            name: engine.name,
            healthy: false,
            error: message(error),
            queueDepth: scans.depth,
          };
        }
      }),
    );
    res.json({ items });
  });
  router.post("/api/admin/security", async (req, res) => {
    const filePath = readString(req, "filePath");
    if (!filePath || path.resolve(filePath).startsWith(path.resolve(dataDir)) === false)
      return res.status(400).json({ error: "filePath must be inside DATA_DIR" });
    const result = await scans.scan(
      String(req.body.id ?? path.basename(filePath)),
      () => createReadStream(filePath),
      {
        id: String(req.body.id ?? path.basename(filePath)),
        name: path.basename(filePath),
        size: Number(req.body.size ?? 0),
        mimeType: String(req.body.mimeType ?? "application/octet-stream"),
        createdAt: new Date().toISOString(),
        metadata: {},
      },
    );
    res.json(result);
  });
  router.get("/api/admin/webhooks", (req, res) => {
    const tenantId = String(req.query.tenantId ?? req.header("X-Tenant-Id") ?? "default");
    const endpoints = delivery.listEndpoints(tenantId);
    const endpointIds = new Set(endpoints.map((endpoint) => endpoint.id));
    res.json({
      items: endpoints,
      history: delivery.history().filter((item) => endpointIds.has(item.endpointId)),
    });
  });
  router.post("/api/admin/webhooks", (req, res) => {
    try {
      const body = req.body as Omit<WebhookEndpoint, "id">;
      res.status(201).json(delivery.addEndpoint(body));
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });
  router.get("/api/admin/teams", (req, res) => {
    const tenantId = req.header("X-Tenant-Id");
    const items = tenantId
      ? teams.list().filter((team) => team.id === tenantId || team.parentId === tenantId)
      : teams.list();
    res.json({ items });
  });
  router.post("/api/admin/teams", (req, res) => {
    try {
      res.status(201).json(teams.create(req.body as Team));
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });
  router.get("/api/admin/roles", (req, res) => {
    const builtins = ["Owner", "Admin", "Member", "Viewer", "Guest"].map((name) => ({
      name,
      permissions: roles.permissions(name),
    }));
    res.json({ items: [...builtins, ...roles.listRoles(req.header("X-Tenant-Id"))] });
  });
  router.post("/api/admin/roles", (req, res) => {
    try {
      roles.defineRole(req.body as RoleDefinition);
      res.status(201).json({ saved: true });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });
  router.get("/api/admin/api-keys", (req, res) => {
    res.json({
      items: apiKeys.listDto(String(req.query.tenantId ?? req.header("X-Tenant-Id") ?? "default")),
    });
  });
  router.post("/api/admin/api-keys", (req, res) => {
    try {
      const body = req.body as { name?: unknown; scope?: ApiKeyScope };
      if (typeof body.name !== "string" || !body.scope)
        return res.status(400).json({ error: "name and scope are required" });
      const issued = apiKeys.issue(body.name, body.scope);
      return res.status(201).json({ secret: issued.secret, record: apiKeys.getDto(issued.record.id) });
    } catch (error) {
      return res.status(400).json({ error: message(error) });
    }
  });
  router.delete("/api/admin/api-keys/:id", (req, res) => {
    const id = req.params.id;
    const record = id ? apiKeys.get(id) : undefined;
    const tenantId = req.header("X-Tenant-Id");
    if (record && tenantId && record.scope.tenantId !== tenantId)
      return res.status(403).json({ error: "Tenant scope mismatch" });
    if (!id || !record || !apiKeys.revoke(id)) return res.status(404).json({ error: "API key not found" });
    return res.status(204).end();
  });
  router.get("/api/admin/drm", (req, res) => {
    res.json({ items: drm.list(req.header("X-Tenant-Id")) });
  });
  router.post("/api/admin/drm", (req, res) => {
    try {
      drm.bind(req.body as DrmPolicy);
      res.status(201).json({ saved: true });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });
  router.get("/api/admin/audit", (req, res) => {
    const tenantId = String(req.query.tenantId ?? req.header("X-Tenant-Id") ?? "default");
    const items = audit.search({
      tenantId,
      text: optionalQuery(req, "text"),
      limit: Number(req.query.limit ?? 100),
    });
    if (req.query.format === "cef") res.type("text/plain").send(exportAuditCef(items));
    else if (req.query.format === "jsonl") res.type("application/x-ndjson").send(exportAuditJson(items));
    else res.json({ items, chainValid: audit.verify() });
  });
  router.get("/api/admin/monitoring", async (_req, res) => {
    res.json({ items: alerts.history(), metrics: await metrics.render() });
  });
  router.post("/api/admin/monitoring", (req, res) => {
    const rule = String(req.body.rule ?? "");
    const until = new Date(String(req.body.until ?? ""));
    if (!rule || Number.isNaN(until.getTime()))
      return res.status(400).json({ error: "rule and until are required" });
    alerts.silence(rule, until);
    res.json({ saved: true });
  });

  router.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
    void _next;
    const status = error instanceof UploadError ? error.status : 500;
    if (!res.headersSent) res.status(status).json({ error: message(error) });
  });
  return router;
}
function readString(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
function optionalQuery(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" && value ? value : undefined;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
function signingSecret(): string {
  if (process.env.WEBHOOK_SIGNING_SECRET) return process.env.WEBHOOK_SIGNING_SECRET;
  if (process.env.NODE_ENV === "production")
    throw new Error("WEBHOOK_SIGNING_SECRET is required in production");
  return "development-only-signing-secret";
}

function rawRequestBody(req: Request): string {
  if (typeof req.body === "string") return req.body;
  const raw = (req as Request & { rawBody?: string }).rawBody;
  if (raw !== undefined) return raw;
  return JSON.stringify(req.body as unknown);
}

function callbackFileHash(value: unknown): string | undefined {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const body = parsed as Record<string, unknown>;
  const meta = body.meta as Record<string, unknown> | undefined;
  const fileInfo = meta?.file_info as Record<string, unknown> | undefined;
  const data = body.data as Record<string, unknown> | undefined;
  const attributes = data?.attributes as Record<string, unknown> | undefined;
  const candidates = [fileInfo?.sha256, attributes?.sha256];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate),
  );
}

function environmentBackendConfig(
  kind: BackendKind,
  dataDir: string,
  secret: string,
  isDefault: boolean,
  priority: number,
): BackendConfig {
  const base = { name: kind, kind, enabled: true, priority, default: isDefault };
  switch (kind) {
    case "local":
      return { ...base, options: { root: path.join(dataDir, "local_storage"), signingSecret: secret } };
    case "s3":
      return {
        ...base,
        options: {
          bucket: process.env.S3_BUCKET ?? "",
          region: process.env.AWS_REGION ?? "us-east-1",
          endpoint: process.env.S3_ENDPOINT,
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
        },
      };
    case "azure":
      return {
        ...base,
        options: {
          container: process.env.AZURE_CONTAINER ?? "fileexpress",
          connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
          cdnBaseUrl: process.env.AZURE_CDN_BASE_URL,
          hierarchical: process.env.AZURE_HIERARCHICAL_NAMESPACE === "true",
        },
      };
    case "db":
      return {
        ...base,
        options: {
          connectionString: process.env.DATABASE_URL,
          table: process.env.DATABASE_OBJECT_TABLE ?? "fileexpress_objects",
          signingSecret: secret,
        },
      };
    case "ipfs":
      return {
        ...base,
        options: {
          apiUrl: process.env.IPFS_API_URL,
          gateway: process.env.IPFS_GATEWAY_URL,
          token: process.env.IPFS_API_TOKEN,
          pinningServiceUrl: process.env.IPFS_PINNING_SERVICE_URL,
          pinningServiceToken: process.env.IPFS_PINNING_SERVICE_TOKEN,
          mappingRoot: path.join(dataDir, "ipfs"),
          signingProxyUrl: process.env.IPFS_SIGNING_PROXY_URL,
          gatewayEnforcesSignatures: false,
        },
      };
  }
}
