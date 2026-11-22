import Redis from "ioredis";
import type { QueueAdapter, QueueRecord } from "./bus";

export class RedisQueueAdapter implements QueueAdapter {
  private running = true;
  constructor(private readonly redis: Redis) {}
  async send(topic: string, record: QueueRecord): Promise<void> { await this.redis.xadd(topic, "*", "key", record.key, "value", record.value, "headers", JSON.stringify(record.headers)); }
  async subscribe(topic: string, handler: (record: QueueRecord) => Promise<void>): Promise<() => void> {
    void this.consume(topic, handler);
    return () => { this.running = false; };
  }
  async close(): Promise<void> { this.running = false; this.redis.disconnect(); }
  private async consume(topic: string, handler: (record: QueueRecord) => Promise<void>): Promise<void> {
    let cursor = "$";
    while (this.running) {
      try {
        const result = await this.redis.xread("BLOCK", 1000, "STREAMS", topic, cursor);
        for (const stream of result ?? []) for (const [id, fields] of stream[1]) {
          cursor = id; const map = new Map<string, string>(); for (let index = 0; index < fields.length; index += 2) map.set(fields[index] ?? "", fields[index + 1] ?? "");
          await handler({ key: map.get("key") ?? id, value: map.get("value") ?? "{}", headers: JSON.parse(map.get("headers") ?? "{}") as Record<string, string> });
        }
      } catch { if (this.running) await new Promise((resolve) => setTimeout(resolve, 1000)); }
    }
  }
}
