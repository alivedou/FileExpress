import { randomUUID } from "node:crypto";
import {
  fingerprintWebhookEnvelope,
  isWebhookEventType,
  parseWebhookEnvelope,
  parseWebhookEnvelopeJson,
  parseWebhookHeaders,
  serializeWebhookEnvelope,
  webhookIdempotencyScope,
  type WebhookEnvelope,
  type WebhookEventType,
} from "./events";

export type EventHandler = (event: WebhookEnvelope) => Promise<void>;
export interface EventBus {
  publish(event: WebhookEnvelope): Promise<boolean>;
  subscribe(type: WebhookEventType | "*", handler: EventHandler): () => void;
  close(): Promise<void>;
}

export type IdempotencyClaim = "new" | "pending" | "duplicate" | "failed" | "conflict";
export interface EventIdempotencyStore {
  claim(key: string, fingerprint: string): Promise<IdempotencyClaim>;
  release?(key: string, fingerprint: string): Promise<void>;
  settle?(key: string, fingerprint: string, outcome?: "success" | "failure"): Promise<void>;
}

interface IdempotencyEntry {
  fingerprint: string;
  status: "pending" | "completed" | "failed";
}

export class MemoryEventIdempotencyStore implements EventIdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly capacity: number;

  constructor(capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000)
      throw new Error("Idempotency capacity must be a finite positive integer");
    this.capacity = capacity;
  }

  async claim(key: string, fingerprint: string): Promise<IdempotencyClaim> {
    validateIdempotencyValues(key, fingerprint);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return "conflict";
      if (existing.status === "pending") return "pending";
      return existing.status === "failed" ? "failed" : "duplicate";
    }
    this.entries.set(key, { fingerprint, status: "pending" });
    this.prune();
    return "new";
  }

  async release(key: string, fingerprint: string): Promise<void> {
    const existing = this.entries.get(key);
    if (existing?.fingerprint === fingerprint) this.entries.delete(key);
  }

  async settle(key: string, fingerprint: string, outcome: "success" | "failure" = "success"): Promise<void> {
    const existing = this.entries.get(key);
    if (existing?.fingerprint === fingerprint) {
      existing.status = outcome === "success" ? "completed" : "failed";
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.prune();
    }
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  private prune(): void {
    if (this.entries.size <= this.capacity) return;
    for (const [key, entry] of this.entries) {
      if (entry.status !== "pending") this.entries.delete(key);
      if (this.entries.size <= this.capacity) return;
    }
  }
}

export class MemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly failures: WebhookEnvelope[] = [];
  private readonly failedKeys = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly idempotency: EventIdempotencyStore;
  private readonly capacity: number;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(capacity = 10_000, idempotencyStore?: EventIdempotencyStore) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000)
      throw new Error("Event bus capacity must be a finite positive integer");
    this.capacity = capacity;
    this.idempotency = idempotencyStore ?? new MemoryEventIdempotencyStore(capacity);
  }

  async publish(event: WebhookEnvelope): Promise<boolean> {
    if (this.closed) throw new Error("Event bus is closed");
    const parsed = parseWebhookEnvelope(event);
    const fingerprint = fingerprintWebhookEnvelope(parsed);
    const idempotencyKey = webhookIdempotencyScope(parsed);
    const claim = await this.idempotency.claim(idempotencyKey, fingerprint);
    if (claim === "conflict")
      throw new Error("Idempotency key conflict: the key belongs to a different event payload");
    if (claim !== "new") return false;
    if (this.closed) {
      await this.idempotency.release?.(idempotencyKey, fingerprint);
      throw new Error("Event bus is closed");
    }
    this.failedKeys.delete(idempotencyKey);
    const task = this.dispatch(parsed);
    this.inFlight.add(task);
    let outcome: "success" | "failure" = "failure";
    try {
      await task;
      outcome = "success";
      return true;
    } catch (error) {
      this.rememberFailure(idempotencyKey);
      throw error;
    } finally {
      this.inFlight.delete(task);
      await this.idempotency.settle?.(idempotencyKey, fingerprint, outcome);
    }
  }

  subscribe(type: WebhookEventType | "*", handler: EventHandler): () => void {
    if (this.closed) throw new Error("Event bus is closed");
    if (type !== "*" && !isWebhookEventType(type)) throw new Error("Invalid webhook event subscription");
    if (typeof handler !== "function") throw new Error("Event handler must be a function");
    const handlers = this.handlers.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => {
      handlers.delete(handler);
      if (!handlers.size) this.handlers.delete(type);
    };
  }

  deadLetters(): WebhookEnvelope[] {
    return this.failures.map((event) => parseWebhookEnvelope(event));
  }

  wasFailed(event: WebhookEnvelope): boolean {
    return this.failedKeys.has(webhookIdempotencyScope(parseWebhookEnvelope(event)));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.inFlight]);
      this.handlers.clear();
    })();
    return this.closePromise;
  }

  private async dispatch(event: WebhookEnvelope): Promise<void> {
    const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])];
    const results = await Promise.allSettled(handlers.map((handler) => handler(parseWebhookEnvelope(event))));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length > 0) {
      this.failures.push(parseWebhookEnvelope(event));
      if (this.failures.length > this.capacity) this.failures.shift();
      throw new AggregateError(errors, "One or more event handlers failed");
    }
  }

  private rememberFailure(key: string): void {
    this.failedKeys.add(key);
    while (this.failedKeys.size > this.capacity)
      this.failedKeys.delete(this.failedKeys.values().next().value ?? "");
  }
}

