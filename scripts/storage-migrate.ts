import path from "node:path";
import { LocalStorageBackend } from "../src/storage/local";
import { StorageMigrator } from "../src/storage/migration";
import type { BackendConfig } from "../src/storage/types";
const [sourceRoot, destinationRoot] = process.argv.slice(2);
if (!sourceRoot || !destinationRoot)
  throw new Error("Usage: tsx scripts/storage-migrate.ts <source-dir> <destination-dir> [--delete-source]");
const config = (name: string, root: string): BackendConfig => ({
  name,
  kind: "local",
  enabled: true,
  priority: 0,
  options: { root: path.resolve(root) },
});
const source = new LocalStorageBackend();
const destination = new LocalStorageBackend();
await source.init(config("source", sourceRoot));
await destination.init(config("destination", destinationRoot));
const result = await new StorageMigrator().migrate(source, destination, {
  concurrency: Number(process.env.MIGRATION_CONCURRENCY ?? 4),
  deleteSource: process.argv.includes("--delete-source"),
  onProgress: (progress) =>
    console.log(`${progress.completed + progress.failed}/${progress.total} ${progress.current ?? ""}`),
});
if (result.failed)
  throw new Error(
    `Migration failed for ${result.failed} files; source objects were retained where verification failed`,
  );
console.log(`Migrated ${result.completed} files with SHA-256 verification`);
