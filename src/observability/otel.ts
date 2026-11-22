import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type Span,
  type Tracer as OtelTracer,
} from "@opentelemetry/api";
import { currentTraceContext as currentManualTraceContext, currentTraceSpan } from "./tracing";

const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

export class OpenTelemetryTracer {
  private readonly tracer: OtelTracer;

  constructor(serviceName = process.env.OTEL_SERVICE_NAME ?? "fileexpress") {
    this.tracer = trace.getTracer(serviceName, "2.0.0");
  }

  async run<T>(name: string, operation: (span: Span) => Promise<T>, parent?: Context): Promise<T> {
    return this.tracer.startActiveSpan(name, {}, parent ?? this.defaultContext(), async (span) => {
      try {
        const result = await operation(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error("Unknown error"));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  inject(headers: Record<string, string>, parent?: Context): void {
    propagation.inject(parent ?? this.defaultContext(), headers, {
      set: (carrier, key, value) => {
        carrier[key] = value;
      },
    });
  }

  extract(headers: Record<string, string>): Context {
    return propagation.extract(context.active(), headers);
  }

  private defaultContext(): Context {
    const active = trace.getActiveSpan()?.spanContext();
    if (active && active.traceId !== ZERO_TRACE_ID && active.spanId !== ZERO_SPAN_ID) return context.active();
    const manual = currentTraceSpan();
    if (!manual) return context.active();
    return trace.setSpan(
      context.active(),
      trace.wrapSpanContext({
        traceId: manual.traceId,
        spanId: manual.spanId,
        traceFlags: TraceFlags.SAMPLED,
      }),
    );
  }
}

export function currentTraceContext(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext && spanContext.traceId !== ZERO_TRACE_ID && spanContext.spanId !== ZERO_SPAN_ID)
    return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
  return currentManualTraceContext();
}
