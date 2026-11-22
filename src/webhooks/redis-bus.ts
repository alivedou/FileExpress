import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { EventIdempotencyStore, QueueAdapter, QueueRecord } from "./bus";
import {
  fingerprintWebhookEnvelope,
  parseWebhookEnvelopeJson,
  parseWebhookHeaders,
  webhookIdempotencyScope,
  type WebhookEnvelope,
} from "./events";

export interface RedisQueueAdapterOptions {
  group?: string;
  consumer?: string;
  blockMs?: number;
  claimIdleMs?: number;
  retryDelayMs?: number;
  batchSize?: number;
  maxDeliveries?: number;
  deadLetterTopic?: string;
  disconnectOnClose?: boolean;
  onError?: (error: Error) => void;
  idempotencyStore?: EventIdempotencyStore;
}

interface RedisSubscription {
  active: boolean;
  task: Promise<void>;
}

interface PendingEntry {
  id: string;
  deliveries: number;
}

export class RedisQueueAdapter implements QueueAdapter {
  private readonly subscriptions = new Set<RedisSubscription>();
  private readonly sending = new Set<Promise<unknown>>();
  private readonly groupReady = new Map<string, Promise<void>>();
  private readonly group: string;
  private readonly consumer: string;
  private readonly blockMs: number;
  private readonly claimIdleMs: number;
  private readonly retryDelayMs: number;
  private readonly batchSize: number;
  private readonly maxDeliveries: number;
  private readonly deadLetterTopic?: string;
  private readonly disconnectOnClose: boolean;
  private readonly onError?: (error: Error) => void;
  private readonly idempotencyStore?: EventIdempotencyStore;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly redis: Redis,
    options: RedisQueueAdapterOptions = {},
  ) {
    this.group = boundedName(options.group ?? "fileexpress-webhooks", "Redis consumer group");
    this.consumer = boundedName(options.consumer ?? `webhook-${randomUUID()}`, "Redis consumer name");
    this.blockMs = boundedInteger(options.blockMs ?? 1_000, 1, 30_000, "Redis block time");
    this.claimIdleMs = boundedInteger(options.claimIdleMs ?? 5_000, 0, 3_600_000, "Redis claim idle time");
    this.retryDelayMs = boundedInteger(options.retryDelayMs ?? 1_000, 1, 60_000, "Redis retry delay");
    this.batchSize = boundedInteger(options.batchSize ?? 50, 1, 1_000, "Redis batch size");
    this.maxDeliveries = boundedInteger(options.maxDeliveries ?? 5, 1, 100, "Redis maximum deliveries");
    this.deadLetterTopic =
      options.deadLetterTopic === undefined
        ? undefined
        : boundedName(options.deadLetterTopic, "Redis dead-letter topic");
    this.disconnectOnClose = options.disconnectOnClose ?? true;
    this.onError = options.onError;
    this.idempotencyStore = options.idempotencyStore;
  }

  async send(topic: string, record: QueueRecord): Promise<void> {
    if (this.closed) throw new Error("Redis queue adapter is closed");
    validateTopic(topic);
    validateRecord(record);
    const operation = this.xaddRecord(topic, record);
    this.sending.add(operation);
    try {
      await operation;
    } finally {
      this.sending.delete(operation);
    }
  }

  async subscribe(topic: string, handler: (record: QueueRecord) => Promise<void>): Promise<() => void> {
    if (this.closed) throw new Error("Redis queue adapter is closed");
    validateTopic(topic);
    if (typeof handler !== "function") throw new Error("Redis queue handler must be a function");
    await this.ensureGroup(topic);
    if (this.closed) throw new Error("Redis queue adapter is closed");
    const subscription: RedisSubscription = { active: true, task: Promise.resolve() };
    subscription.task = this.consume(topic, handler, subscription);
    this.subscriptions.add(subscription);
    void subscription.task.finally(() => this.subscriptions.delete(subscription)).catch(() => undefined);
    return () => {
      subscription.active = false;
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const subscription of this.subscriptions) subscription.active = false;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    await Promise.allSettled([
      ...[...this.subscriptions].map((subscription) => subscription.task),
      ...this.sending,
    ]);
    this.subscriptions.clear();
    if (this.disconnectOnClose) this.redis.disconnect();
  }

  private async ensureGroup(topic: string): Promise<void> {
    const existing = this.groupReady.get(topic);
    if (existing) return existing;
    const task = (async () => {
      try {
        await this.redis.xgroup("CREATE", topic, this.group, "0", "MKSTREAM");
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("BUSYGROUP"))) throw error;
      }
    })();
    this.groupReady.set(topic, task);
    try {
      await task;
    } catch (error) {
      this.groupReady.delete(topic);
      throw error;
    }
  }

  private async consume(
    topic: string,
    handler: (record: QueueRecord) => Promise<void>,
    subscription: RedisSubscription,
  ): Promise<void> {
    while (subscription.active && !this.closed) {
      try {
        await this.claimPending(topic, handler, subscription);
        if (!subscription.active || this.closed) break;
        const result: unknown = await this.redis.xreadgroup(
          "GROUP",
          this.group,
          this.consumer,
          "COUNT",
          this.batchSize,
          "BLOCK",
          this.blockMs,
          "STREAMS",
          topic,
          ">",
        );
        const entries = parseStreamResult(result, topic);
        for (const entry of entries) {
          if (!subscription.active || this.closed) break;
          await this.process(topic, entry.id, entry.record, 1, handler);
        }
      } catch {
        this.report("Redis webhook consumer operation failed");
        if (subscription.active && !this.closed) await sleep(this.retryDelayMs);
      }
    }
  }

  private async claimPending(
    topic: string,
    handler: (record: QueueRecord) => Promise<void>,
    subscription: RedisSubscription,
  ): Promise<void> {
    const pending: unknown = await this.redis.xpending(
      topic,
      this.group,
      "IDLE",
      this.claimIdleMs,
      "-",
      "+",
      this.batchSize,
    );
    for (const entry of parsePending(pending)) {
      if (!subscription.active || this.closed) return;
      const claimed: unknown = await this.redis.xclaim(
        topic,
        this.group,
        this.consumer,
        this.claimIdleMs,
        entry.id,
      );
      const records = parseClaimedEntries(claimed);
      for (const record of records) {
        if (record.id !== entry.id) continue;
        await this.process(topic, record.id, record.record, entry.deliveries + 1, handler);
      }
    }
  }

  private async process(
    topic: string,
    id: string,
    record: QueueRecord,
    deliveries: number,
    handler: (record: QueueRecord) => Promise<void>,
  ): Promise<void> {
    let claimed = false;
    let fingerprint: string | undefined;
    let idempotencyKey = record.key;
    if (this.idempotencyStore) {
      let event: WebhookEnvelope;
      try {
        event = parseWebhookEnvelopeJson(record.value);
      } catch {
        await this.handleFailure(topic, id, record, deliveries, false);
        return;
      }
      fingerprint = fingerprintWebhookEnvelope(event);
      idempotencyKey = webhookIdempotencyScope(event);
      const claim = await this.idempotencyStore.claim(idempotencyKey, fingerprint);
      if (claim === "pending") {
        this.report("Redis webhook event is already being processed; event remains pending");
        return;
      }
      if (claim === "conflict") {
        await this.handleFailure(topic, id, record, deliveries, false);
        return;
      }
      if (claim === "failed") {
        await this.moveToDeadLetter(topic, id, record, deliveries, false);
        return;
      }
      if (claim === "duplicate") {
        try {
          await this.redis.xack(topic, this.group, id);
        } catch {
          this.report("Redis duplicate event ACK failed; event remains pending");
        }
        return;
      }
      claimed = true;
    }
    try {
      await handler(record);
    } catch {
      await this.handleFailure(topic, id, record, deliveries, claimed, fingerprint, idempotencyKey);
      return;
    }
    if (claimed && fingerprint) {
      try {
        await this.idempotencyStore?.settle?.(idempotencyKey, fingerprint, "success");
      } catch {
        await this.idempotencyStore?.release?.(idempotencyKey, fingerprint);
        this.report("Redis idempotency completion failed; event remains pending");
        return;
      }
    }
    try {
      await this.redis.xack(topic, this.group, id);
    } catch {
      this.report("Redis webhook ACK failed; event remains pending");
    }
  }

  private async handleFailure(
    topic: string,
    id: string,
    record: QueueRecord,
    deliveries: number,
    claimed: boolean,
    fingerprint?: string,
    idempotencyKey = record.key,
  ): Promise<void> {
    if (deliveries >= this.maxDeliveries) {
      await this.moveToDeadLetter(topic, id, record, deliveries, claimed, fingerprint, idempotencyKey);
      return;
    }
    if (claimed && fingerprint) await this.idempotencyStore?.release?.(idempotencyKey, fingerprint);
    this.report("Redis webhook handler failed; event remains pending");
  }

  private async moveToDeadLetter(
    topic: string,
    id: string,
    record: QueueRecord,
    deliveries: number,
    claimed: boolean,
    fingerprint?: string,
    idempotencyKey = record.key,
  ): Promise<void> {
    try {
      await this.writeDeadLetter(topic, id, record, deliveries);
    } catch {
      if (claimed && fingerprint) await this.idempotencyStore?.release?.(idempotencyKey, fingerprint);
      this.report("Redis webhook dead-letter operation failed; event remains pending");
      return;
    }
    if (claimed && fingerprint) {
      try {
        await this.idempotencyStore?.settle?.(idempotencyKey, fingerprint, "failure");
      } catch {
        await this.idempotencyStore?.release?.(idempotencyKey, fingerprint);
        this.report("Redis idempotency dead-letter completion failed; event remains pending");
        return;
      }
    }
    try {
      await this.redis.xack(topic, this.group, id);
      this.report("Redis webhook event moved to dead letter");
    } catch {
      this.report("Redis dead-letter source ACK failed; event remains pending");
    }
  }

  private async writeDeadLetter(
    topic: string,
    id: string,
    record: QueueRecord,
    deliveries: number,
  ): Promise<void> {
    const deadLetterTopic = this.deadLetterTopic ?? `${topic}.dead-letter`;
    const result = await this.redis.xadd(
      deadLetterTopic,
      "*",
      "key",
      record.key,
      "value",
      record.value,
      "headers",
      JSON.stringify(record.headers),
      "source-id",
      id,
      "delivery-count",
      String(deliveries),
      "error",
      "Webhook handler failed",
    );
    if (result === null) throw new Error("Redis dead-letter write was not acknowledged");
  }

  private async xaddRecord(topic: string, record: QueueRecord): Promise<void> {
    const result = await this.redis.xadd(
      topic,
      "*",
      "key",
      record.key,
      "value",
      record.value,
      "headers",
      JSON.stringify(record.headers),
    );
    if (result === null) throw new Error("Redis stream write was not acknowledged");
  }

  private report(message: string): void {
    if (!this.onError) return;
    try {
      this.onError(new Error(message));
    } catch {
      return;
    }
  }
}

