import type { Readable } from "node:stream";
import type {
  BackendConfig,
  FileMeta,
  HealthStatus,
  StorageBackend,
  StorageRoute,
  UploadResult,
} from "./types";
import { safeErrorMessage } from "./utils";

export class StorageRegistry {
  private readonly backends = new Map<string, StorageBackend>();
  private readonly configs = new Map<string, BackendConfig>();
  private routes: StorageRoute[] = [];
  private defaultBackend = "";

  async register(backend: StorageBackend, config: BackendConfig): Promise<void> {
    if (!config.name) throw new Error("Storage backend name is required");
    if (this.backends.has(config.name)) throw new Error(`Storage backend already registered: ${config.name}`);
    await backend.init(config);
    this.backends.set(config.name, backend);
    this.configs.set(config.name, {
      ...config,
      mimePatterns: config.mimePatterns ? [...config.mimePatterns] : undefined,
      options: { ...config.options },
    });
    if (config.default || !this.defaultBackend) this.defaultBackend = config.name;
  }

  configureRoutes(routes: StorageRoute[], defaultBackend?: string): void {
    if (defaultBackend) this.require(defaultBackend);
    for (const route of routes) {
      this.require(route.backend);
      if (route.mimePattern) new RegExp(route.mimePattern);
      if (route.minSize !== undefined && (!Number.isSafeInteger(route.minSize) || route.minSize < 0))
        throw new Error("Invalid route minimum size");
      if (route.maxSize !== undefined && (!Number.isSafeInteger(route.maxSize) || route.maxSize < 0))
        throw new Error("Invalid route maximum size");
      if (route.minSize !== undefined && route.maxSize !== undefined && route.minSize > route.maxSize)
        throw new Error("Invalid route size range");
    }
    if (defaultBackend) this.defaultBackend = defaultBackend;
    this.routes = routes.map((route) => ({ ...route }));
  }

  get(name = this.defaultBackend): StorageBackend {
    return this.require(name);
  }

  listConfigs(): BackendConfig[] {
    return [...this.configs.values()].map((config) => ({
      ...config,
      ...(config.mimePatterns ? { mimePatterns: [...config.mimePatterns] } : {}),
      options: redactRecord(config.options),
    }));
  }

  routeFor(meta: Pick<FileMeta, "mimeType" | "size">): string[] {
    const explicit = this.routes.find((route) => {
      const mimeMatches = !route.mimePattern || new RegExp(route.mimePattern).test(meta.mimeType);
      const minMatches = route.minSize === undefined || meta.size >= route.minSize;
      const maxMatches = route.maxSize === undefined || meta.size <= route.maxSize;
      return mimeMatches && minMatches && maxMatches;
    })?.backend;
    const preferred = explicit ?? this.defaultBackend;
    return [
      preferred,
      ...[...this.configs.values()]
        .filter((config) => config.enabled && config.name !== preferred)
        .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
        .map((config) => config.name),
    ];
  }

  async uploadWithFailover(streamFactory: () => Readable, meta: FileMeta): Promise<UploadResult> {
    const candidates = this.routeFor(meta);
    const errors: string[] = [];
    const usedStreams = new Set<Readable>();
    for (const name of candidates) {
      let stream: Readable;
      try {
        stream = streamFactory();
        assertReplayableStream(stream, usedStreams);
        usedStreams.add(stream);
      } catch (error) {
        throw new Error("Upload failover requires a fresh replayable stream for every attempt", {
          cause: error,
        });
      }
      try {
        const result = await this.require(name).upload(stream, {
          ...meta,
          backend: this.configs.get(name)?.kind,
        });
        return { ...result, backendName: name };
      } catch (error) {
        stream.destroy();
        errors.push(`${name}: ${this.redactedError(error)}`);
      }
    }
    throw new AggregateError(
      errors.map((message) => new Error(message)),
      "All storage backends failed",
    );
  }

  async healthCheck(): Promise<HealthStatus[]> {
    return Promise.all(
      [...this.backends.entries()].map(async ([name, backend]) => {
        try {
          const status = await backend.healthCheck();
          return status.message
            ? { ...status, message: this.redactedError(new Error(status.message)) }
            : status;
        } catch (error) {
          return {
            backend: name,
            kind: this.configs.get(name)?.kind ?? "local",
            healthy: false,
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            message: this.redactedError(error),
          };
        }
      }),
    );
  }

  private require(name: string): StorageBackend {
    const backend = this.backends.get(name);
    if (!backend || this.configs.get(name)?.enabled === false)
      throw new Error(`Storage backend unavailable: ${name}`);
    return backend;
  }

  private redactedError(error: unknown): string {
    let message = safeErrorMessage(error);
    for (const secret of this.secretValues()) {
      if (secret.length >= 4) message = message.replaceAll(secret, "[REDACTED]");
    }
    return message.slice(0, 2000);
  }

  private secretValues(): string[] {
    const secrets: string[] = [];
    for (const config of this.configs.values()) collectSecrets(config.options, "", secrets);
    return secrets;
  }
}

function assertReplayableStream(stream: Readable, usedStreams: Set<Readable>): void {
  if (
    usedStreams.has(stream) ||
    stream.destroyed ||
    stream.readableEnded ||
    stream.readableDidRead ||
    stream.readableFlowing === true
  )
    throw new Error("Stream is not replayable");
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(key, item)]));
}

function redactValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return safeErrorMessage(new Error(value));
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item));
  if (isPlainRecord(value)) return redactRecord(value);
  if (typeof value === "object" && value !== null) return "[REDACTED]";
  return value;
}

function collectSecrets(value: Record<string, unknown>, prefix: string, secrets: string[]): void {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isSensitiveKey(key) && typeof item === "string" && item) secrets.push(item);
    if (typeof item === "string") {
      try {
        const url = new URL(item);
        if (url.username) secrets.push(decodeURIComponent(url.username));
        if (url.password) secrets.push(decodeURIComponent(url.password));
      } catch {
        continue;
      }
    }
    if (isPlainRecord(item)) collectSecrets(item, path, secrets);
    if (Array.isArray(item)) {
      for (const entry of item) {
        if (isPlainRecord(entry)) collectSecrets(entry, path, secrets);
        if (isSensitiveKey(key) && typeof entry === "string" && entry) secrets.push(entry);
      }
    }
  }
}

function isSensitiveKey(key: string): boolean {
  return /secret|password|token|access[-_]?key|account[-_]?key|api[-_]?key|connection[-_]?string|credential|authorization|private[-_]?key|signature|session[-_]?key/i.test(
    key,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
