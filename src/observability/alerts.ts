export interface AlertRule {
  name: string;
  metric: string;
  threshold: number;
  comparison: "gt" | "gte" | "lt" | "lte";
  severity: "info" | "warning" | "critical";
  forMs?: number;
}
export interface AlertState {
  rule: string;
  severity: AlertRule["severity"];
  active: boolean;
  since: string;
  value: number;
  silencedUntil?: string;
}
export type AlertPhase = "pending" | "firing" | "resolved";
export interface AlertTransition {
  readonly rule: string;
  readonly from: AlertPhase | "none";
  readonly to: AlertPhase;
  readonly at: string;
  readonly value: number;
}
export interface SilenceOptions {
  until?: Date | null;
  startsAt?: Date;
}
export interface AlertSilence {
  readonly rule: string;
  readonly startsAt: string;
  readonly until?: string;
  readonly cancelledAt?: string;
}
export interface AlertManagerOptions {
  historyLimit?: number;
  transitionHistoryLimit?: number;
  silenceHistoryLimit?: number;
}
interface InternalState {
  readonly rule: string;
  readonly severity: AlertRule["severity"];
  readonly active: boolean;
  readonly since: string;
  readonly value: number;
}
interface InternalSilence {
  readonly rule: string;
  readonly startsAt: number;
  readonly until: number | null;
  readonly cancelledAt: number | null;
}

const DEFAULT_HISTORY_LIMIT = 1000;

export class AlertManager {
  private readonly rules: AlertRule[];
  private readonly states = new Map<string, InternalState>();
  private readonly pending = new Map<string, number>();
  private readonly activeSilences = new Map<string, InternalSilence>();
  private readonly transitionRecords: AlertTransition[] = [];
  private readonly silenceRecords: InternalSilence[] = [];
  private readonly transitionLimit: number;
  private readonly silenceLimit: number;
  private viewTime = 0;
  private lastEvaluation: number | undefined;

  constructor(rules: AlertRule[], options: AlertManagerOptions | number = {}) {
    if (!Array.isArray(rules)) throw new Error("Alert rules must be an array");
    const normalizedOptions = typeof options === "number" ? { historyLimit: options } : options;
    if (
      typeof normalizedOptions !== "object" ||
      normalizedOptions === null ||
      Array.isArray(normalizedOptions)
    )
      throw new Error("Invalid alert manager options");
    const names = new Set<string>();
    this.rules = rules.map((rule) => {
      validateRule(rule);
      if (names.has(rule.name)) throw new Error(`Duplicate alert rule: ${rule.name}`);
      names.add(rule.name);
      return Object.freeze({ ...rule });
    });
    const commonLimit = historyLimit(normalizedOptions.historyLimit, DEFAULT_HISTORY_LIMIT);
    this.transitionLimit = historyLimit(normalizedOptions.transitionHistoryLimit, commonLimit);
    this.silenceLimit = historyLimit(normalizedOptions.silenceHistoryLimit, commonLimit);
  }

