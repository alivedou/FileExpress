import express from "express";
import request from "supertest";
import { createEnterpriseRouter } from "../../src/api/enterprise";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../helpers";

describe("enterprise HTTP integration", () => {
  it("serves readiness, Prometheus and a complete chunk upload", async () => {
    const app = express();
    app.use(express.json());
    app.use(createEnterpriseRouter(await temporaryDirectory("http")));
    const ready = await request(app).get("/health/ready").expect(200);
    expect(ready.body).toMatchObject({
      healthy: true,
      backends: [expect.objectContaining({ healthy: true })],
    });
    await request(app)
      .get("/metrics")
      .expect(200)
      .expect(/http_req_duration_seconds/);
    const created = await request(app)
      .post("/api/upload/chunks")
      .send({ fileName: "a.txt", totalSize: 4, chunkSize: 2 })
      .expect(201);
    await request(app)
      .put(`/api/upload/chunks/${created.body.uploadId}/0`)
      .set("Content-Type", "application/octet-stream")
      .send("ab")
      .expect(200);
    await request(app)
      .put(`/api/upload/chunks/${created.body.uploadId}/1`)
      .set("Content-Type", "application/octet-stream")
      .send("cd")
      .expect(200);
    const completed = await request(app)
      .post(`/api/upload/chunks/${created.body.uploadId}/complete`)
      .expect(200);
    expect(completed.body).toMatchObject({ size: 4, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const tus = await request(app).options("/api/upload/tus").expect(204);
    expect(tus.headers["tus-version"]).toBe("1.0.0");
  });
});
