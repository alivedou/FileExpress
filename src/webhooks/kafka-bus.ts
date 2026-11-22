import type { Consumer, Kafka, Producer } from "kafkajs";
import type { EventIdempotencyStore, QueueAdapter, QueueRecord } from "./bus";
import {
  fingerprintWebhookEnvelope,
  parseWebhookEnvelopeJson,
  parseWebhookHeaders,
  webhookIdempotencyScope,
  type WebhookEnvelope,
} from "./events";

export interface KafkaQueueAdapterOptions {
  deadLetterTopic?: string;
  idempotencyStore?: EventIdempotencyStore;
  onError?: (error: Error) => void;
}

export class KafkaQueueAdapter implements QueueAdapter {
  private readonly sending = new Set<Promise<unknown>>();
  private subscribed = false;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly producer: Producer,
    private readonly consumer: Consumer,
    private readonly options: KafkaQueueAdapterOptions = {},
  ) {}

  static async create(
    kafka: Kafka,
    groupId = "fileexpress-webhooks",
    options: KafkaQueueAdapterOptions = {},
  ): Promise<KafkaQueueAdapter> {
    boundedName(groupId, "Kafka group id");
    const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    const consumer = kafka.consumer({ groupId });
    try {
      await producer.connect();
      await consumer.connect();
      return new KafkaQueueAdapter(producer, consumer, options);
    } catch (error) {
      await Promise.allSettled([producer.disconnect(), consumer.disconnect()]);
      throw error;
    }
  }

  async send(topic: string, record: QueueRecord): Promise<void> {
    if (this.closed) throw new Error("Kafka queue adapter is closed");
    validateRecord(topic, record);
    const operation = this.producer.send({
      topic,
      messages: [{ key: record.key, value: record.value, headers: record.headers }],
    });
    this.sending.add(operation);
    try {
      await operation;
    } finally {
      this.sending.delete(operation);
    }
  }

  async subscribe(topic: string, handler: (record: QueueRecord) => Promise<void>): Promise<() => void> {
    if (this.closed) throw new Error("Kafka queue adapter is closed");
    if (this.subscribed) throw new Error("Kafka queue adapter already has a subscription");
    boundedName(topic, "Kafka topic");
    if (typeof handler !== "function") throw new Error("Kafka queue handler must be a function");
    this.subscribed = true;
    try {
      await this.consumer.subscribe({ topic, fromBeginning: false });
      await this.consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic: sourceTopic, partition, message }) => {
          const offset = nextOffset(message.offset);
          let record: QueueRecord;
          try {
            record = parseKafkaRecord(message.key, message.value, message.headers);
          } catch {
            record = {
              key: message.key?.toString() || `offset-${message.offset}`,
              value: message.value?.toString() ?? "",
              headers: {},
            };
            await this.writeDeadLetter(sourceTopic, partition, record, offset);
            await this.commit(sourceTopic, partition, offset);
            this.report("Malformed Kafka webhook record moved to dead letter");
            return;
          }
          let claimed = false;
          let fingerprint: string | undefined;
          let idempotencyKey = record.key;
          if (this.options.idempotencyStore) {
            let event: WebhookEnvelope;
            try {
              event = parseWebhookEnvelopeJson(record.value);
            } catch {
              await this.deadLetter(sourceTopic, partition, record, offset, false);
              return;
            }
            fingerprint = fingerprintWebhookEnvelope(event);
            idempotencyKey = webhookIdempotencyScope(event);
            const claim = await this.options.idempotencyStore.claim(idempotencyKey, fingerprint);
            if (claim === "pending") throw new Error("Kafka webhook event is already being processed");
            if (claim === "conflict") {
              await this.deadLetter(sourceTopic, partition, record, offset, false);
              return;
            }
            if (claim === "failed") {
              await this.deadLetter(sourceTopic, partition, record, offset, false);
              return;
            }
            if (claim === "duplicate") {
              await this.commit(sourceTopic, partition, offset);
              return;
            }
            claimed = true;
          }
          try {
            await handler(record);
          } catch {
            await this.deadLetter(
              sourceTopic,
              partition,
              record,
              offset,
              claimed,
              fingerprint,
              idempotencyKey,
            );
            return;
          }
          if (claimed && fingerprint)
            await this.options.idempotencyStore?.settle?.(idempotencyKey, fingerprint);
          await this.commit(sourceTopic, partition, offset);
        },
      });
    } catch (error) {
      this.subscribed = false;
      throw error;
    }
    return () => {
      void this.consumer.stop().catch(() => this.report("Kafka consumer stop failed"));
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    await Promise.allSettled([...this.sending]);
    const failures: unknown[] = [];
    if (this.subscribed) {
      try {
        await this.consumer.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    const results = await Promise.allSettled([this.producer.disconnect(), this.consumer.disconnect()]);
    failures.push(
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : [])),
    );
    this.subscribed = false;
    if (failures.length > 0) throw new AggregateError(failures, "Kafka queue adapter close failed");
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer.commitOffsets([{ topic, partition, offset }]);
  }

  private async deadLetter(
    sourceTopic: string,
    partition: number,
    record: QueueRecord,
    offset: string,
    claimed: boolean,
    fingerprint?: string,
    idempotencyKey = record.key,
  ): Promise<void> {
    try {
      await this.writeDeadLetter(sourceTopic, partition, record, offset);
    } catch (error) {
      if (claimed && fingerprint) await this.options.idempotencyStore?.release?.(idempotencyKey, fingerprint);
      throw error;
    }
    if (claimed && fingerprint) {
      try {
        await this.options.idempotencyStore?.settle?.(idempotencyKey, fingerprint, "failure");
      } catch (error) {
        await this.options.idempotencyStore?.release?.(idempotencyKey, fingerprint);
        throw error;
      }
    }
    await this.commit(sourceTopic, partition, offset);
    this.report("Kafka webhook event moved to dead letter");
  }

  private async writeDeadLetter(
    sourceTopic: string,
    partition: number,
    record: QueueRecord,
    offset: string,
  ): Promise<void> {
    const topic = this.options.deadLetterTopic ?? `${sourceTopic}.dead-letter`;
    boundedName(topic, "Kafka dead-letter topic");
    await this.producer.send({
      topic,
      messages: [
        {
          key: record.key,
          value: record.value,
          headers: {
            ...record.headers,
            "x-fileexpress-source-topic": sourceTopic,
            "x-fileexpress-source-partition": String(partition),
            "x-fileexpress-source-offset": (BigInt(offset) - 1n).toString(),
            "x-fileexpress-error": "Webhook handler failed",
          },
        },
      ],
    });
  }

  private report(message: string): void {
    if (!this.options.onError) return;
    try {
      this.options.onError(new Error(message));
    } catch {
      return;
    }
  }
}

