import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { API_OPERATIONS, OPENAPI_DOCUMENT } from "../src/docs/openapi";

const yaml = toYaml(OPENAPI_DOCUMENT);
await mkdir("docs/api", { recursive: true });
await mkdir("docs/api-docs", { recursive: true });
await writeFile("docs/api/openapi.yaml", yaml, "utf8");
await writeFile("docs/api-docs/openapi.yaml", yaml, "utf8");
await writeFile("docs/api-docs/openapi.json", `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`, "utf8");
await writeFile("docs/api-docs/index.html", documentationIndex("zh"), "utf8");
await writeFile("docs/api-docs/index.en.html", documentationIndex("en"), "utf8");

const [enterpriseSource, uploadSource, serverSource] = await Promise.all([
  readFile("src/api/enterprise.ts", "utf8"),
  readFile("src/upload/routes.ts", "utf8"),
  readFile("server.ts", "utf8"),
]);
const source = `${enterpriseSource}\n${uploadSource}\n${serverSource}`;
const missing = API_OPERATIONS.filter(
  (operation) => !source.includes(routePrefix(operation.path)) && !isLegacyOperation(operation.path),
);
if (missing.length)
  throw new Error(
    `Routes missing from enterprise source: ${missing.map((item) => `${item.method} ${item.path}`).join(", ")}`,
  );
console.log(`Generated ${API_OPERATIONS.length} documented operations in ${path.resolve("docs/api-docs")}`);

function routePrefix(operationPath: string): string {
  return operationPath.split("{")[0] ?? operationPath;
}

function isLegacyOperation(operationPath: string): boolean {
  return (
    operationPath.startsWith("/api/upload/") ||
    operationPath === "/api/batch-upload" ||
    operationPath === "/api/config" ||
    operationPath === "/api/health" ||
    operationPath === "/api/view/{id}" ||
    operationPath === "/api/files/public"
  );
}

function documentationIndex(locale: "zh" | "en"): string {
  const chinese = locale === "zh";
  const copy = chinese
    ? {
        title: "企业接口文档",
        description: "对象存储、断点续传、扫描、DRM、Webhook、RBAC 与审计接口。",
        switch: "English",
        href: "./index.en.html",
      }
    : {
        title: "Enterprise API reference",
        description: "Storage, resumable upload, scanning, DRM, webhook, RBAC and audit APIs.",
        switch: "简体中文",
        href: "./index.html",
      };
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FileExpress API</title><style>body{margin:0;font-family:system-ui}header{display:flex;align-items:center;gap:1rem;padding:1rem 2rem;border-bottom:1px solid #ddd}header p{flex:1}a{color:#0891b2}main{height:calc(100vh - 86px)}redoc{display:block;height:100%}</style></head><body><header><strong>FileExpress · ${copy.title}</strong><p>${copy.description}</p><a href="${copy.href}">${copy.switch}</a><a href="./openapi.yaml">OpenAPI YAML</a></header><main><redoc spec-url="./openapi.yaml"></redoc></main><script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script></body></html>`;
}

function toYaml(value: unknown, indentation = 0): string {
  const lines = yamlLines(value, indentation);
  return `${lines.join("\n")}\n`;
}

function yamlLines(value: unknown, indentation: number): string[] {
  const prefix = " ".repeat(indentation);
  if (Array.isArray(value)) {
    if (!value.length) return [`${prefix}[]`];
    return value.flatMap((item) => {
      if (isScalar(item)) return [`${prefix}- ${scalar(item)}`];
      const nested = yamlLines(item, indentation + 2);
      const [first, ...rest] = nested;
      return first === undefined ? [`${prefix}-`] : [`${prefix}- ${first.trimStart()}`, ...rest];
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return [`${prefix}{}`];
    return entries.flatMap(([key, item]) => {
      const renderedKey = JSON.stringify(key);
      if (isScalar(item)) return [`${prefix}${renderedKey}: ${scalar(item)}`];
      if (Array.isArray(item) && !item.length) return [`${prefix}${renderedKey}: []`];
      if (!Array.isArray(item) && item && typeof item === "object" && !Object.keys(item).length)
        return [`${prefix}${renderedKey}: {}`];
      return [`${prefix}${renderedKey}:`, ...yamlLines(item, indentation + 2)];
    });
  }
  return [`${prefix}${scalar(value)}`];
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value);
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "null";
}
