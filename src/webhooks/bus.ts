import { randomUUID } from "node:crypto";
import type { WebhookEnvelope, WebhookEventType } from "./events";

export type EventHandler = (event: WebhookEnvelope) => Promise<void>;
export interface EventBus {
  publish(event: WebhookEnvelope): Promise<boolean>;
  subscribe(type: WebhookEventType | "*", handler: EventHandler): () => void;
  close(): Promise<void>;
}

export class MemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly idempotencyKeys = new Set<string>();
  private readonly failures: WebhookEnvelope[] = [];
  constructor(private readonly capacity = 10_000) {}

  async publish(event: WebhookEnvelope): Promise<boolean> {
    if (this.idempotencyKeys.has(event.idempotencyKey)) return false;
    this.idempotencyKeys.add(event.idempotencyKey);
    if (this.idempotencyKeys.size > this.capacity) this.idempotencyKeys.delete(this.idempotencyKeys.values().next().value ?? "");
    const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])];
    const results = await Promise.allSettled(handlers.map((handler) => handler(event)));
    if (results.some((result) => result.status === "rejected")) {
      this.failures.push(event);
      if (this.failures.length > this.capacity) this.failures.shift();
      throw new AggregateError(results.filter((result) => result.status === "rejected").map((result) => result.reason), "One or more event handlers failed");
    }
    return true;
  }
  subscribe(type: WebhookEventType | "*", handler: EventHandler): () => void {
    const handlers = this.handlers.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => { handlers.delete(handler); if (!handlers.size) this.handlers.delete(type); };
  }
  deadLetters(): WebhookEnvelope[] { return [...this.failures]; }
  async close(): Promise<void> { this.handlers.clear(); }
}

export interface QueueRecord { key: string; value: string; headers: Record<string, string> }
export interface QueueAdapter { send(topic: string, record: QueueRecord): Promise<void>; subscribe(topic: string, handler: (record: QueueRecord) => Promise<void>): Promise<() => void>; close(): Promise<void> }

export class QueueEventBus implements EventBus {
  private readonly local = new MemoryEventBus();
  constructor(private readonly adapter: QueueAdapter, private readonly topic = "fileexpress.events", private readonly consumer = false) {}
  static async consume(adapter: QueueAdapter, topic = "fileexpress.events"): Promise<QueueEventBus> {
    const bus = new QueueEventBus(adapter, topic, true);
    await adapter.subscribe(topic, async (record) => { await bus.local.publish(JSON.parse(record.value) as WebhookEnvelope); });
    return bus;
  }
  async publish(event: WebhookEnvelope): Promise<boolean> {
    await this.adapter.send(this.topic, { key: event.idempotencyKey, value: JSON.stringify(event), headers: { "content-type": "application/json", "event-type": event.type } });
    if (!this.consumer) await this.local.publish(event);
    return true;
  }
  subscribe(type: WebhookEventType | "*", handler: EventHandler): () => void { return this.local.subscribe(type, handler); }
  async close(): Promise<void> { await this.adapter.close(); await this.local.close(); }
}

export function createEnvelope(type: WebhookEventType, tenantId: string, data: Record<string, unknown>, idempotencyKey = randomUUID()): WebhookEnvelope {
  return { id: randomUUID(), idempotencyKey, type, occurredAt: new Date().toISOString(), tenantId, data };
}