function parseKafkaRecord(
  key: string | Buffer | null,
  value: string | Buffer | null,
  rawHeaders: Record<string, string | Buffer | Array<string | Buffer> | undefined> | undefined,
): QueueRecord {
  if (key === null || value === null)
    throw new Error("Invalid Kafka webhook record: key and value are required");
  const recordKey = key.toString();
  const recordValue = value.toString();
  if (!recordKey || recordKey.length > 512 || recordValue.length === 0 || recordValue.length > 1_000_000)
    throw new Error("Invalid Kafka webhook record size");
  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(rawHeaders ?? {})) {
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      if (rawValue.length !== 1) throw new Error("Invalid Kafka webhook header multiplicity");
      const only = rawValue[0];
      if (only === undefined) throw new Error("Invalid Kafka webhook header");
      headers[name] = only.toString();
    } else {
      headers[name] = rawValue.toString();
    }
  }
  return { key: recordKey, value: recordValue, headers: parseWebhookHeaders(headers) };
}

function nextOffset(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error("Invalid Kafka offset");
  return (BigInt(value) + 1n).toString();
}

function validateRecord(topic: string, record: QueueRecord): void {
  boundedName(topic, "Kafka topic");
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    record.key.length > 512 ||
    typeof record.value !== "string" ||
    record.value.length === 0 ||
    record.value.length > 1_000_000
  )
    throw new Error("Invalid Kafka queue record");
  parseWebhookHeaders(record.headers);
}

function boundedName(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label} is invalid`);
}
