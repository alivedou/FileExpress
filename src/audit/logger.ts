import { createHmac, timingSafeEqual } from "node:crypto";

export interface AuditInput { tenantId: string; actorId: string; action: string; resourceType: string; resourceId: string; ip: string; userAgent: string; outcome: "success" | "failure"; details?: Record<string, unknown> }
export interface AuditRecord extends AuditInput { id: number; timestamp: string; previousHash: string; hash: string }

export class AuditLogger {
  private readonly records: AuditRecord[] = [];
  constructor(private readonly signingSecret: string, private readonly maxRecords = 100_000) { if (signingSecret.length < 16) throw new Error("Audit signing secret is too short"); }
  append(input: AuditInput, timestamp = new Date()): AuditRecord {
    const previousHash = this.records.at(-1)?.hash ?? "0".repeat(64);
    const base = { ...input, details: redact(input.details ?? {}), id: this.records.length + 1, timestamp: timestamp.toISOString(), previousHash };
    const record: AuditRecord = { ...base, hash: this.sign(base) };
    this.records.push(record);
    if (this.records.length > this.maxRecords) throw new Error("Audit retention capacity exceeded; export before appending");
    return structuredClone(record);
  }
  search(query: { tenantId: string; text?: string; actorId?: string; action?: string; from?: Date; to?: Date; limit?: number }): AuditRecord[] {
    return this.records.filter((record) => record.tenantId === query.tenantId && (!query.actorId || record.actorId === query.actorId) && (!query.action || record.action === query.action) && (!query.from || new Date(record.timestamp) >= query.from) && (!query.to || new Date(record.timestamp) <= query.to) && (!query.text || JSON.stringify(record).toLowerCase().includes(query.text.toLowerCase()))).slice(-Math.min(query.limit ?? 100, 10_000)).map((record) => structuredClone(record));
  }
  verify(records: AuditRecord[] = this.records): boolean {
    let previous = "0".repeat(64);
    for (const record of records) {
      const { hash, ...base } = record;
      const expected = Buffer.from(this.sign(base));
      if (record.previousHash !== previous || expected.length !== Buffer.from(hash).length || !timingSafeEqual(expected, Buffer.from(hash))) return false;
      previous = hash;
    }
    return true;
  }
  purgeBefore(cutoff: Date): { anchor: string; removed: number } {
    const retained = this.records.filter((record) => new Date(record.timestamp) >= cutoff);
    const removed = this.records.length - retained.length;
    if (removed) throw new Error("Online audit log is append-only; use exportArchive before retention purge");
    return { anchor: this.records.at(-1)?.hash ?? "0".repeat(64), removed };
  }
  exportArchive(cutoff: Date): { records: AuditRecord[]; merkleRoot: string } {
    const records = this.records.filter((record) => new Date(record.timestamp) < cutoff).map((record) => structuredClone(record));
    const hashes = records.map((record) => record.hash);
    while (hashes.length > 1) {
      const next: string[] = [];
      for (let index = 0; index < hashes.length; index += 2) next.push(createHmac("sha256", this.signingSecret).update(`${hashes[index]}:${hashes[index + 1] ?? hashes[index]}`).digest("hex"));
      hashes.splice(0, hashes.length, ...next);
    }
    return { records, merkleRoot: hashes[0] ?? "0".repeat(64) };
  }
  private sign(value: Omit<AuditRecord, "hash">): string { return createHmac("sha256", this.signingSecret).update(stableJson(value)).digest("hex"); }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function redact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|authorization/i.test(key) ? "[REDACTED]" : item]));
}
