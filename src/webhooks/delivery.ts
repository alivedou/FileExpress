import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FetchLike } from "../security/clamav";
import type { WebhookEnvelope, WebhookEventType } from "./events";

export interface WebhookEndpoint { id: string; tenantId: string; url: string; secret: string; events: WebhookEventType[]; enabled: boolean; headers?: Record<string, string> }
export interface DeliveryAttempt { id: string; endpointId: string; eventId: string; idempotencyKey: string; attempt: number; status: "pending" | "delivered" | "retrying" | "dead"; responseStatus?: number; error?: string; createdAt: string }
export interface WebhookDeliveryOptions { fetchImpl?: FetchLike; retries?: number; baseDelayMs?: number; sleep?: (milliseconds: number) => Promise<void>; now?: () => number }

export class WebhookDeliveryService {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly attempts: DeliveryAttempt[] = [];
  private readonly completed = new Set<string>();
  private readonly fetcher: FetchLike;
  constructor(private readonly options: WebhookDeliveryOptions = {}) { this.fetcher = options.fetchImpl ?? fetch; }

  addEndpoint(input: Omit<WebhookEndpoint, "id"> & { id?: string }): WebhookEndpoint {
    const url = new URL(input.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Webhook endpoints must use HTTPS");
    if (!input.events.length || input.secret.length < 16) throw new Error("Webhook events and a secret of at least 16 characters are required");
    const endpoint = { ...input, id: input.id ?? randomUUID() };
    this.endpoints.set(endpoint.id, endpoint);
    return { ...endpoint, events: [...endpoint.events] };
  }
  removeEndpoint(id: string): boolean { return this.endpoints.delete(id); }
  listEndpoints(tenantId: string): WebhookEndpoint[] { return [...this.endpoints.values()].filter((item) => item.tenantId === tenantId).map((item) => ({ ...item, secret: "[REDACTED]", events: [...item.events] })); }
  history(endpointId?: string): DeliveryAttempt[] { return this.attempts.filter((item) => !endpointId || item.endpointId === endpointId).map((item) => ({ ...item })); }

  async publish(event: WebhookEnvelope): Promise<DeliveryAttempt[]> {
    const targets = [...this.endpoints.values()].filter((endpoint) => endpoint.enabled && endpoint.tenantId === event.tenantId && endpoint.events.includes(event.type));
    const results = await Promise.all(targets.map((endpoint) => this.deliverWithRetry(endpoint, event)));
    return results.flat();
  }

  async redeliver(attemptId: string): Promise<DeliveryAttempt[]> {
    const previous = this.attempts.find((item) => item.id === attemptId && item.status === "dead");
    if (!previous) throw new Error("Dead delivery attempt not found");
    const endpoint = this.endpoints.get(previous.endpointId);
    if (!endpoint) throw new Error("Webhook endpoint no longer exists");
    const event = this.pendingEvents.get(previous.eventId);
    if (!event) throw new Error("Original event payload is unavailable");
    return this.deliverWithRetry(endpoint, event);
  }
  private readonly pendingEvents = new Map<string, WebhookEnvelope>();

  private async deliverWithRetry(endpoint: WebhookEndpoint, event: WebhookEnvelope): Promise<DeliveryAttempt[]> {
    const key = `${endpoint.id}:${event.idempotencyKey}`;
    if (this.completed.has(key)) return [];
    this.pendingEvents.set(event.id, event);
    const records: DeliveryAttempt[] = [];
    const retries = this.options.retries ?? 3;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const record = await this.deliver(endpoint, event, attempt);
      records.push(record);
      this.attempts.push(record);
      if (record.status === "delivered") { this.completed.add(key); this.pendingEvents.delete(event.id); return records; }
      if (attempt <= retries) await (this.options.sleep ?? delay)((this.options.baseDelayMs ?? 250) * 2 ** (attempt - 1));
    }
    return records;
  }

  private async deliver(endpoint: WebhookEndpoint, event: WebhookEnvelope, attempt: number): Promise<DeliveryAttempt> {
    const timestamp = Math.floor((this.options.now?.() ?? Date.now()) / 1000).toString();
    const payload = JSON.stringify(event);
    const signature = signPayload(endpoint.secret, timestamp, payload);
    const base: DeliveryAttempt = { id: randomUUID(), endpointId: endpoint.id, eventId: event.id, idempotencyKey: event.idempotencyKey, attempt, status: "pending", createdAt: new Date().toISOString() };
    try {
      const response = await this.fetcher(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", "X-FileExpress-Event": event.type, "X-FileExpress-Delivery": event.id, "X-FileExpress-Timestamp": timestamp, "X-FileExpress-Signature": `sha256=${signature}`, "Idempotency-Key": event.idempotencyKey, ...endpoint.headers }, body: payload });
      if (!response.ok) return { ...base, status: attempt <= (this.options.retries ?? 3) ? "retrying" : "dead", responseStatus: response.status, error: `HTTP ${response.status}` };
      return { ...base, status: "delivered", responseStatus: response.status };
    } catch (error) {
      return { ...base, status: attempt <= (this.options.retries ?? 3) ? "retrying" : "dead", error: error instanceof Error ? error.message : "Delivery failed" };
    }
  }
}

export function signPayload(secret: string, timestamp: string, payload: string): string { return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex"); }
export function verifyPayload(secret: string, timestamp: string, payload: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  const time = Number(timestamp);
  if (!Number.isSafeInteger(time) || Math.abs(nowSeconds - time) > toleranceSeconds) return false;
  const expected = Buffer.from(`sha256=${signPayload(secret, timestamp, payload)}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
