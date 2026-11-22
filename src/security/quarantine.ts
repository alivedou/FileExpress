import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { ScanSummary } from "./types";

export interface QuarantineRecord { fileId: string; quarantineId: string; reason: string; createdAt: string; checksum: string; released: boolean }

export class FileQuarantineStore {
  constructor(private readonly root: string) {}
  async isolate(fileId: string, stream: Readable, summary: ScanSummary): Promise<QuarantineRecord> {
    const quarantineId = createHash("sha256").update(`${fileId}:${Date.now()}`).digest("hex");
    const directory = path.join(this.root, quarantineId);
    await mkdir(directory, { recursive: true });
    const hash = createHash("sha256");
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    const temporary = path.join(directory, "payload.tmp");
    await pipeline(stream, meter, createWriteStream(temporary, { flags: "wx" }));
    const checksum = hash.digest("hex");
    await rename(temporary, path.join(directory, "payload.bin"));
    const record: QuarantineRecord = { fileId, quarantineId, reason: summary.verdict, createdAt: new Date().toISOString(), checksum, released: false };
    await writeFile(path.join(directory, "record.json"), JSON.stringify({ record, summary }), "utf8");
    return record;
  }
  async get(quarantineId: string): Promise<{ record: QuarantineRecord; summary: ScanSummary }> {
    this.assertId(quarantineId);
    return JSON.parse(await readFile(path.join(this.root, quarantineId, "record.json"), "utf8")) as { record: QuarantineRecord; summary: ScanSummary };
  }
  async release(quarantineId: string): Promise<QuarantineRecord> {
    const value = await this.get(quarantineId);
    value.record.released = true;
    await writeFile(path.join(this.root, quarantineId, "record.json"), JSON.stringify(value), "utf8");
    return value.record;
  }
  private assertId(id: string): void { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid quarantine identifier"); }
}
