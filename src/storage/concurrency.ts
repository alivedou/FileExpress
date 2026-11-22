const storageLocks = new Map<string, Promise<unknown>>();

export async function withStorageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = storageLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  storageLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (storageLocks.get(key) === current) storageLocks.delete(key);
  }
}
