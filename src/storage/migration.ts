import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { FileMeta, StorageBackend } from "./types";

export interface MigrationProgress { completed: number; failed: number; total: number; current?: string }
export interface MigrationOptions { deleteSource?: boolean; concurrency?: number; verify?: boolean; onProgress?: (progress: MigrationProgress) => void }

export class StorageMigrator {
  async migrate(source: StorageBackend, destination: StorageBackend, options: MigrationOptions = {}): Promise<MigrationProgress> {
    const files = await source.list("", { limit: 1000 });
    const progress: MigrationProgress = { completed: 0, failed: 0, total: files.length };
    const queue = [...files];
    const worker = async (): Promise<void> => {
      while (queue.length) {
        const meta = queue.shift();
        if (!meta) return;
        progress.current = meta.id;
        try {
          await this.copy(source, destination, meta, options.verify !== false);
          if (options.deleteSource) await source.delete(meta.id);
          progress.completed += 1;
        } catch {
          progress.failed += 1;
        }
        options.onProgress?.({ ...progress });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, 16)) }, () => worker()));
    return progress;
  }

  private async copy(source: StorageBackend, destination: StorageBackend, meta: FileMeta, verify: boolean): Promise<void> {
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } });
    const input = await source.download(meta.id);
    const output = await destination.upload(verify ? input.pipe(meter) : input, { ...meta, backend: undefined });
    if (verify) {
      const checksum = hash.digest("hex");
      if (output.size !== size || output.checksum !== checksum || (meta.checksum && meta.checksum.length === 64 && meta.checksum !== checksum)) throw new Error(`Checksum verification failed for ${meta.id}`);
    }
  }
}

export function readableFromBuffer(value: Buffer): Readable {
  return Readable.from([value]);
}
