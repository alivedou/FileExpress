import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileMeta, StorageBackend, StorageListPage } from "./types";
import { hashingStream } from "./utils";

export interface MigrationProgress {
  completed: number;
  failed: number;
  total: number;
  current?: string;
}
export interface MigrationOptions {
  deleteSource?: boolean;
  concurrency?: number;
  verify?: boolean;
  onProgress?: (progress: MigrationProgress) => void;
}

export class StorageMigrator {
  async migrate(
    source: StorageBackend,
    destination: StorageBackend,
    options: MigrationOptions = {},
  ): Promise<MigrationProgress> {
    const files = await allFiles(source);
    const progress: MigrationProgress = { completed: 0, failed: 0, total: files.length };
    const queue = [...files];
    const concurrency = options.concurrency ?? 3;
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0)
      throw new Error("Invalid migration concurrency");
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
    await Promise.all(Array.from({ length: Math.min(concurrency, 16) }, () => worker()));
    return progress;
  }

  private async copy(
    source: StorageBackend,
    destination: StorageBackend,
    meta: FileMeta,
    verify: boolean,
  ): Promise<void> {
    const hash = createHash("sha256");
    let size = 0;
    const meter = hashingStream(hash, (bytes) => {
      size += bytes;
    });
    const input = await source.download(meta.id);
    if (!verify) {
      await destination.upload(input, { ...meta, backend: undefined });
      return;
    }
    const forwarding = pipeline(input, meter);
    try {
      const output = await destination.upload(meter, { ...meta, backend: undefined });
      await forwarding;
      const checksum = hash.digest("hex");
      if (
        output.size !== size ||
        output.checksum !== checksum ||
        (meta.checksum && meta.checksum.length === 64 && meta.checksum !== checksum)
      )
        throw new Error(`Checksum verification failed for ${meta.id}`);
    } catch (error) {
      input.destroy();
      meter.destroy();
      await forwarding.catch(() => undefined);
      throw error;
    }
  }
}

async function allFiles(source: StorageBackend): Promise<FileMeta[]> {
  if (!source.listPage) {
    const files = await source.list("", { limit: 1000 });
    if (files.length === 1000)
      throw new Error("Storage backend cannot guarantee complete migration without pagination");
    return files;
  }
  const files: FileMeta[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page: StorageListPage = await source.listPage("", { limit: 1000, ...(cursor ? { cursor } : {}) });
    files.push(...page.files);
    if (!page.nextCursor) return files;
    if (cursors.has(page.nextCursor)) throw new Error("Storage list cursor did not advance");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function readableFromBuffer(value: Buffer): Readable {
  return Readable.from([value]);
}
