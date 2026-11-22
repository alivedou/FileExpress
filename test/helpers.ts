import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackendConfig, FileMeta } from "../src/storage/types";

const directories = new Set<string>();

export async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `fileexpress-${label}-`));
  directories.add(directory);
  return directory;
}

export async function cleanupTestDirectories(): Promise<void> {
  await Promise.all(
    [...directories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      directories.delete(directory);
    }),
  );
}

export function backendConfig(kind: BackendConfig["kind"] = "local", name: string = kind): BackendConfig {
  return { name, kind, enabled: true, priority: 10, options: {} };
}

export function fileMeta(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id: "tenant/file.txt",
    name: "file.txt",
    size: 4,
    mimeType: "text/plain",
    tenantId: "tenant",
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}
