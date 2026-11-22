import { context, propagation, SpanStatusCode, trace, type Span, type Tracer as OtelTracer } from "@opentelemetry/api";

export class OpenTelemetryTracer {
  private readonly tracer: OtelTracer;
  constructor(serviceName = process.env.OTEL_SERVICE_NAME ?? "fileexpress") { this.tracer = trace.getTracer(serviceName, "2.0.0"); }
  async run<T>(name: string, operation: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try { const result = await operation(span); span.setStatus({ code: SpanStatusCode.OK }); return result; }
      catch (error) { span.recordException(error instanceof Error ? error : new Error("Unknown error")); span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : "Unknown error" }); throw error; }
      finally { span.end(); }
    });
  }
  inject(headers: Record<string, string>): void { propagation.inject(context.active(), headers, { set: (carrier, key, value) => { carrier[key] = value; } }); }
  extract(headers: Record<string, string>) { return propagation.extract(context.active(), headers); }
}
export function currentTraceContext(): { trace_id?: string; span_id?: string } { const span = trace.getActiveSpan(); const context = span?.spanContext(); return context ? { trace_id: context.traceId, span_id: context.spanId } : {}; }
