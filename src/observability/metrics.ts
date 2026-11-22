export type Labels = Record<string, string | number>;
export interface MetricsRegistryOptions {
  maxSeries?: number;
  maxSeriesPerMetric?: number;
  maxLabelsPerSeries?: number;
  maxLabelNameLength?: number;
  maxLabelValueLength?: number;
  maxHelpLength?: number;
  maxBuckets?: number;
}
interface Limits {
  maxSeries: number;
  maxSeriesPerMetric: number;
  maxLabelsPerSeries: number;
  maxLabelNameLength: number;
  maxLabelValueLength: number;
  maxHelpLength: number;
  maxBuckets: number;
}
interface CanonicalLabels {
  values: Labels;
  key: string;
}
interface Series {
  labels: Labels;
  value: number;
  sum: number;
  count: number;
  bucketCounts: number[];
}
interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  buckets: number[];
  series: Map<string, Series>;
}
interface LocatedSeries {
  canonical: CanonicalLabels;
  series: Series | undefined;
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5];
const DEFAULT_LIMITS: Limits = {
  maxSeries: 10_000,
  maxSeriesPerMetric: 1000,
  maxLabelsPerSeries: 20,
  maxLabelNameLength: 128,
  maxLabelValueLength: 256,
  maxHelpLength: 1024,
  maxBuckets: 100,
};
const CONTROLLED_LABELS = ["route", "method", "status", "backend", "type"];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const BACKENDS = new Set(["local", "s3", "azure", "ipfs"]);
const ERROR_TYPES = new Set([
  "validation",
  "authentication",
  "authorization",
  "storage",
  "network",
  "scan",
  "upload",
  "download",
  "internal",
  "unknown",
]);

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly limits: Limits;
  private seriesCount = 0;

  constructor(options: MetricsRegistryOptions = {}) {
    this.limits = {
      maxSeries: limit(options.maxSeries, DEFAULT_LIMITS.maxSeries, "maxSeries"),
      maxSeriesPerMetric: limit(
        options.maxSeriesPerMetric,
        DEFAULT_LIMITS.maxSeriesPerMetric,
        "maxSeriesPerMetric",
      ),
      maxLabelsPerSeries: limit(
        options.maxLabelsPerSeries,
        DEFAULT_LIMITS.maxLabelsPerSeries,
        "maxLabelsPerSeries",
      ),
      maxLabelNameLength: limit(
        options.maxLabelNameLength,
        DEFAULT_LIMITS.maxLabelNameLength,
        "maxLabelNameLength",
      ),
      maxLabelValueLength: limit(
        options.maxLabelValueLength,
        DEFAULT_LIMITS.maxLabelValueLength,
        "maxLabelValueLength",
      ),
      maxHelpLength: limit(options.maxHelpLength, DEFAULT_LIMITS.maxHelpLength, "maxHelpLength"),
      maxBuckets: limit(options.maxBuckets, DEFAULT_LIMITS.maxBuckets, "maxBuckets"),
    };
  }

  counter(name: string, help: string): { inc(labels?: Labels, amount?: number): void } {
    const metric = this.ensure(name, help, "counter");
    return {
      inc: (labels = {}, amount = 1) => {
        assertFinite(amount);
        if (amount < 0) throw new Error("Counter cannot decrease");
        const located = this.locate(metric, labels);
        const next = (located.series?.value ?? 0) + amount;
        assertFinite(next);
        const target = located.series ?? this.createSeries(metric, located.canonical);
        target.value = next;
      },
    };
  }

  gauge(
    name: string,
    help: string,
  ): { set(value: number, labels?: Labels): void; inc(labels?: Labels, amount?: number): void } {
    const metric = this.ensure(name, help, "gauge");
    return {
      set: (value, labels = {}) => {
        assertFinite(value);
        const located = this.locate(metric, labels);
        const target = located.series ?? this.createSeries(metric, located.canonical);
        target.value = value;
      },
      inc: (labels = {}, amount = 1) => {
        assertFinite(amount);
        const located = this.locate(metric, labels);
        const next = (located.series?.value ?? 0) + amount;
        assertFinite(next);
        const target = located.series ?? this.createSeries(metric, located.canonical);
        target.value = next;
      },
    };
  }

  histogram(
    name: string,
    help: string,
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ): { observe(value: number, labels?: Labels): void } {
    const metric = this.ensure(name, help, "histogram", buckets);
    return {
      observe: (value, labels = {}) => {
        assertFinite(value);
        const located = this.locate(metric, labels);
        const nextSum = (located.series?.sum ?? 0) + value;
        const nextCount = (located.series?.count ?? 0) + 1;
        assertFinite(nextSum);
        assertFinite(nextCount);
        const target = located.series ?? this.createSeries(metric, located.canonical);
        target.sum = nextSum;
        target.count = nextCount;
        for (let index = 0; index < metric.buckets.length; index += 1) {
          const bucket = metric.buckets[index];
          if (bucket !== undefined && value <= bucket)
            target.bucketCounts[index] = (target.bucketCounts[index] ?? 0) + 1;
        }
      },
    };
  }

  async render(): Promise<string> {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${formatHelp(metric.help)}`, `# TYPE ${metric.name} ${metric.type}`);
      for (const series of metric.series.values()) {
        if (metric.type !== "histogram") {
          lines.push(`${metric.name}${formatLabels(series.labels)} ${series.value}`);
          continue;
        }
        for (let index = 0; index < metric.buckets.length; index += 1) {
          const bucket = metric.buckets[index];
          if (bucket !== undefined)
            lines.push(
              `${metric.name}_bucket${formatLabels({ ...series.labels, le: bucket })} ${series.bucketCounts[index] ?? 0}`,
            );
        }
        lines.push(
          `${metric.name}_bucket${formatLabels({ ...series.labels, le: "+Inf" })} ${series.count}`,
          `${metric.name}_sum${formatLabels(series.labels)} ${series.sum}`,
          `${metric.name}_count${formatLabels(series.labels)} ${series.count}`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }

  value(name: string, labels: Labels = {}): number {
    const metric = this.metrics.get(name);
    if (!metric || metric.type === "histogram") return 0;
    const canonical = canonicalizeLabels(labels, this.limits);
    return metric.series.get(canonical.key)?.value ?? 0;
  }

  private ensure(name: string, help: string, type: Metric["type"], buckets: readonly number[] = []): Metric {
    if (typeof name !== "string" || name.length > 255 || !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name))
      throw new Error("Invalid metric name");
    if (typeof help !== "string" || !help.trim() || help.length > this.limits.maxHelpLength)
      throw new Error("Invalid metric help");
    const normalizedBuckets = type === "histogram" ? normalizeBuckets(buckets, this.limits.maxBuckets) : [];
    const existing = this.metrics.get(name);
    if (existing) {
      if (
        existing.type !== type ||
        existing.help !== help ||
        !sameNumbers(existing.buckets, normalizedBuckets)
      )
        throw new Error("Metric already registered with another type or conflicting definition");
      return existing;
    }
    const metric: Metric = {
      name,
      help,
      type,
      buckets: normalizedBuckets,
      series: new Map<string, Series>(),
    };
    this.metrics.set(name, metric);
    return metric;
  }

  private locate(metric: Metric, labels: Labels): LocatedSeries {
    if (metric.type === "histogram" && Object.prototype.hasOwnProperty.call(labels, "le"))
      throw new Error("Invalid label name: le");
    const canonical = canonicalizeLabels(labels, this.limits);
    return { canonical, series: metric.series.get(canonical.key) };
  }

  private createSeries(metric: Metric, canonical: CanonicalLabels): Series {
    if (this.seriesCount >= this.limits.maxSeries || metric.series.size >= this.limits.maxSeriesPerMetric)
      throw new Error("Metric series limit exceeded");
    const series: Series = {
      labels: canonical.values,
      value: 0,
      sum: 0,
      count: 0,
      bucketCounts: Array.from({ length: metric.buckets.length }, () => 0),
    };
    metric.series.set(canonical.key, series);
    this.seriesCount += 1;
    return series;
  }
}

