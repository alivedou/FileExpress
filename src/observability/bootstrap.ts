import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | undefined;
export function startObservability(): void {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`,
    }),
    serviceName: process.env.OTEL_SERVICE_NAME ?? "fileexpress",
  });
  sdk.start();
  const shutdown = (): void => {
    void sdk?.shutdown().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
