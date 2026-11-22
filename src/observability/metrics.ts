export type Labels = Record<string, string | number>;
interface Sample { labels: Labels; value: number }
interface Metric { name: string; help: string; type: "counter" | "gauge" | "histogram"; samples: Sample[]; buckets?: number[]; values?: Array<{ labels: Labels; sum: number; count: number; buckets: number[] }> }

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  counter(name: string, help: string): { inc(labels?: Labels, amount?: number): void } {
    const metric = this.ensure(name, help, "counter");
    return { inc: (labels = {}, amount = 1) => { if (amount < 0) throw new Error("Counter cannot decrease"); const sample = findSample(metric.samples, labels); sample.value += amount; } };
  }
  gauge(name: string, help: string): { set(value: number, labels?: Labels): void; inc(labels?: Labels, amount?: number): void } {
    const metric = this.ensure(name, help, "gauge");
    return { set: (value, labels = {}) => { findSample(metric.samples, labels).value = value; }, inc: (labels = {}, amount = 1) => { findSample(metric.samples, labels).value += amount; } };
  }
  histogram(name: string, help: string, buckets = [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5]): { observe(value: number, labels?: Labels): void } {
    const metric = this.ensure(name, help, "histogram");
    metric.buckets = [...buckets].sort((left, right) => left - right);
    metric.values = [];
    return { observe: (value, labels = {}) => {
      const item = metric.values?.find((candidate) => sameLabels(candidate.labels, labels));
      const target = item ?? { labels, sum: 0, count: 0, buckets: Array(metric.buckets.length).fill(0) as number[] };
      if (!item) metric.values?.push(target);
      target.sum += value; target.count += 1;
      target.buckets = target.buckets.map((count, index) => count + (value <= (metric.buckets?.[index] ?? Infinity) ? 1 : 0));
    } };
  }
  async render(): Promise<string> {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
      if (metric.type === "histogram") for (const value of metric.values ?? []) {
        metric.buckets?.forEach((bucket, index) => lines.push(`${metric.name}_bucket${formatLabels({ ...value.labels, le: bucket })} ${value.buckets[index] ?? 0}`));
        lines.push(`${metric.name}_bucket${formatLabels({ ...value.labels, le: "+Inf" })} ${value.count}`, `${metric.name}_sum${formatLabels(value.labels)} ${value.sum}`, `${metric.name}_count${formatLabels(value.labels)} ${value.count}`);
      }
      else for (const sample of metric.samples) lines.push(`${metric.name}${formatLabels(sample.labels)} ${sample.value}`);
    }
    return `${lines.join("\n")}\n`;
  }
  value(name: string, labels: Labels = {}): number { const metric = this.metrics.get(name); return metric ? findSample(metric.samples, labels).value : 0; }
  private ensure(name: string, help: string, type: Metric["type"]): Metric {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error("Invalid metric name");
    const existing = this.metrics.get(name);
    if (existing) { if (existing.type !== type) throw new Error("Metric already registered with another type"); return existing; }
    const metric: Metric = { name, help, type, samples: [] };
    this.metrics.set(name, metric);
    return metric;
  }
}
function findSample(samples: Sample[], labels: Labels): Sample { const found = samples.find((sample) => sameLabels(sample.labels, labels)); if (found) return found; const sample = { labels: { ...labels }, value: 0 }; samples.push(sample); return sample; }
function sameLabels(left: Labels, right: Labels): boolean { return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort()); }
function formatLabels(labels: Labels): string { const entries = Object.entries(labels); return entries.length ? `{${entries.map(([key, value]) => `${key}="${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`).join(",")}}` : ""; }

export const metrics = new MetricsRegistry();
export const httpDuration = metrics.histogram("http_req_duration_seconds", "HTTP request duration");
export const uploadBytes = metrics.counter("upload_bytes_total", "Uploaded bytes");
export const downloadBytes = metrics.counter("download_bytes_total", "Downloaded bytes");
export const storageUsage = metrics.gauge("storage_usage_pct", "Storage usage percentage");
export const scanQueueDepth = metrics.gauge("scan_queue_depth", "Pending scan jobs");
export const activeSessions = metrics.gauge("active_sessions", "Active user sessions");
export const errorsByType = metrics.counter("errors_total", "Errors by type");