export interface QueueRecord {
  key: string;
  value: string;
  headers: Record<string, string>;
}
export interface QueueAdapter {
  send(topic: string, record: QueueRecord): Promise<void>;
  subscribe(topic: string, handler: (record: QueueRecord) => Promise<void>): Promise<() => void>;
  close(): Promise<void>;
}

export class QueueEventBus implements EventBus {
  private readonly local = new MemoryEventBus();
  private readonly outgoing: EventIdempotencyStore = new MemoryEventIdempotencyStore();
  private readonly publishing = new Set<Promise<boolean>>();
  private unsubscribe?: () => void;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly adapter: QueueAdapter,
    private readonly topic = "fileexpress.events",
    private readonly consumer = false,
  ) {}

  static async consume(adapter: QueueAdapter, topic = "fileexpress.events"): Promise<QueueEventBus> {
    const bus = new QueueEventBus(adapter, topic, true);
    try {
      bus.unsubscribe = await adapter.subscribe(topic, async (record) => {
        if (bus.closed) throw new Error("Event bus is closed");
        const event = parseQueueRecord(record);
        const accepted = await bus.local.publish(event);
        if (!accepted && bus.local.wasFailed(event))
          throw new Error("Event handler previously failed; delivery requires dead-letter handling");
      });
      return bus;
    } catch (error) {
      await bus.local.close();
      throw error;
    }
  }

  async publish(event: WebhookEnvelope): Promise<boolean> {
    if (this.closed) throw new Error("Event bus is closed");
    const parsed = parseWebhookEnvelope(event);
    const fingerprint = fingerprintWebhookEnvelope(parsed);
    const idempotencyKey = webhookIdempotencyScope(parsed);
    const claim = await this.outgoing.claim(idempotencyKey, fingerprint);
    if (claim === "conflict")
      throw new Error("Idempotency key conflict: the key belongs to a different event payload");
    if (claim !== "new") return false;
    if (this.closed) {
      await this.outgoing.release?.(idempotencyKey, fingerprint);
      throw new Error("Event bus is closed");
    }
    const operation = this.performPublish(parsed, fingerprint, idempotencyKey);
    this.publishing.add(operation);
    try {
      return await operation;
    } finally {
      this.publishing.delete(operation);
    }
  }

  private async performPublish(
    event: WebhookEnvelope,
    fingerprint: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    let sent = false;
    try {
      await this.adapter.send(this.topic, {
        key: event.idempotencyKey,
        value: serializeWebhookEnvelope(event),
        headers: { "content-type": "application/json", "event-type": event.type },
      });
      sent = true;
      if (!this.consumer) await this.local.publish(event);
      return true;
    } catch (error) {
      if (!sent) await this.outgoing.release?.(idempotencyKey, fingerprint);
      throw error;
    } finally {
      if (sent) await this.outgoing.settle?.(idempotencyKey, fingerprint, "success");
    }
  }

  subscribe(type: WebhookEventType | "*", handler: EventHandler): () => void {
    if (this.closed) throw new Error("Event bus is closed");
    return this.local.subscribe(type, handler);
  }

  deadLetters(): WebhookEnvelope[] {
    return this.local.deadLetters();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.allSettled([...this.publishing]);
    try {
      await this.local.close();
    } finally {
      await this.adapter.close();
    }
  }
}

export function createEnvelope(
  type: WebhookEventType,
  tenantId: string,
  data: Record<string, unknown>,
  idempotencyKey: string = randomUUID(),
): WebhookEnvelope {
  if (!isWebhookEventType(type)) throw new Error("Invalid webhook envelope: invalid event type");
  return parseWebhookEnvelope({
    id: randomUUID(),
    idempotencyKey,
    type,
    occurredAt: new Date().toISOString(),
    tenantId,
    data,
  });
}

function parseQueueRecord(record: QueueRecord): WebhookEnvelope {
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    record.key.length > 512 ||
    typeof record.value !== "string"
  )
    throw new Error("Invalid webhook queue record");
  const event = parseWebhookEnvelopeJson(record.value);
  const headers = parseWebhookHeaders(record.headers, event.type);
  const normalized = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const eventId = normalized.get("event-id");
  const idempotencyKey = normalized.get("idempotency-key");
  if (eventId !== undefined && eventId !== event.id)
    throw new Error("Invalid webhook headers: event-id does not match envelope");
  if (idempotencyKey !== undefined && idempotencyKey !== event.idempotencyKey)
    throw new Error("Invalid webhook headers: idempotency-key does not match envelope");
  return event;
}

function validateIdempotencyValues(key: string, fingerprint: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 512 ||
    typeof fingerprint !== "string" ||
    fingerprint.length === 0 ||
    fingerprint.length > 512
  )
    throw new Error("Invalid idempotency key or fingerprint");
}

export { parseWebhookEnvelope, parseWebhookEnvelopeJson, parseWebhookHeaders } from "./events";
export type { WebhookEnvelope, WebhookEventType } from "./events";