function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Invalid ${name}`);
  return result;
}

function assertFinite(value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Metric value must be finite");
}

function normalizeBuckets(buckets: readonly number[], maxBuckets: number): number[] {
  if (!Array.isArray(buckets) || buckets.length < 1 || buckets.length > maxBuckets)
    throw new Error("Invalid histogram buckets");
  const normalized = [...buckets].sort((left, right) => left - right);
  for (let index = 0; index < normalized.length; index += 1) {
    const bucket = normalized[index];
    if (bucket === undefined || !Number.isFinite(bucket) || (index > 0 && bucket === normalized[index - 1]))
      throw new Error("Invalid histogram buckets");
  }
  return normalized;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalizeLabels(labels: Labels, limits: Limits): CanonicalLabels {
  if (typeof labels !== "object" || labels === null || Array.isArray(labels))
    throw new Error("Invalid labels");
  const source = Object.entries(labels);
  if (source.length > limits.maxLabelsPerSeries) throw new Error("Too many metric labels");
  const entries: Array<[string, string]> = [];
  for (const [name, rawValue] of source) {
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
      name.startsWith("__") ||
      name.length > limits.maxLabelNameLength
    )
      throw new Error(`Invalid label name: ${name}`);
    if (
      (typeof rawValue !== "string" && typeof rawValue !== "number") ||
      (typeof rawValue === "number" && !Number.isFinite(rawValue))
    )
      throw new Error(`Invalid label value: ${name}`);
    const value = String(rawValue);
    if (value.length > limits.maxLabelValueLength) throw new Error(`Label value too long: ${name}`);
    entries.push([name, value]);
  }
  const key = JSON.stringify(
    [...entries].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
  );
  return { values: Object.fromEntries(entries), key };
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  return entries.length
    ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(",")}}`
    : "";
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function formatHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

