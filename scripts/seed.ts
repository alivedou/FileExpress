import { faker } from "@faker-js/faker";
const baseUrl = process.env.SEED_BASE_URL ?? "http://localhost:3000";
const tenantId = process.env.SEED_TENANT ?? "default";
async function post(section: string, body: unknown): Promise<void> {
  const response = await fetch(`${baseUrl}/api/admin/${section}`, { method: "POST", headers: { "Content-Type": "application/json", ...(process.env.SEED_TOKEN ? { Authorization: `Bearer ${process.env.SEED_TOKEN}` } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${section}: HTTP ${response.status} ${await response.text()}`);
}
const team = { id: `team-${faker.string.alphanumeric(8)}`, name: faker.company.name(), quotaBytes: 1073741824, branding: { name: faker.company.name(), color: faker.color.rgb() } };
await post("teams", team);
await post("webhooks", { tenantId, url: "https://localhost:9443/webhook", secret: faker.string.alphanumeric(32), events: ["file.uploaded", "scan.completed"], enabled: true });
for (let index = 0; index < 10; index += 1) await post("audit", { tenantId, actorId: faker.string.uuid(), action: "file.uploaded", resourceType: "file", resourceId: faker.string.uuid(), ip: faker.internet.ipv4(), userAgent: faker.internet.userAgent(), outcome: index % 5 ? "success" : "failure", details: { size: faker.number.int({ min: 1, max: 1000000 }), name: faker.system.fileName() } });
console.log(`Seeded ${team.id} with webhook and audit records`);
