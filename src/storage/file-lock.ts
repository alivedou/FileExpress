import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
}

export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = await acquire(lockPath);
  const heartbeat = setInterval(() => {
    void refreshOwnership(lockPath, token);
  }, 30000);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await release(lockPath, token);
  }
}

async function acquire(lockPath: string): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + 120000;
  while (Date.now() <= deadline) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(lockPath, "wx", 0o600);
      created = true;
      const owner: LockOwner = { token, pid: process.pid, hostname: hostname() };
      await handle.writeFile(JSON.stringify(owner), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      return token;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (errorCode(error) !== "EEXIST") {
        if (created) await release(lockPath, token).catch(() => undefined);
        throw error;
      }
    }
    await recoverStaleLock(lockPath);
    await delay(25);
  }
  throw new Error("Timed out waiting for storage lock");
}

async function recoverStaleLock(lockPath: string): Promise<void> {
  let owner: LockOwner | undefined;
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    if (
      typeof parsed.token === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string"
    )
      owner = { token: parsed.token, pid: parsed.pid, hostname: parsed.hostname };
  } catch {
    owner = undefined;
  }
  let stale = false;
  if (owner?.hostname === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0)
    stale = !processAlive(owner.pid);
  try {
    if (Date.now() - (await stat(lockPath)).mtimeMs > 300000) stale = true;
  } catch {
    return;
  }
  if (!stale) return;
  const abandoned = `${lockPath}.${owner?.token ?? randomUUID()}.stale`;
  try {
    await rename(lockPath, abandoned);
    await unlink(abandoned);
  } catch {
    await unlink(abandoned).catch(() => undefined);
  }
}

async function refreshOwnership(lockPath: string, token: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    if (parsed.token !== token) return;
    const now = new Date();
    await utimes(lockPath, now, now);
  } catch {
    return;
  }
}

async function release(lockPath: string, token: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    if (parsed.token === token) await unlink(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
