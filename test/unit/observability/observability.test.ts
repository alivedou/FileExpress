import { describe, expect, it, vi } from "vitest";
import { AlertManager } from "../../../src/observability/alerts";
import { StructuredLogger } from "../../../src/observability/logging";
import { MetricsRegistry } from "../../../src/observability/metrics";
import { Tracer } from "../../../src/observability/tracing";

describe("metrics", () => {
  it("renders counters, gauges and cumulative histograms with escaped labels", async () => {
    const registry = new MetricsRegistry(); const counter = registry.counter("requests_total", "Requests"); const gauge = registry.gauge("storage_usage_pct", "Usage"); const histogram = registry.histogram("request_seconds", "Duration", [0.1, 1]);
    counter.inc({ route: "/upload", label: 'a"b' }); counter.inc({ route: "/upload", label: 'a"b' }, 2);
    expect(() => counter.inc({}, -1)).toThrow("cannot decrease");
    gauge.set(81, { backend: "s3" }); gauge.inc({ backend: "s3" }, -1);
    histogram.observe(0.05, { method: "GET" }); histogram.observe(0.5, { method: "GET" }); histogram.observe(2, { method: "GET" });
    const output = await registry.render();
    expect(output).toContain('requests_total{route="/upload",label="a\\"b"} 3');
    expect(output).toContain('storage_usage_pct{backend="s3"} 80');
    expect(output).toContain('request_seconds_bucket{method="GET",le="0.1"} 1');
    expect(output).toContain('request_seconds_bucket{method="GET",le="+Inf"} 3');
    expect(output).toContain('request_seconds_sum{method="GET"} 2.55');
    expect(registry.value("storage_usage_pct", { backend: "s3" })).toBe(80);
    expect(() => registry.counter("requests_total", "wrong")).toThrow("another type");
    expect(() => registry.counter("invalid-name", "bad")).toThrow("Invalid metric");
  });
});

describe("alerts, logs and traces", () => {
  it("supports alert durations, recovery and silences", () => {
    const alerts = new AlertManager([{ name: "Queue", metric: "depth", threshold: 10, comparison: "gt", severity: "warning", forMs: 1000 }]);
    expect(alerts.evaluate({ depth: 20 }, new Date(0))).toEqual([]);
    expect(alerts.evaluate({ depth: 20 }, new Date(500))).toEqual([]);
    expect(alerts.evaluate({ depth: 20 }, new Date(1500))[0]).toMatchObject({ active: true, value: 20 });
    alerts.silence("Queue", new Date(5000)); expect(alerts.history()[0]?.silencedUntil).toBe(new Date(5000).toISOString());
    expect(alerts.evaluate({ depth: 1 }, new Date(2000))[0]?.active).toBe(false);
  });
  it("redacts structured logs and propagates trace context", async () => {
    const write = vi.fn(); const logger = new StructuredLogger({ write }, "info");
    logger.debug("hidden"); logger.info("upload", { token: "secret", size: 4, trace_id: "trace" }); logger.warn("warning"); logger.error("failure");
    expect(write).toHaveBeenCalledTimes(3); expect(write.mock.calls[0]?.[0]).toContain("[REDACTED]"); expect(write.mock.calls[0]?.[0]).toContain("trace");
    const exporter = { export: vi.fn(async () => undefined) }; const tracer = new Tracer(exporter);
    const value = await tracer.run("parent", async (parent) => { parent.attributes.tenant = "t"; return tracer.run("child", async () => "done", parent); });
    expect(value).toBe("done"); expect(exporter.export).toHaveBeenCalledTimes(2);
    const child = exporter.export.mock.calls[0]?.[0]; const parent = exporter.export.mock.calls[1]?.[0];
    expect(child?.traceId).toBe(parent?.traceId); expect(child?.parentSpanId).toBe(parent?.spanId);
    await expect(tracer.run("failure", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(exporter.export.mock.calls.at(-1)?.[0]).toMatchObject({ status: "error", attributes: { "error.message": "boom" } });
  });
});
