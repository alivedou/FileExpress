import { readFile, writeFile } from "node:fs/promises";
const source = await readFile("test/performance/upload-download.k6.js", "utf8");
const target = process.argv[2] ?? "test/performance/generated.k6.js";
await writeFile(target, source.replaceAll("__BASE_URL__", process.env.BASE_URL ?? "http://localhost:3000"));
if (process.argv.includes("--compare")) {
  const [currentPath, baselinePath] = process.argv.slice(process.argv.indexOf("--compare") + 1);
  if (!currentPath || !baselinePath) throw new Error("--compare requires current and baseline JSON files");
  const current = JSON.parse(await readFile(currentPath, "utf8")) as {
    metrics: Record<string, { values: Record<string, number> }>;
  };
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as typeof current;
  const metric = "http_req_duration";
  const percentile = "p(99)";
  const now = current.metrics[metric]?.values[percentile] ?? 0;
  const before = baseline.metrics[metric]?.values[percentile] ?? 0;
  console.log(
    JSON.stringify(
      {
        metric,
        percentile,
        current: now,
        baseline: before,
        regressionPct: before ? ((now - before) / before) * 100 : 0,
      },
      null,
      2,
    ),
  );
  if (before && now > before * 1.2) process.exitCode = 1;
} else console.log(`Generated ${target}`);
