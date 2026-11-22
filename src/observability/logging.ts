export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogSink { write(line: string): void }
export class StructuredLogger {
  constructor(private readonly sink: LogSink = process.stdout, private readonly level: LogLevel = "info") {}
  debug(message: string, fields: Record<string, unknown> = {}): void { this.log("debug", message, fields); }
  info(message: string, fields: Record<string, unknown> = {}): void { this.log("info", message, fields); }
  warn(message: string, fields: Record<string, unknown> = {}): void { this.log("warn", message, fields); }
  error(message: string, fields: Record<string, unknown> = {}): void { this.log("error", message, fields); }
  private log(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (["debug", "info", "warn", "error"].indexOf(level) < ["debug", "info", "warn", "error"].indexOf(this.level)) return;
    this.sink.write(JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...redact(fields) }));
  }
}
function redact(fields: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, /password|secret|token|authorization|cookie/i.test(key) ? "[REDACTED]" : value])); }
