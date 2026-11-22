export interface TraceSpan { name: string; traceId: string; spanId: string; parentSpanId?: string; startedAt: number; endedAt?: number; attributes: Record<string, string | number | boolean>; status: "ok" | "error" }
export interface SpanExporter { export(span: TraceSpan): Promise<void> }

export class Tracer {
  constructor(private readonly exporter?: SpanExporter) {}
  async run<T>(name: string, operation: (span: TraceSpan) => Promise<T>, parent?: TraceSpan): Promise<T> {
    const span: TraceSpan = { name, traceId: parent?.traceId ?? randomId(16), spanId: randomId(8), ...(parent ? { parentSpanId: parent.spanId } : {}), startedAt: performance.now(), attributes: {}, status: "ok" };
    try { return await operation(span); }
    catch (error) { span.status = "error"; span.attributes["error.message"] = error instanceof Error ? error.message : "Unknown error"; throw error; }
    finally { span.endedAt = performance.now(); await this.exporter?.export(span).catch(() => undefined); }
  }
}
function randomId(bytes: number): string { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) => value.toString(16).padStart(2, "0")).join(""); }