  evaluate(values: Record<string, number>, now = new Date()): AlertState[] {
    const time = timestamp(now, "now");
    if (typeof values !== "object" || values === null || Array.isArray(values))
      throw new Error("Alert values must be an object");
    for (const rule of this.rules) {
      if (!Object.prototype.hasOwnProperty.call(values, rule.metric)) continue;
      const value: unknown = values[rule.metric];
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`Invalid metric value: ${rule.metric}`);
    }
    if (this.lastEvaluation !== undefined && time < this.lastEvaluation)
      throw new Error("Alert evaluation time must not move backwards");
    this.viewTime = time;
    this.lastEvaluation = time;
    for (const rule of this.rules) {
      if (!Object.prototype.hasOwnProperty.call(values, rule.metric)) {
        this.pending.delete(rule.name);
        continue;
      }
      const value = values[rule.metric];
      if (value !== undefined) this.evaluateRule(rule, value, time);
    }
    return this.historyAt(time);
  }

  silence(rule: string, untilOrOptions?: Date | SilenceOptions | null, startsAt?: Date): AlertSilence {
    this.assertRule(rule);
    let until: Date | null;
    let start: Date;
    if (untilOrOptions instanceof Date || untilOrOptions === undefined || untilOrOptions === null) {
      until = untilOrOptions ?? null;
      start = startsAt ?? new Date(0);
    } else if (typeof untilOrOptions === "object" && !Array.isArray(untilOrOptions)) {
      until = untilOrOptions.until ?? null;
      start = untilOrOptions.startsAt ?? new Date(0);
    } else {
      throw new Error("Invalid silence");
    }
    const startTime = timestamp(start, "startsAt");
    const untilTime = until === null ? null : timestamp(until, "until");
    if (untilTime !== null && untilTime < startTime)
      throw new Error("Silence until must not be before startsAt");
    const record: InternalSilence = Object.freeze({
      rule,
      startsAt: startTime,
      until: untilTime,
      cancelledAt: null,
    });
    this.activeSilences.set(rule, record);
    this.silenceRecords.push(record);
    if (this.silenceRecords.length > this.silenceLimit)
      this.silenceRecords.splice(0, this.silenceRecords.length - this.silenceLimit);
    return copySilence(record);
  }

  cancel(rule: string, now = new Date()): boolean {
    this.assertRule(rule);
    const time = timestamp(now, "now");
    const existing = this.activeSilences.get(rule);
    if (!existing || existing.cancelledAt !== null || (existing.until !== null && time >= existing.until))
      return false;
    const cancelled: InternalSilence = Object.freeze({ ...existing, cancelledAt: time });
    this.activeSilences.set(rule, cancelled);
    const index = this.silenceRecords.indexOf(existing);
    if (index >= 0) this.silenceRecords[index] = cancelled;
    return true;
  }

  cancelSilence(rule: string, now = new Date()): boolean {
    return this.cancel(rule, now);
  }

  transitions(): AlertTransition[] {
    return this.transitionRecords.map((transition) => ({ ...transition }));
  }

  transitionHistory(): AlertTransition[] {
    return this.transitions();
  }

  silenceHistory(): AlertSilence[] {
    return this.silenceRecords.map(copySilence);
  }

  silences(): AlertSilence[] {
    return this.silenceHistory();
  }

  history(now?: Date): AlertState[] {
    return this.historyAt(now === undefined ? this.viewTime : timestamp(now, "now"));
  }

  private evaluateRule(rule: AlertRule, value: number, time: number): void {
    const triggered = compare(value, rule.threshold, rule.comparison);
    const existing = this.states.get(rule.name);
    const pendingSince = this.pending.get(rule.name);
    if (triggered) {
      if (existing?.active) {
        this.states.set(rule.name, Object.freeze({ ...existing, value }));
        return;
      }
      const since = pendingSince ?? time;
      if (pendingSince === undefined) {
        this.pending.set(rule.name, since);
        this.recordTransition(rule.name, existing ? "resolved" : "none", "pending", time, value);
      }
      if (time - since >= (rule.forMs ?? 0)) {
        this.pending.delete(rule.name);
        this.states.set(
          rule.name,
          Object.freeze({
            rule: rule.name,
            severity: rule.severity,
            active: true,
            since: new Date(since).toISOString(),
            value,
          }),
        );
        this.recordTransition(rule.name, "pending", "firing", time, value);
      }
      return;
    }
    if (pendingSince !== undefined) {
      this.pending.delete(rule.name);
      this.recordTransition(rule.name, "pending", "resolved", time, value);
      if (existing) this.states.set(rule.name, Object.freeze({ ...existing, value }));
      return;
    }
    if (existing?.active) {
      this.states.set(rule.name, Object.freeze({ ...existing, active: false, value }));
      this.recordTransition(rule.name, "firing", "resolved", time, value);
    } else if (existing) {
      this.states.set(rule.name, Object.freeze({ ...existing, value }));
    }
  }

  private recordTransition(
    rule: string,
    from: AlertTransition["from"],
    to: AlertPhase,
    time: number,
    value: number,
  ): void {
    this.transitionRecords.push(Object.freeze({ rule, from, to, at: new Date(time).toISOString(), value }));
    if (this.transitionRecords.length > this.transitionLimit)
      this.transitionRecords.splice(0, this.transitionRecords.length - this.transitionLimit);
  }

  private historyAt(time: number): AlertState[] {
    return [...this.states.values()].map((state) => {
      const silence = this.activeSilence(state.rule, time);
      return {
        rule: state.rule,
        severity: state.severity,
        active: state.active,
        since: state.since,
        value: state.value,
        ...(silence !== undefined && silence.until !== null
          ? { silencedUntil: new Date(silence.until).toISOString() }
          : {}),
      };
    });
  }

  private activeSilence(rule: string, time: number): InternalSilence | undefined {
    const silence = this.activeSilences.get(rule);
    if (
      !silence ||
      silence.startsAt > time ||
      (silence.until !== null && time >= silence.until) ||
      (silence.cancelledAt !== null && time >= silence.cancelledAt)
    )
      return undefined;
    return silence;
  }

  private assertRule(rule: string): void {
    if (!this.rules.some((candidate) => candidate.name === rule))
      throw new Error(`Unknown alert rule: ${rule}`);
  }
}

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    name: "DiskUsageHigh",
    metric: "storage_usage_pct",
    threshold: 80,
    comparison: "gt",
    severity: "warning",
  },
  {
    name: "ScanQueueBacklog",
    metric: "scan_queue_depth",
    threshold: 100,
    comparison: "gt",
    severity: "warning",
  },
  {
    name: "ErrorRateHigh",
    metric: "error_rate",
    threshold: 5,
    comparison: "gt",
    severity: "critical",
    forMs: 60_000,
  },
  { name: "LatencyP99High", metric: "http_p99_seconds", threshold: 5, comparison: "gt", severity: "warning" },
  {
    name: "StorageBackendDown",
    metric: "storage_backend_healthy",
    threshold: 1,
    comparison: "lt",
    severity: "critical",
  },
];

