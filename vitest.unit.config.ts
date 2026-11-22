import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      include: ["src/**/*.ts", "lib/**/*.ts"],
      exclude: [
        "src/**/*.tsx",
        "src/main.tsx",
        "src/App.tsx",
        "src/upload/client.ts",
        "src/**/routes.ts",
        "src/api/**",
        "src/storage/aws-sdk.ts",
        "src/storage/azure-sdk.ts",
        "src/storage/pg-adapter.ts",
        "src/storage/ipfs-http.ts",
        "src/security/clamav-daemon.ts",
        "src/security/yara-cli.ts",
        "src/drm/renderers.ts",
        "src/webhooks/redis-bus.ts",
        "src/webhooks/kafka-bus.ts",
        "src/observability/otel.ts",
        "src/observability/bootstrap.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
