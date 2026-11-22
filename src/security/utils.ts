export function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

export function errorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maximumBytes) throw new Error("Response exceeds configured size limit");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!item.value) continue;
      const chunk = Buffer.from(item.value);
      size += chunk.length;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Response exceeds configured size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export function safeDetail(value: string, maximum = 512): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximum);
}
