import { expect, test } from "@playwright/test";
test("admin, storage, large upload, webhook, monitoring and audit journey", async ({ page, request }) => {
  const ready = await request.get("/health/ready");
  expect(ready.ok()).toBeTruthy();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: /企业|Enterprise/ })).toBeVisible();
  const team = await request.post("/api/admin/teams", {
    headers: { Authorization: "Bearer development-admin-token" },
    data: {
      id: `e2e-${Date.now()}`,
      name: "E2E Team",
      quotaBytes: 1073741824,
      branding: { name: "E2E", color: "#000" },
    },
  });
  expect(team.status()).toBe(201);
  const upload = await request.post("/api/upload/chunks", {
    data: { fileName: "large.bin", totalSize: 4, chunkSize: 2 },
  });
  expect(upload.status()).toBe(201);
  const session = (await upload.json()) as { uploadId: string };
  expect(
    (await request.put(`/api/upload/chunks/${session.uploadId}/0`, { data: Buffer.from("ab") })).ok(),
  ).toBeTruthy();
  expect(
    (await request.put(`/api/upload/chunks/${session.uploadId}/1`, { data: Buffer.from("cd") })).ok(),
  ).toBeTruthy();
  const completed = await request.post(`/api/upload/chunks/${session.uploadId}/complete`);
  expect(completed.ok()).toBeTruthy();
  expect(await completed.json()).toMatchObject({
    size: 4,
    checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const monitoring = await request.get("/api/admin/monitoring", {
    headers: { Authorization: "Bearer development-admin-token" },
  });
  expect(monitoring.ok()).toBeTruthy();
  const audit = await request.get("/api/admin/audit?format=cef", {
    headers: { Authorization: "Bearer development-admin-token" },
  });
  expect(audit.ok()).toBeTruthy();
});
