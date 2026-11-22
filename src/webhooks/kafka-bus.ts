import type { Consumer, Kafka, Producer } from "kafkajs";
import type { QueueAdapter, QueueRecord } from "./bus";

export class KafkaQueueAdapter implements QueueAdapter {
  constructor(private readonly producer: Producer, private readonly consumer: Consumer) {}
  static async create(kafka: Kafka, groupId = "fileexpress-webhooks"): Promise<KafkaQueueAdapter> { const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 }); const consumer = kafka.consumer({ groupId }); await Promise.all([producer.connect(), consumer.connect()]); return new KafkaQueueAdapter(producer, consumer); }
  async send(topic: string, record: QueueRecord): Promise<void> { await this.producer.send({ topic, messages: [{ key: record.key, value: record.value, headers: record.headers }] }); }
  async subscribe(topic: string, handler: (record: QueueRecord) => Promise<void>): Promise<() => void> {
    await this.consumer.subscribe({ topic, fromBeginning: false });
    await this.consumer.run({ eachMessage: async ({ message }) => { await handler({ key: message.key?.toString() ?? message.offset, value: message.value?.toString() ?? "{}", headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([key, value]) => [key, String(value)])) }); } });
    return () => { void this.consumer.stop(); };
  }
  async close(): Promise<void> { await Promise.all([this.producer.disconnect(), this.consumer.disconnect()]); }
}