export function normalizeLabels(labels: Labels = {}): Labels {
  return canonicalizeLabels(labels, DEFAULT_LIMITS).values;
}

export function normalizeControlledLabels(
  labels: Labels = {},
  allowedLabels: readonly string[] = CONTROLLED_LABELS,
): Labels {
  const allowed = new Set(allowedLabels);
  const entries = Object.entries(normalizeLabels(labels)).filter(
    ([name]) => allowed.has(name) && !/(?:^|_)(?:id|url|uri)(?:$|_)/i.test(name),
  );
  return Object.fromEntries(entries.map(([name, value]) => [name, controlledValue(name, String(value))]));
}

function controlledValue(name: string, value: string): string {
  if (name === "method") {
    const method = value.toUpperCase();
    return METHODS.has(method) ? method : "OTHER";
  }
  if (name === "backend") {
    const backend = value.toLowerCase();
    return BACKENDS.has(backend) ? backend : "other";
  }
  if (name === "type") {
    const type = value.toLowerCase();
    return ERROR_TYPES.has(type) ? type : "other";
  }
  if (name === "status") return /^[1-5][0-9][0-9]$/.test(value) ? value : "unknown";
  if (name === "route") {
    const route = value.trim();
    if (!route || route.length > 128 || /[?#\u0000-\u001f\u007f]/.test(route) || route.includes("://"))
      return "unmatched";
    return route
      .split("/")
      .map((segment) =>
        /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? ":id" : segment,
      )
      .join("/");
  }
  return value;
}

export const metrics = new MetricsRegistry();
const httpDurationMetric = metrics.histogram("http_req_duration_seconds", "HTTP request duration");
const uploadBytesMetric = metrics.counter("upload_bytes_total", "Uploaded bytes");
const downloadBytesMetric = metrics.counter("download_bytes_total", "Downloaded bytes");
const storageUsageMetric = metrics.gauge("storage_usage_pct", "Storage usage percentage");
const scanQueueDepthMetric = metrics.gauge("scan_queue_depth", "Pending scan jobs");
const activeSessionsMetric = metrics.gauge("active_sessions", "Active user sessions");
const errorsByTypeMetric = metrics.counter("errors_total", "Errors by type");
export const httpDuration = {
  observe: (value: number, labels: Labels = {}): void => {
    if (value < 0) throw new Error("HTTP duration cannot be negative");
    httpDurationMetric.observe(value, normalizeControlledLabels(labels, ["route", "method", "status"]));
  },
};
export const uploadBytes = {
  inc: (labels: Labels = {}, amount = 1): void =>
    uploadBytesMetric.inc(normalizeControlledLabels(labels, ["backend"]), amount),
};
export const downloadBytes = {
  inc: (labels: Labels = {}, amount = 1): void =>
    downloadBytesMetric.inc(normalizeControlledLabels(labels, ["backend"]), amount),
};
export const storageUsage = {
  set: (value: number, labels: Labels = {}): void =>
    storageUsageMetric.set(value, normalizeControlledLabels(labels, ["backend"])),
  inc: (labels: Labels = {}, amount = 1): void =>
    storageUsageMetric.inc(normalizeControlledLabels(labels, ["backend"]), amount),
};
export const scanQueueDepth = {
  set: (value: number, labels: Labels = {}): void =>
    scanQueueDepthMetric.set(value, normalizeControlledLabels(labels, [])),
  inc: (labels: Labels = {}, amount = 1): void =>
    scanQueueDepthMetric.inc(normalizeControlledLabels(labels, []), amount),
};
export const activeSessions = {
  set: (value: number, labels: Labels = {}): void =>
    activeSessionsMetric.set(value, normalizeControlledLabels(labels, [])),
  inc: (labels: Labels = {}, amount = 1): void =>
    activeSessionsMetric.inc(normalizeControlledLabels(labels, []), amount),
};
export const errorsByType = {
  inc: (labels: Labels = {}, amount = 1): void =>
    errorsByTypeMetric.inc(normalizeControlledLabels(labels, ["type"]), amount),
};

const uploadThroughputGauge = metrics.gauge(
  "upload_throughput_mbps",
  "Upload throughput in megabits per second",
);
const downloadThroughputGauge = metrics.gauge(
  "download_throughput_mbps",
  "Download throughput in megabits per second",
);
const errorRateGauge = metrics.gauge("error_rate_by_type", "Error rate by controlled error type");
const storageHealthGauge = metrics.gauge("storage_backend_healthy", "Storage backend health");

export const uploadThroughput = {
  set: (value: number, labels: Labels = {}): void =>
    uploadThroughputGauge.set(value, normalizeControlledLabels(labels, ["backend"])),
  inc: (labels: Labels = {}, amount = 1): void =>
    uploadThroughputGauge.inc(normalizeControlledLabels(labels, ["backend"]), amount),
};
export const downloadThroughput = {
  set: (value: number, labels: Labels = {}): void =>
    downloadThroughputGauge.set(value, normalizeControlledLabels(labels, ["backend"])),
  inc: (labels: Labels = {}, amount = 1): void =>
    downloadThroughputGauge.inc(normalizeControlledLabels(labels, ["backend"]), amount),
};
export const errorRateByType = {
  set: (value: number, labels: Labels = {}): void =>
    errorRateGauge.set(value, normalizeControlledLabels(labels, ["type"])),
  inc: (labels: Labels = {}, amount = 1): void =>
    errorRateGauge.inc(normalizeControlledLabels(labels, ["type"]), amount),
};
export const storageBackendHealthy = {
  set: (value: number, labels: Labels = {}): void =>
    storageHealthGauge.set(value, normalizeControlledLabels(labels, ["backend"])),
  inc: (labels: Labels = {}, amount = 1): void =>
    storageHealthGauge.inc(normalizeControlledLabels(labels, ["backend"]), amount),
};
export const uploadThroughputMbps = uploadThroughput;
export const downloadThroughputMbps = downloadThroughput;
