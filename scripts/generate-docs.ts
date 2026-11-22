import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { API_OPERATIONS, OPENAPI_DOCUMENT } from "../src/docs/openapi";

const source = await readFile("docs/api/openapi.yaml", "utf8");
for (const operation of API_OPERATIONS) {
  if (!source.includes(operation.path)) throw new Error(`OpenAPI route is missing: ${operation.path}`);
}
await mkdir("docs/api-docs", { recursive: true });
await Promise.all([
  writeFile("docs/api-docs/openapi.yaml", source),
  writeFile("docs/api-docs/openapi.json", `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`),
  writeFile("docs/api-docs/index.html", `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FileExpress API</title></head><body><nav><a href="../guides/quick-start.mdx">指南 / Guides</a></nav><redoc spec-url="./openapi.yaml"></redoc><script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script></body></html>`),
]);
console.log(`Validated ${API_OPERATIONS.length} documented operations in ${path.resolve("docs/api-docs")}`);
