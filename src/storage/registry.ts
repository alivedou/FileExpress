import type { Readable } from "node:stream";
import type {
  BackendConfig,
  FileMeta,
  HealthStatus,
  StorageBackend,
  StorageRoute,
  UploadResult,
} from "./types";

export class StorageRegistry {
  private readonly backends = new Map<string, StorageBackend>();
  private readonly configs = new Map<string, BackendConfig>();
  private routes: StorageRoute[] = [];
  private defaultBackend = "";

  async register(backend: StorageBackend, config: BackendConfig): Promise<void> {
    if (this.backends.has(config.name)) throw new Error(`Storage backend already registered: ${config.name}`);
    await backend.init(config);
    this.backends.set(config.name, backend);
    this.configs.set(config.name, config);
    if (config.default || !this.defaultBackend) this.defaultBackend = config.name;
  }

  configureRoutes(routes: StorageRoute[], defaultBackend?: string): void {
    if (defaultBackend) {
      this.require(defaultBackend);
      this.defaultBackend = defaultBackend;
    }
    for (const route of routes) this.require(route.backend);
    this.routes = [...routes];
  }

  get(name = this.defaultBackend): StorageBackend {
    return this.require(name);
  }

  listConfigs(): BackendConfig[] {
    return [...this.configs.values()].map((config) => ({
      ...config,
      options: Object.fromEntries(Object.entries(config.options).map(([key, value]) => [
        key,
        /secret|password|token|accesskey|connectionstring|credential/i.test(key) ? "[REDACTED]" : value,
      ])),
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
        .sort((left, right) => left.priority - right.priority)
        .map((config) => config.name),
    ];
  }

  async uploadWithFailover(streamFactory: () => Readable, meta: FileMeta): Promise<UploadResult> {
    const candidates = this.routeFor(meta);
    const errors: string[] = [];
    for (const name of candidates) {
      try {
        return await this.require(name).upload(streamFactory(), { ...meta, backend: this.configs.get(name)?.kind });
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    throw new AggregateError(errors.map((message) => new Error(message)), "All storage backends failed");
  }

  async healthCheck(): Promise<HealthStatus[]> {
    return Promise.all(
      [...this.backends.entries()].map(async ([name, backend]) => {
        try {
          return await backend.healthCheck();
        } catch (error) {
          return {
            backend: name,
            kind: this.configs.get(name)?.kind ?? "local",
            healthy: false,
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            message: error instanceof Error ? error.message : "Unknown storage error",
          };
        }
      }),
    );
  }

  private require(name: string): StorageBackend {
    const backend = this.backends.get(name);
    if (!backend || this.configs.get(name)?.enabled === false) {
      throw new Error(`Storage backend unavailable: ${name}`);
    }
    return backend;
  }
}
