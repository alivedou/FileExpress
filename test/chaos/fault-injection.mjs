import { randomInt } from "node:crypto";
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const iterations = Number(process.env.CHAOS_ITERATIONS ?? 20);
const results = [];
for (let index = 0; index < iterations; index += 1) {
  const action = ["backend.kill", "scanner.kill", "network.delay"][randomInt(3)];
  if (action === "network.delay") await new Promise((resolve) => setTimeout(resolve, randomInt(100, 1000)));
  const response = await fetch(`${baseUrl}/health/ready`);
  const body = await response.json();
  const valid = response.status === 200 || response.status === 503;
  results.push({ iteration: index, action, status: response.status, healthy: body.healthy, valid });
  if (!valid) throw new Error(`Unexpected readiness status ${response.status}`);
}
if (results.some((item) => item.healthy && item.status !== 200))
  throw new Error("Readiness status/body mismatch");
console.log(
  JSON.stringify({ iterations, passed: results.filter((item) => item.valid).length, results }, null, 2),
);
