import { describe, expect, it, vi } from "vitest";
import { createEnvelope, MemoryEventBus, QueueEventBus, type QueueAdapter } from "../../../src/webhooks/bus";
import { formatForwardPayload, WebhookForwarder, type ForwarderKind } from "../../../src/webhooks/forwarders";
import { signPayload, verifyPayload, WebhookDeliveryService } from "../../../src/webhooks/delivery";

describe("event buses", () => {
  it("deduplicates events, unsubscribes and records handler failures", async () => {
    const bus = new MemoryEventBus(2); const event = createEnvelope("file.uploaded", "t", { id: "f" }, "same");
    const handler = vi.fn(async () => undefined); const unsubscribe = bus.subscribe("file.uploaded", handler);
    expect(await bus.publish(event)).toBe(true); expect(await bus.publish(event)).toBe(false);
    expect(handler).toHaveBeenCalledWith(event);
    unsubscribe(); expect(await bus.publish({ ...event, idempotencyKey: "second" })).toBe(true);
    bus.subscribe("*", async () => { throw new Error("handler failed"); });
    await expect(bus.publish({ ...event, idempotencyKey: "third" })).rejects.toThrow("handlers failed");
    expect(bus.deadLetters()).toHaveLength(1); await bus.close();
  });
  it("serialises queue envelopes and supports consumer mode", async () => {
    let receiver: ((record: { key: string; value: string; headers: Record<string, string> }) => Promise<void>) | undefined;
    const adapter: QueueAdapter = { send: vi.fn(async () => undefined), subscribe: vi.fn(async (_topic, handler) => { receiver = handler; return () => undefined; }), close: vi.fn(async () => undefined) };
    const producer = new QueueEventBus(adapter); const handler = vi.fn(async () => undefined); producer.subscribe("*", handler);
    const event = createEnvelope("file.scanned", "t", {}); await producer.publish(event);
    expect(adapter.send).toHaveBeenCalledWith("fileexpress.events", expect.objectContaining({ key: event.idempotencyKey }));
    const consumer = await QueueEventBus.consume(adapter); consumer.subscribe("*", handler);
    await receiver?.({ key: "key", value: JSON.stringify(event), headers: {} });
    expect(handler).toHaveBeenCalledTimes(2); await producer.close(); await consumer.close();
  });
});

describe("webhook delivery", () => {
  const input = { tenantId: "t", url: "https://hooks.test/events", secret: "a-secure-secret-value", events: ["file.uploaded" as const], enabled: true, headers: { "X-Custom": "yes" } };
  it("signs, retries with exponential backoff and preserves dead letters", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("retry", { status: 500 })).mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleep = vi.fn(async () => undefined); const service = new WebhookDeliveryService({ fetchImpl: fetcher, retries: 2, sleep, baseDelayMs: 100, now: () => 1_000_000 });
    const endpoint = service.addEndpoint(input); const event = createEnvelope("file.uploaded", "t", { id: "f" }, "idem");
    const attempts = await service.publish(event);
    expect(attempts.map((item) => item.status)).toEqual(["retrying", "delivered"]);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(fetcher).toHaveBeenCalledWith(input.url, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": "idem", "X-Custom": "yes" }) }));
    expect(await service.publish(event)).toEqual([]);
    expect(service.listEndpoints("t")[0]?.id).toBe(endpoint.id);
    const deadFetcher = vi.fn().mockResolvedValue(new Response("bad", { status: 503 }));
    const dead = new WebhookDeliveryService({ fetchImpl: deadFetcher, retries: 0 }); const deadEndpoint = dead.addEndpoint(input);
    const failed = await dead.publish({ ...event, idempotencyKey: "dead" });
    expect(failed[0]?.status).toBe("dead");
    await expect(dead.redeliver(failed[0]?.id ?? "")).resolves.toEqual([expect.objectContaining({ status: "dead" })]);
    expect(dead.history(deadEndpoint.id)).toHaveLength(2); expect(dead.removeEndpoint(deadEndpoint.id)).toBe(true);
  });
  it("rejects replayed, malformed and insecure signatures and endpoints", () => {
    const signature = `sha256=${signPayload("secret", "100", "{}")}`;
    expect(verifyPayload("secret", "100", "{}", signature, 110)).toBe(true);
    expect(verifyPayload("secret", "100", "{}", signature, 1000)).toBe(false);
    expect(verifyPayload("secret", "100", "{}", "bad", 110)).toBe(false);
    const service = new WebhookDeliveryService();
    expect(() => service.addEndpoint({ ...input, url: "http://insecure.test" })).toThrow("HTTPS");
    expect(service.addEndpoint({ ...input, url: "http://localhost:3000/hook" }).url).toContain("localhost");
    expect(() => service.addEndpoint({ ...input, events: [] })).toThrow("events");
  });
});

describe("built-in forwarders", () => {
  it.each(["slack", "discord", "feishu", "dingtalk", "wecom", "telegram", "email", "pagerduty", "opsgenie"] as ForwarderKind[])("formats %s payloads", (kind) => {
    const payload = formatForwardPayload({ kind, url: "https://forward.test", token: "target" }, createEnvelope("storage.backend_failed", "t", { backend: "s3" }));
    expect(payload.url).toBe("https://forward.test"); expect(JSON.stringify(payload.body)).toContain("storage.backend_failed");
  });
  it("sends formatted messages and handles provider errors", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 })).mockResolvedValueOnce(new Response("no", { status: 400 }));
    const forwarder = new WebhookForwarder(fetcher); const event = createEnvelope("file.expired", "t", {});
    await forwarder.send({ kind: "slack", url: "https://slack.test" }, event);
    expect(fetcher).toHaveBeenCalledWith("https://slack.test", expect.objectContaining({ method: "POST", body: expect.stringContaining("file.expired") }));
    await expect(forwarder.send({ kind: "discord", url: "https://discord.test" }, event)).rejects.toThrow("HTTP 400");
    expect(() => formatForwardPayload({ kind: "telegram", url: "https://telegram.test" }, event)).toThrow("chat id");
  });
});
