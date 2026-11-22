import { AsyncLocalStorage } from "node:async_hooks";
import { trace } from "@opentelemetry/api";

export interface TraceSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAt: number;
  endedAt?: number;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error";
}
export interface SpanExporter {
  export(span: TraceSpan): Promise<void>;
}

const traceStorage = new AsyncLocalStorage<TraceSpan>();
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

export class Tracer {
  constructor(private readonly exporter?: SpanExporter) {}

  async run<T>(name: string, operation: (span: TraceSpan) => Promise<T>, parent?: TraceSpan): Promise<T> {
    const implicitParent = parent ?? traceStorage.getStore();
    const otelParent = implicitParent ? undefined : activeOtelParent();
    const traceId = implicitParent?.traceId ?? otelParent?.traceId ?? randomId(16);
    const parentSpanId = implicitParent?.spanId ?? otelParent?.spanId;
    const span: TraceSpan = {
      name,
      traceId,
      spanId: randomId(8),
      ...(parentSpanId ? { parentSpanId } : {}),
      startedAt: performance.now(),
      attributes: {},
      status: "ok",
    };
    try {
      return await traceStorage.run(span, () => operation(span));
    } catch (error) {
      span.status = "error";
      span.attributes["error.message"] = error instanceof Error ? error.message : "Unknown error";
      throw error;
    } finally {
      span.endedAt = performance.now();
      if (this.exporter) await exportSpan(this.exporter, span);
    }
  }
}

export function currentTraceSpan(): TraceSpan | undefined {
  return traceStorage.getStore();
}

export function currentTraceContext(): { trace_id?: string; span_id?: string } {
  const span = traceStorage.getStore();
  return span ? { trace_id: span.traceId, span_id: span.spanId } : {};
}

function activeOtelParent(): { traceId: string; spanId: string } | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || spanContext.traceId === ZERO_TRACE_ID || spanContext.spanId === ZERO_SPAN_ID)
    return undefined;
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

async function exportSpan(exporter: SpanExporter, span: TraceSpan): Promise<void> {
  try {
    await exporter.export(span);
  } catch {
    return;
  }
}

function randomId(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
