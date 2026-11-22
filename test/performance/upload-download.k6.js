import http from "k6/http";
import { check } from "k6";
export const options = { scenarios: { mixed: { executor: "constant-vus", vus: Number(__ENV.VUS || 1000), duration: __ENV.DURATION || "10m" } }, thresholds: { http_req_duration: ["p(99)<2000"], http_req_failed: ["rate<0.001"], checks: ["rate>0.999"] } };
const baseUrl = "__BASE_URL__";
export default function () {
  const size = Math.random() < 0.8 ? 1024 : 1048576;
  const response = http.post(`${baseUrl}/api/upload/chunks`, JSON.stringify({ fileName: `bench-${__VU}-${__ITER}.bin`, totalSize: size, chunkSize: size }), { headers: { "Content-Type": "application/json", "X-Tenant-Id": `tenant-${__VU % 20}` }, timeout: "30s" });
  const created = response.json();
  check(response, { "session created": (r) => r.status === 201 });
  if (response.status !== 201) return;
  const data = new Uint8Array(size);
  const upload = http.put(`${baseUrl}/api/upload/chunks/${created.uploadId}/0`, data, { headers: { "Content-Type": "application/octet-stream" }, timeout: "30s" });
  check(upload, { "chunk accepted": (r) => r.status === 200 });
  const completed = http.post(`${baseUrl}/api/upload/chunks/${created.uploadId}/complete`);
  check(completed, { "upload completed": (r) => r.status === 200 });
}
