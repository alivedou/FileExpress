export interface AlertRule { name: string; metric: string; threshold: number; comparison: "gt" | "gte" | "lt" | "lte"; severity: "info" | "warning" | "critical"; forMs?: number }
export interface AlertState { rule: string; severity: AlertRule["severity"]; active: boolean; since: string; value: number; silencedUntil?: string }

export class AlertManager {
  private readonly states = new Map<string, AlertState>();
  private readonly pending = new Map<string, number>();
  private readonly silences = new Map<string, number>();
  constructor(private readonly rules: AlertRule[]) {}
  evaluate(values: Record<string, number>, now = new Date()): AlertState[] {
    for (const rule of this.rules) {
      const value = values[rule.metric] ?? 0;
      const triggered = compare(value, rule.threshold, rule.comparison);
      const existing = this.states.get(rule.name);
      if (triggered && !existing) {
        const since = this.pending.get(rule.name) ?? now.getTime();
        this.pending.set(rule.name, since);
        if (now.getTime() - since >= (rule.forMs ?? 0)) this.states.set(rule.name, { rule: rule.name, severity: rule.severity, active: true, since: new Date(since).toISOString(), value, ...(this.silences.get(rule.name) ? { silencedUntil: new Date(this.silences.get(rule.name) ?? 0).toISOString() } : {}) });
      } else if (triggered && existing) existing.value = value;
      else { this.pending.delete(rule.name); if (existing) existing.active = false; }
    }
    return this.history();
  }
  silence(rule: string, until: Date): void { this.silences.set(rule, until.getTime()); const state = this.states.get(rule); if (state) state.silencedUntil = until.toISOString(); }
  history(): AlertState[] { return [...this.states.values()].map((state) => ({ ...state })); }
}
export const DEFAULT_ALERT_RULES: AlertRule[] = [
  { name: "DiskUsageHigh", metric: "storage_usage_pct", threshold: 80, comparison: "gt", severity: "warning" },
  { name: "ScanQueueBacklog", metric: "scan_queue_depth", threshold: 100, comparison: "gt", severity: "warning" },
  { name: "ErrorRateHigh", metric: "error_rate", threshold: 5, comparison: "gt", severity: "critical", forMs: 60_000 },
  { name: "LatencyP99High", metric: "http_p99_seconds", threshold: 5, comparison: "gt", severity: "warning" },
  { name: "StorageBackendDown", metric: "storage_backend_healthy", threshold: 1, comparison: "lt", severity: "critical" },
];
function compare(value: number, threshold: number, comparison: AlertRule["comparison"]): boolean { return comparison === "gt" ? value > threshold : comparison === "gte" ? value >= threshold : comparison === "lt" ? value < threshold : value <= threshold; }
