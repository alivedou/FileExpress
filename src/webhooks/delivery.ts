import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FetchLike } from "./types";
import {
  fingerprintWebhookEnvelope,
  isWebhookEventType,
  parseWebhookEnvelope,
  serializeWebhookEnvelope,
  WEBHOOK_EVENTS,
  type WebhookEnvelope,
  type WebhookEventType,
} from "./events";

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  enabled: boolean;
  headers?: Record<string, string>;
}
export interface DeliveryAttempt {
  id: string;
  endpointId: string;
  eventId: string;
  idempotencyKey: string;
  attempt: number;
  status: "pending" | "delivered" | "retrying" | "dead";
  responseStatus?: number;
  error?: string;
  createdAt: string;
}
export interface WebhookDeliveryOptions {
  fetchImpl?: FetchLike;
  retries?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxDelayMs?: number;
  historyLimit?: number;
}

export interface ReplayStoreOptions {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
}

interface ReplayEntry {
  expiresAt: number;
}

export class ReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: ReplayStoreOptions | number = {}, now?: () => number) {
    const normalized: ReplayStoreOptions = typeof options === "number" ? { ttlMs: options, now } : options;
    this.ttlMs = finiteNumber(normalized.ttlMs ?? 300_000, 1, 86_400_000, "Replay TTL");
    this.capacity = integerInRange(normalized.capacity ?? 10_000, 1, 1_000_000, "Replay capacity");
    this.now = normalized.now ?? Date.now;
  }

  claim(scope: string, key: string, nowMs = this.currentTime(), ttlMs = this.ttlMs): boolean {
    validateReplayPart(scope, "Replay scope");
    validateReplayPart(key, "Replay key");
    const now = finiteNumber(nowMs, 0, Number.MAX_SAFE_INTEGER, "Replay time");
    const ttl = finiteNumber(ttlMs, 1, 86_400_000, "Replay TTL");
    this.prune(now);
    const storageKey = `${scope}\u0000${key}`;
    if (this.entries.has(storageKey)) return false;
    this.entries.set(storageKey, { expiresAt: Math.min(Number.MAX_SAFE_INTEGER, now + ttl) });
    if (this.entries.size > this.capacity) {
      this.entries.delete(storageKey);
      return false;
    }
    return true;
  }

  accept(scope: string, key: string, nowMs = this.currentTime(), ttlMs = this.ttlMs): boolean {
    return this.claim(scope, key, nowMs, ttlMs);
  }

  has(scope: string, key: string, nowMs = this.currentTime()): boolean {
    validateReplayPart(scope, "Replay scope");
    validateReplayPart(key, "Replay key");
    this.prune(nowMs);
    return this.entries.has(`${scope}\u0000${key}`);
  }

  delete(scope: string, key: string): boolean {
    return this.entries.delete(`${scope}\u0000${key}`);
  }

  clear(scope?: string): void {
    if (scope === undefined) {
      this.entries.clear();
      return;
    }
    const prefix = `${scope}\u0000`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  prune(nowMs = this.currentTime()): number {
    const now = finiteNumber(nowMs, 0, Number.MAX_SAFE_INTEGER, "Replay time");
    const before = this.entries.size;
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    return before - this.entries.size;
  }

  size(nowMs = this.currentTime()): number {
    this.prune(nowMs);
    return this.entries.size;
  }

  private currentTime(): number {
    return finiteNumber(this.now(), 0, Number.MAX_SAFE_INTEGER, "Replay time");
  }
}

export interface SignedWebhookVerifierOptions {
  toleranceSeconds?: number;
  scope?: string;
  now?: () => number;
}

export class SignedWebhookVerifier {
  private readonly toleranceSeconds: number;
  private readonly scope: string;
  private readonly now: () => number;

  constructor(
    private readonly replayStore: ReplayStore = new ReplayStore(),
    options: SignedWebhookVerifierOptions | number = {},
  ) {
    const normalized: SignedWebhookVerifierOptions =
      typeof options === "number" ? { toleranceSeconds: options } : options;
    this.toleranceSeconds = finiteNumber(
      normalized.toleranceSeconds ?? 300,
      0,
      86_400,
      "Signature tolerance",
    );
    this.scope = normalized.scope ?? "default";
    validateReplayPart(this.scope, "Replay scope");
    this.now = normalized.now ?? Date.now;
  }

