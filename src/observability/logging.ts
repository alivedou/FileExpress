import { currentTraceContext } from "./otel";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogSink {
  write(line: string): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SENSITIVE_KEY =
  /password|passwd|pwd|secret|token|authorization|cookie|credential|private[-_]?key|api[-_]?key|access[-_]?key|connection[-_]?string|(?:^|[_-])auth(?:$|[_-])/i;
const SENSITIVE_TEXT =
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|((?:token|secret|password|signature|api[-_]?key)=)[^\s&]+/gi;
const MAX_DEPTH = 20;

export class StructuredLogger {
  private readonly sink: LogSink;
  private readonly level: LogLevel;

  constructor(sink: LogSink = process.stdout, level: LogLevel = "info") {
    if (!Object.prototype.hasOwnProperty.call(LEVELS, level)) throw new Error("Invalid log level");
    this.sink = sink;
    this.level = level;
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.log("debug", message, fields);
  }
  info(message: string, fields: Record<string, unknown> = {}): void {
    this.log("info", message, fields);
  }
  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.log("warn", message, fields);
  }
  error(message: string, fields: Record<string, unknown> = {}): void {
    this.log("error", message, fields);
  }

  private log(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const trace = currentTraceContext();
    const safeFields = redact(fields);
    this.sink.write(
      `${JSON.stringify({ ...safeFields, ...trace, level, time: new Date().toISOString(), msg: message })}\n`,
    );
  }
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const sanitized: unknown = sanitize(fields, new WeakSet<object>(), 0);
  if (isRecord(sanitized)) return sanitized;
  return { value: sanitized };
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.replace(SENSITIVE_TEXT, (match, prefix: unknown) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[Undefined]";
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "[Invalid Date]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, seen, depth + 1));
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value))
      entries.push([key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, seen, depth + 1)]);
    return Object.fromEntries(entries);
  } catch {
    return "[Unserializable]";
  } finally {
    seen.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
