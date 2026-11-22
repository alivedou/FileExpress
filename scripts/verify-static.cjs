const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const toolRoot = process.env.TOOL_MODULE_ROOT;
const ts = toolRoot ? require(path.join(toolRoot, "typescript")) : require("typescript");
const YAML = toolRoot ? require(path.join(toolRoot, "yaml")) : require("yaml");
const typescriptFiles = [];
const yamlFiles = ["docs/api/openapi.yaml"];
const jsonFiles = ["package.json", "tsconfig.json", "renovate.json", "metadata.json"];

function walk(directory, extension, target) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, extension, target);
    else if (entry.isFile() && entry.name.endsWith(extension)) target.push(file);
  }
}

for (const directory of ["src", "scripts", "test", "lib"]) walk(directory, ".ts", typescriptFiles);
walk("src", ".tsx", typescriptFiles);
for (const file of fs.readdirSync(".")) if (/^[^.]+\.ts$/.test(file)) typescriptFiles.push(file);
for (const directory of ["helm/fileexpress-canary", "argo-apps", ".github/workflows", "observability"]) {
  walk(directory, ".yaml", yamlFiles);
  walk(directory, ".yml", yamlFiles);
}
for (const directory of ["docs", "i18n", "observability"]) walk(directory, ".json", jsonFiles);

let failures = 0;
for (const file of typescriptFiles) {
  const result = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  for (const diagnostic of result.diagnostics ?? []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    failures += 1;
    console.error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
}

for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures += 1;
    console.error(`${file}: ${error instanceof Error ? error.message : "Invalid JSON"}`);
  }
}

for (const file of yamlFiles) {
  try {
    YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures += 1;
    console.error(`${file}: ${error instanceof Error ? error.message : "Invalid YAML"}`);
  }
}

try {
  const openapiYaml = YAML.parse(fs.readFileSync("docs/api/openapi.yaml", "utf8"));
  const openapiJson = JSON.parse(fs.readFileSync("docs/api-docs/openapi.json", "utf8"));
  assert.deepStrictEqual(openapiYaml, openapiJson);
  assert.ok(Object.keys(openapiJson.paths).length >= 29);
  const operationCount = Object.values(openapiJson.paths).reduce(
    (total, pathItem) =>
      total +
      Object.keys(pathItem).filter((key) =>
        ["get", "post", "put", "patch", "delete", "head", "options"].includes(key),
      ).length,
    0,
  );
  assert.ok(operationCount >= 42);
} catch (error) {
  failures += 1;
  console.error(`OpenAPI mismatch: ${error instanceof Error ? error.message : "Unknown error"}`);
}

if (failures) {
  console.error(`Static verification failed with ${failures} error(s)`);
  process.exitCode = 1;
} else {
  console.log(
    `Static verification passed: ${typescriptFiles.length} TS/TSX, ${jsonFiles.length} JSON, ${yamlFiles.length} YAML files`,
  );
}
