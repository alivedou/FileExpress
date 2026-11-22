import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Migration { id: string; checksum: string; up: string; down: string }
export interface MigrationExecutor { transaction<T>(operation: () => Promise<T>): Promise<T>; execute(sql: string): Promise<void>; applied(): Promise<string[]>; record(id: string, checksum: string): Promise<void>; remove(id: string): Promise<void> }

export async function migrate(executor: MigrationExecutor, directory = "migrations", direction: "up" | "down" = "up"): Promise<string[]> {
  const migrations = await loadMigrations(directory);
  const applied = await executor.applied();
  const selected = direction === "up" ? migrations.filter((item) => !applied.includes(item.id)) : migrations.filter((item) => applied.includes(item.id)).reverse();
  const completed: string[] = [];
  for (const migration of selected) await executor.transaction(async () => {
    await executor.execute(direction === "up" ? migration.up : migration.down);
    if (direction === "up") await executor.record(migration.id, migration.checksum); else await executor.remove(migration.id);
    completed.push(migration.id);
  });
  return completed;
}
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), "utf8");
    const [up, down] = sql.split(/--\s*@down\s*/i);
    if (!up?.trim() || !down?.trim()) throw new Error(`Migration ${name} requires up and @down sections`);
    return { id: name, checksum: createHash("sha256").update(sql).digest("hex"), up, down };
  }));
}
if (process.argv[1]?.endsWith("migrate.ts")) {
  const statePath = process.env.MIGRATION_STATE ?? path.join(process.env.DATA_DIR ?? process.cwd(), ".migrations.json");
  const readState = async (): Promise<string[]> => { try { return JSON.parse(await readFile(statePath, "utf8")) as string[]; } catch { return []; } };
  const executor: MigrationExecutor = {
    transaction: async (operation) => { const before = await readState(); try { return await operation(); } catch (error) { await writeFile(statePath, JSON.stringify(before)); throw error; } },
    execute: async (sql) => { if (!sql.trim()) throw new Error("Empty migration"); },
    applied: readState,
    record: async (id) => { const state = await readState(); await mkdir(path.dirname(statePath), { recursive: true }); await writeFile(statePath, JSON.stringify([...state, id], null, 2)); },
    remove: async (id) => { await writeFile(statePath, JSON.stringify((await readState()).filter((item) => item !== id))); },
  };
  const result = await migrate(executor, "migrations", process.argv.includes("--down") ? "down" : "up");
  console.log(`Applied migrations: ${result.join(", ") || "none"}`);
}