function validateRule(rule: AlertRule): void {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) throw new Error("Invalid alert rule");
  if (
    typeof rule.name !== "string" ||
    !rule.name.trim() ||
    rule.name.length > 255 ||
    typeof rule.metric !== "string" ||
    !rule.metric.trim() ||
    rule.metric.length > 255
  )
    throw new Error("Invalid alert rule name or metric");
  if (typeof rule.threshold !== "number" || !Number.isFinite(rule.threshold))
    throw new Error("Invalid alert threshold");
  if (
    !["gt", "gte", "lt", "lte"].includes(rule.comparison) ||
    !["info", "warning", "critical"].includes(rule.severity)
  )
    throw new Error("Invalid alert rule definition");
  if (
    rule.forMs !== undefined &&
    (typeof rule.forMs !== "number" || !Number.isFinite(rule.forMs) || rule.forMs < 0)
  )
    throw new Error("Invalid alert duration");
}

function historyLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Invalid alert history limit");
  return result;
}

function timestamp(value: Date, name: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`Invalid ${name}`);
  return value.getTime();
}

function copySilence(silence: InternalSilence): AlertSilence {
  return {
    rule: silence.rule,
    startsAt: new Date(silence.startsAt).toISOString(),
    ...(silence.until === null ? {} : { until: new Date(silence.until).toISOString() }),
    ...(silence.cancelledAt === null ? {} : { cancelledAt: new Date(silence.cancelledAt).toISOString() }),
  };
}

function compare(value: number, threshold: number, comparison: AlertRule["comparison"]): boolean {
  return comparison === "gt"
    ? value > threshold
    : comparison === "gte"
      ? value >= threshold
      : comparison === "lt"
        ? value < threshold
        : value <= threshold;
}