function parseStreamResult(
  value: unknown,
  expectedTopic: string,
): Array<{ id: string; record: QueueRecord }> {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid Redis stream response");
  const output: Array<{ id: string; record: QueueRecord }> = [];
  for (const stream of value) {
    if (!Array.isArray(stream) || stream.length !== 2 || stream[0] !== expectedTopic)
      throw new Error("Invalid Redis stream response");
    output.push(...parseClaimedEntries(stream[1]));
  }
  return output;
}

function parseClaimedEntries(value: unknown): Array<{ id: string; record: QueueRecord }> {
  if (!Array.isArray(value)) throw new Error("Invalid Redis stream entries");
  const output: Array<{ id: string; record: QueueRecord }> = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !Array.isArray(entry[1])
    )
      throw new Error("Invalid Redis stream entry");
    const fields = new Map<string, string>();
    const rawFields: unknown[] = entry[1];
    let validFields = rawFields.length % 2 === 0;
    for (let index = 0; validFields && index < rawFields.length; index += 2) {
      const name = rawFields[index];
      const fieldValue = rawFields[index + 1];
      if (typeof name !== "string" || typeof fieldValue !== "string" || fields.has(name)) {
        validFields = false;
        break;
      }
      fields.set(name, fieldValue);
    }
    if (!validFields) {
      output.push({ id: entry[0], record: { key: entry[0], value: "", headers: {} } });
      continue;
    }
    const key = fields.get("key");
    const payload = fields.get("value");
    const rawHeaders = fields.get("headers");
    if (!key || payload === undefined || rawHeaders === undefined) {
      output.push({ id: entry[0], record: { key: key || entry[0], value: "", headers: {} } });
      continue;
    }
    try {
      const decodedHeaders: unknown = JSON.parse(rawHeaders) as unknown;
      output.push({
        id: entry[0],
        record: { key, value: payload, headers: parseWebhookHeaders(decodedHeaders) },
      });
    } catch {
      output.push({
        id: entry[0],
        record: { key, value: payload, headers: { "content-type": "text/plain" } },
      });
    }
  }
  return output;
}

function parsePending(value: unknown): PendingEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid Redis pending response");
  return value.map((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error("Invalid Redis pending entry");
    const deliveries = Number(entry[2]);
    if (!Number.isSafeInteger(deliveries) || deliveries < 1) throw new Error("Invalid Redis delivery count");
    return { id: entry[0], deliveries };
  });
}

function validateRecord(record: QueueRecord): void {
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    record.key.length > 512 ||
    typeof record.value !== "string" ||
    record.value.length > 1_000_000
  )
    throw new Error("Invalid Redis queue record");
  parseWebhookHeaders(record.headers);
}

function validateTopic(topic: string): void {
  boundedName(topic, "Redis topic");
}

function boundedName(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label} is invalid`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label} is outside its allowed range`);
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