  verify(
    secret: string,
    timestamp: string,
    payload: string,
    signature: string,
    nowSeconds = Math.floor(this.now() / 1000),
    toleranceSeconds = this.toleranceSeconds,
    scope = this.scope,
  ): boolean {
    if (!verifyPayload(secret, timestamp, payload, signature, nowSeconds, toleranceSeconds)) return false;
    if (
      !Number.isSafeInteger(nowSeconds) ||
      nowSeconds < 0 ||
      nowSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
      !Number.isSafeInteger(toleranceSeconds) ||
      toleranceSeconds < 0 ||
      toleranceSeconds > 86_400
    )
      return false;
    const replayKey = createHash("sha256").update(`${timestamp}\u0000${signature}`).digest("hex");
    return this.replayStore.claim(
      scope,
      replayKey,
      nowSeconds * 1000,
      Math.max(1, toleranceSeconds * 1000 + 1),
    );
  }

  verifyScoped(
    scope: string,
    secret: string,
    timestamp: string,
    payload: string,
    signature: string,
    nowSeconds = Math.floor(this.now() / 1000),
  ): boolean {
    return this.verify(secret, timestamp, payload, signature, nowSeconds, this.toleranceSeconds, scope);
  }
}

export class WebhookDeliveryService {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly attempts: DeliveryAttempt[] = [];
  private readonly outcomes = new Map<string, { fingerprint: string; status: "completed" | "exhausted" }>();
  private readonly inFlight = new Map<string, Promise<DeliveryAttempt[]>>();
  private readonly inFlightFingerprints = new Map<string, string>();
  private readonly pendingEvents = new Map<string, WebhookEnvelope>();
  private readonly fetcher: FetchLike;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly historyLimit: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: WebhookDeliveryOptions = {}) {
    this.fetcher = options.fetchImpl ?? fetch;
    this.retries = integerInRange(options.retries ?? 3, 0, 20, "Webhook retries");
    this.baseDelayMs = finiteNumber(options.baseDelayMs ?? 250, 0, 60_000, "Webhook base delay");
    this.maxDelayMs = finiteNumber(options.maxDelayMs ?? 30_000, 0, 600_000, "Webhook maximum delay");
    this.timeoutMs = finiteNumber(options.timeoutMs ?? 10_000, 1, 120_000, "Webhook timeout");
    this.historyLimit = integerInRange(options.historyLimit ?? 10_000, 1, 100_000, "Webhook history limit");
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? Date.now;
  }

  addEndpoint(input: Omit<WebhookEndpoint, "id"> & { id?: string }): WebhookEndpoint {
    if (!isPlainRecord(input)) throw new Error("Invalid webhook endpoint");
    const url = validateEndpointUrl(input.url);
    const tenantId = boundedText(input.tenantId, "tenant id", 256);
    const id = input.id === undefined ? randomUUID() : boundedText(input.id, "endpoint id", 256);
    if (this.endpoints.has(id)) throw new Error("Webhook endpoint already exists");
    const suppliedSecret = input.secret;
    if (
      typeof suppliedSecret !== "string" ||
      suppliedSecret.length < 16 ||
      suppliedSecret.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(suppliedSecret)
    )
      throw new Error("Webhook events and a secret of at least 16 characters are required");
    if (
      !Array.isArray(input.events) ||
      input.events.length === 0 ||
      input.events.length > WEBHOOK_EVENTS.length
    )
      throw new Error("Webhook events and a secret of at least 16 characters are required");
    const events = [...new Set(input.events)];
    if (
      events.length !== input.events.length ||
      events.some((event) => typeof event !== "string" || !isWebhookEventType(event))
    )
      throw new Error("Invalid webhook events");
    if (typeof input.enabled !== "boolean") throw new Error("Webhook enabled must be a boolean");
    const headers = validateEndpointHeaders(input.headers, undefined);
    const endpoint: WebhookEndpoint = {
      id,
      tenantId,
      url,
      secret: suppliedSecret,
      events,
      enabled: input.enabled,
    };
    if (headers) endpoint.headers = headers;
    this.endpoints.set(id, endpoint);
    return safeEndpoint(endpoint);
  }

  removeEndpoint(id: string): boolean {
    const removed = this.endpoints.delete(id);
    if (removed) {
      const prefix = `${id.length}:${id}|`;
      for (const key of this.pendingEvents.keys()) if (key.startsWith(prefix)) this.pendingEvents.delete(key);
    }
    return removed;
  }

  listEndpoints(tenantId: string): WebhookEndpoint[] {
    return [...this.endpoints.values()].filter((item) => item.tenantId === tenantId).map(safeEndpoint);
  }

  history(endpointId?: string): DeliveryAttempt[] {
    return this.attempts
      .filter((item) => !endpointId || item.endpointId === endpointId)
      .map((item) => ({ ...item }));
  }

  deadLetters(endpointId?: string): DeliveryAttempt[] {
    return this.history(endpointId).filter((item) => item.status === "dead");
  }

  async publish(event: WebhookEnvelope): Promise<DeliveryAttempt[]> {
    const parsed = parseWebhookEnvelope(event);
    const targets = [...this.endpoints.values()].filter(
      (endpoint) =>
        endpoint.enabled && endpoint.tenantId === parsed.tenantId && endpoint.events.includes(parsed.type),
    );
    const results = await Promise.all(targets.map((endpoint) => this.deliverWithRetry(endpoint, parsed)));
    return results.flat();
  }

  async redeliver(attemptId: string): Promise<DeliveryAttempt[]> {
    const previous = this.attempts.find((item) => item.id === attemptId && item.status === "dead");
    if (!previous) throw new Error("Dead delivery attempt not found");
    const endpoint = this.endpoints.get(previous.endpointId);
    if (!endpoint) throw new Error("Webhook endpoint no longer exists");
    if (!endpoint.enabled) throw new Error("Webhook endpoint is disabled");
    const event = this.pendingEvents.get(eventStorageKey(endpoint.id, previous));
    if (!event) throw new Error("Original event payload is unavailable");
    if (endpoint.tenantId !== event.tenantId || !endpoint.events.includes(event.type))
      throw new Error("Webhook endpoint no longer accepts the original event");
    const key = deliveryKey(endpoint.id, event.idempotencyKey);
    if (this.outcomes.get(key)?.status === "completed") return [];
    this.outcomes.delete(key);
    return this.deliverWithRetry(endpoint, event);
  }

  private deliverWithRetry(endpoint: WebhookEndpoint, event: WebhookEnvelope): Promise<DeliveryAttempt[]> {
    const key = deliveryKey(endpoint.id, event.idempotencyKey);
    const fingerprint = fingerprintWebhookEnvelope(event);
    const outcome = this.outcomes.get(key);
    if (outcome) {
      if (outcome.fingerprint !== fingerprint)
        throw new Error("Idempotency key conflict: the delivery key belongs to a different event payload");
      return Promise.resolve([]);
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      if (this.inFlightFingerprints.get(key) !== fingerprint)
        throw new Error("Idempotency key conflict: the delivery key belongs to a different event payload");
      return existing;
    }
    this.inFlightFingerprints.set(key, fingerprint);
    const task = this.runDelivery(endpoint, event, key, fingerprint);
    this.inFlight.set(key, task);
    void task
      .finally(() => {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key);
        this.inFlightFingerprints.delete(key);
      })
      .catch(() => undefined);
    return task;
  }

  private async runDelivery(
    endpoint: WebhookEndpoint,
    event: WebhookEnvelope,
    key: string,
    fingerprint: string,
  ): Promise<DeliveryAttempt[]> {
    const storedEvent = parseWebhookEnvelope(event);
    const records: DeliveryAttempt[] = [];
    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      const record = await this.deliver(endpoint, storedEvent, attempt);
      records.push(record);
      this.attempts.push(record);
      if (this.attempts.length > this.historyLimit) this.attempts.shift();
      if (record.status === "delivered") {
        this.rememberOutcome(key, fingerprint, "completed");
        this.pendingEvents.delete(eventStorageKey(endpoint.id, record));
        return records;
      }
      if (record.status === "dead") {
        this.rememberEvent(endpoint.id, record, storedEvent);
        this.rememberOutcome(key, fingerprint, "exhausted");
        return records;
      }
      const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(attempt - 1, 30));
      await this.sleep(delayMs);
    }
    this.rememberOutcome(key, fingerprint, "exhausted");
    return records;
  }

  private async deliver(
    endpoint: WebhookEndpoint,
    event: WebhookEnvelope,
    attempt: number,
  ): Promise<DeliveryAttempt> {
    const timestamp = Math.floor(
      finiteNumber(this.now(), 0, Number.MAX_SAFE_INTEGER, "Webhook time") / 1000,
    ).toString();
    const payload = serializeWebhookEnvelope(event);
    const signature = signPayload(endpoint.secret, timestamp, payload);
    const base: DeliveryAttempt = {
      id: randomUUID(),
      endpointId: endpoint.id,
      eventId: event.id,
      idempotencyKey: event.idempotencyKey,
      attempt,
      status: "pending",
      createdAt: new Date(finiteNumber(this.now(), 0, 8_640_000_000_000_000, "Webhook time")).toISOString(),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(endpoint.url, {
        method: "POST",
        headers: {
          ...endpoint.headers,
          "Content-Type": "application/json",
          "X-FileExpress-Event": event.type,
          "X-FileExpress-Delivery": event.id,
          "X-FileExpress-Timestamp": timestamp,
          "X-FileExpress-Signature": `sha256=${signature}`,
          "Idempotency-Key": event.idempotencyKey,
        },
        body: payload,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = isRetryableStatus(response.status) && attempt <= this.retries;
        return {
          ...base,
          status: retryable ? "retrying" : "dead",
          responseStatus: response.status,
          error: `HTTP ${response.status}`,
        };
      }
      return { ...base, status: "delivered", responseStatus: response.status };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const retrying = attempt <= this.retries;
      return {
        ...base,
        status: retrying ? "retrying" : "dead",
        error: timedOut ? "Delivery timed out" : safeDeliveryError(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private rememberOutcome(key: string, fingerprint: string, status: "completed" | "exhausted"): void {
    this.outcomes.delete(key);
    this.outcomes.set(key, { fingerprint, status });
    while (this.outcomes.size > this.historyLimit) {
      const oldest = this.outcomes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
  }

  private rememberEvent(endpointId: string, attempt: DeliveryAttempt, event: WebhookEnvelope): void {
    this.pendingEvents.set(eventStorageKey(endpointId, attempt), parseWebhookEnvelope(event));
    while (this.pendingEvents.size > this.historyLimit) {
      const oldest = this.pendingEvents.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pendingEvents.delete(oldest);
    }
  }
}

export function signPayload(secret: string, timestamp: string, payload: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

export function verifyPayload(
  secret: string,
  timestamp: string,
  payload: string,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (
    typeof secret !== "string" ||
    typeof timestamp !== "string" ||
    typeof payload !== "string" ||
    typeof signature !== "string" ||
    !/^\d{1,16}$/.test(timestamp) ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const time = Number(timestamp);
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    !Number.isSafeInteger(toleranceSeconds) ||
    toleranceSeconds < 0 ||
    toleranceSeconds > 86_400 ||
    Math.abs(nowSeconds - time) > toleranceSeconds
  )
    return false;
  const expected = Buffer.from(signature.slice(0, 7) + signPayload(secret, timestamp, payload), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validateEndpointUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid webhook endpoint URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid webhook endpoint URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Webhook endpoints must use HTTPS");
  if (url.username || url.password || url.hash)
    throw new Error("Webhook endpoint URL must not contain credentials or fragments");
  return url.toString();
}

function validateEndpointHeaders(
  value: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new Error("Invalid webhook endpoint headers");
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error("Too many webhook endpoint headers");
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, headerValue] of entries) {
    const lower = name.toLowerCase();
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
      names.has(lower) ||
      ["__proto__", "prototype", "constructor"].includes(lower)
    )
      throw new Error("Invalid webhook endpoint header name");
    const previousValue =
      previous &&
      Object.entries(previous).find(([previousName]) => previousName.toLowerCase() === lower)?.[1];
    const resolvedValue =
      headerValue === "[REDACTED]" && previousValue !== undefined ? previousValue : headerValue;
    if (
      typeof resolvedValue !== "string" ||
      resolvedValue.length > 4096 ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(resolvedValue)
    )
      throw new Error("Invalid webhook endpoint header value");
    if (isReservedDeliveryHeader(lower)) throw new Error(`Webhook header is reserved: ${lower}`);
    names.add(lower);
    headers[name] = resolvedValue;
  }
  return headers;
}

function isReservedDeliveryHeader(name: string): boolean {
  return (
    name === "content-type" ||
    name === "content-length" ||
    name === "host" ||
    name === "connection" ||
    name === "transfer-encoding" ||
    name === "idempotency-key" ||
    name.startsWith("x-fileexpress-")
  );
}

function safeEndpoint(endpoint: WebhookEndpoint): WebhookEndpoint {
  const safe: WebhookEndpoint = { ...endpoint, secret: "[REDACTED]", events: [...endpoint.events] };
  if (endpoint.headers) {
    safe.headers = Object.fromEntries(
      Object.entries(endpoint.headers).map(([name, value]) => [
        name,
        isSensitiveHeader(name) ? "[REDACTED]" : value,
      ]),
    );
  }
  return safe;
}

function isSensitiveHeader(name: string): boolean {
  return /authorization|authentication|cookie|token|secret|signature|api[-_]?key|credential|(?:^|[-_])auth(?:$|[-_])/i.test(
    name,
  );
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 409 || status === 425 || status === 429;
}

function safeDeliveryError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Delivery timed out";
  return "Delivery request failed";
}

function deliveryKey(endpointId: string, idempotencyKey: string): string {
  return `${endpointId.length}:${endpointId}|${idempotencyKey.length}:${idempotencyKey}`;
}

function eventStorageKey(
  endpointId: string,
  attempt: Pick<DeliveryAttempt, "eventId" | "idempotencyKey">,
): string {
  return `${endpointId.length}:${endpointId}|${attempt.eventId.length}:${attempt.eventId}|${attempt.idempotencyKey.length}:${attempt.idempotencyKey}`;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`Invalid webhook ${label}`);
  return value;
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label} must be a finite integer between ${minimum} and ${maximum}`);
  return value;
}

function finiteNumber(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateReplayPart(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label} is invalid`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
