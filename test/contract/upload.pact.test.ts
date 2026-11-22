import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import path from "node:path";
import { describe, it } from "vitest";
const { like, string } = MatchersV3;
describe("upload API consumer contract", () => {
  it("creates a chunk upload session", async () => {
    const provider = new PactV3({ consumer: "FileExpressWeb", provider: "FileExpressAPI", dir: path.resolve("pact/contracts"), logLevel: "silent" });
    provider.given("chunk uploads are enabled").uponReceiving("a create upload request").withRequest({ method: "POST", path: "/api/upload/chunks", headers: { "Content-Type": "application/json" }, body: { fileName: "large.bin", totalSize: like(1024), chunkSize: like(512) } }).willRespondWith({ status: 201, headers: { "Content-Type": "application/json" }, body: { uploadId: string("7d5f"), chunkSize: like(512), totalChunks: like(2), expiresAt: string("2027-01-01T00:00:00.000Z") } });
    await provider.executeTest(async (mockServer) => {
      const response = await fetch(`${mockServer.url}/api/upload/chunks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: "large.bin", totalSize: 1024, chunkSize: 512 }) });
      if (response.status !== 201) throw new Error(`Unexpected status ${response.status}`);
      const body = await response.json() as { uploadId: string; totalChunks: number };
      if (!body.uploadId || body.totalChunks !== 2) throw new Error("Contract response mismatch");
    });
  });
});
