export interface ChunkUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  activeChunks: number;
}

export interface ResumableUploadOptions {
  file: File;
  chunkSize?: number;
  concurrency?: number;
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ChunkUploadProgress) => void;
  fetchImpl?: typeof fetch;
}

export interface ResumableUploadResult {
  uploadId: string;
  checksum: string;
  size: number;
  pickupCode?: string;
  expiresAt?: string;
}

interface CreateResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
}

interface StatusResponse {
  receivedChunks: number[];
}

export class ResumableChunkUploader {
  private paused = false;
  private resumePromise: Promise<void> | undefined;
  private resume: (() => void) | undefined;

  constructor(private readonly options: ResumableUploadOptions) {}

  pause(): void {
    this.paused = true;
  }

  continue(): void {
    this.paused = false;
    this.resume?.();
    this.resume = undefined;
    this.resumePromise = undefined;
  }

  async start(existingUploadId?: string): Promise<ResumableUploadResult> {
    const fetcher = this.options.fetchImpl ?? fetch;
    const chunkSize = this.options.chunkSize ?? 8 * 1024 * 1024;
    const created = existingUploadId
      ? { uploadId: existingUploadId, chunkSize, totalChunks: Math.ceil(this.options.file.size / chunkSize) }
      : await this.createSession(fetcher, chunkSize);
    const completed = await this.receivedChunks(fetcher, created.uploadId);
    let uploadedBytes = completed.reduce((total, index) => total + this.chunkSize(index, created.chunkSize), 0);
    let activeChunks = 0;
    const pending = Array.from({ length: created.totalChunks }, (_, index) => index).filter(
      (index) => !completed.includes(index),
    );
    const concurrency = Math.max(1, this.options.concurrency ?? 3);
    const worker = async (): Promise<void> => {
      while (pending.length) {
        await this.waitIfPaused();
        this.options.signal?.throwIfAborted();
        const index = pending.shift();
        if (index === undefined) return;
        activeChunks += 1;
        this.report(uploadedBytes, activeChunks);
        try {
          const size = this.chunkSize(index, created.chunkSize);
          await this.uploadWithRetry(fetcher, created.uploadId, index, created.chunkSize);
          uploadedBytes += size;
        } finally {
          activeChunks -= 1;
          this.report(uploadedBytes, activeChunks);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
    const response = await fetcher(`/api/upload/chunks/${created.uploadId}/complete`, { method: "POST" });
    if (!response.ok) throw new Error(`Upload completion failed: ${response.status}`);
    const result = (await response.json()) as ResumableUploadResult;
    this.report(this.options.file.size, 0);
    return result;
  }

  private async createSession(fetcher: typeof fetch, chunkSize: number): Promise<CreateResponse> {
    const response = await fetcher("/api/upload/chunks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: this.options.file.name,
        mimeType: this.options.file.type || "application/octet-stream",
        totalSize: this.options.file.size,
        chunkSize,
      }),
      signal: this.options.signal,
    });
    if (!response.ok) throw new Error(`Unable to create upload: ${response.status}`);
    return (await response.json()) as CreateResponse;
  }

  private async receivedChunks(fetcher: typeof fetch, uploadId: string): Promise<number[]> {
    const response = await fetcher(`/api/upload/chunks/${uploadId}`, { signal: this.options.signal });
    if (!response.ok) throw new Error(`Unable to restore upload: ${response.status}`);
    return ((await response.json()) as StatusResponse).receivedChunks;
  }

  private async uploadWithRetry(fetcher: typeof fetch, uploadId: string, index: number, chunkSize: number): Promise<void> {
    const retries = this.options.retries ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const blob = this.options.file.slice(index * chunkSize, (index + 1) * chunkSize);
        const checksum = await sha256(blob);
        const response = await fetcher(`/api/upload/chunks/${uploadId}/${index}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": checksum },
          body: blob,
          signal: this.options.signal,
        });
        if (!response.ok) throw new Error(`Chunk ${index} failed: ${response.status}`);
        return;
      } catch (error) {
        lastError = error;
        if (this.options.signal?.aborted || attempt === retries) break;
        await delay(2 ** attempt * 250, this.options.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Chunk upload failed");
  }

  private chunkSize(index: number, configured: number): number {
    return Math.min(configured, this.options.file.size - index * configured);
  }

  private report(uploadedBytes: number, activeChunks: number): void {
    this.options.onProgress?.({
      uploadedBytes,
      totalBytes: this.options.file.size,
      percentage: this.options.file.size ? Math.round((uploadedBytes / this.options.file.size) * 100) : 100,
      activeChunks,
    });
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    this.resumePromise ??= new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    await this.resumePromise;
  }
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
