/**
 * TTL 内存缓存类
 * 用于磁盘使用率 / 存储占用的周期性缓存，避免重复阻塞 IO
 */
export class TTLCache<T> {
    private value: T | null = null;
    private updatedAt = 0;
    private ttlMs: number;

    constructor(ttlMs: number) {
        this.ttlMs = ttlMs;
    }

    get(): T | null {
        if (this.value === null) return null;
        if (Date.now() - this.updatedAt > this.ttlMs) {
            this.value = null;
            return null;
        }
        return this.value;
    }

    set(value: T): void {
        this.value = value;
        this.updatedAt = Date.now();
    }

    invalidate(): void {
        this.value = null;
    }
}
