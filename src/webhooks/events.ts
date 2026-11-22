import { createHash } from "node:crypto";

export const WEBHOOK_EVENTS = [
  "file.uploaded",
  "file.downloaded",
  "file.expired",
  "file.scanned",
  "scan.completed",
  "scan.threat_detected",
  "scan.error",
  "storage.quota_warning",
  "storage.backend_failed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
export interface WebhookEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  idempotencyKey: string;
  type: WebhookEventType;
  occurredAt: string;
  tenantId: string;
  data: T;
}

const EVENT_TYPES = new Set<string>(WEBHOOK_EVENTS);
const ENVELOPE_KEYS = new Set(["id", "idempotencyKey", "type", "occurredAt", "tenantId", "data"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_ENVELOPE_LENGTH = 1_000_000;

export function isWebhookEventType(value: string): value is WebhookEventType {
  return EVENT_TYPES.has(value);
}

export function parseWebhookEnvelope(value: unknown): WebhookEnvelope {
  const record = requireRecord(value, "webhook envelope");
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.has(key)) throw invalidEnvelope(`unexpected field ${key}`);
  }
  const id = requiredString(record.id, "id", 256);
  const idempotencyKey = requiredString(record.idempotencyKey, "idempotencyKey", 512);
  if (typeof record.type !== "string" || !isWebhookEventType(record.type))
    throw invalidEnvelope("invalid event type");
  if (typeof record.occurredAt !== "string" || record.occurredAt.length > 64)
    throw invalidEnvelope("invalid occurredAt");
  const occurredAt = new Date(record.occurredAt);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== record.occurredAt)
    throw invalidEnvelope("occurredAt must be a canonical ISO timestamp");
  const tenantId = requiredString(record.tenantId, "tenantId", 256);
  const data = requireRecord(record.data, "webhook envelope data");
  validateJson(data, "data", 0, { count: 0 });
  const envelope: WebhookEnvelope = {
    id,
    idempotencyKey,
    type: record.type,
    occurredAt: record.occurredAt,
    tenantId,
    data: structuredClone(data),
  };
  if (stringifyValidated(envelope).length > MAX_ENVELOPE_LENGTH)
    throw invalidEnvelope("payload is too large");
  return envelope;
}

export function parseWebhookEnvelopeJson(payload: string): WebhookEnvelope {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_ENVELOPE_LENGTH)
    throw invalidEnvelope("invalid JSON payload size");
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw invalidEnvelope("malformed JSON");
  }
  return parseWebhookEnvelope(value);
}

export function serializeWebhookEnvelope(event: WebhookEnvelope): string {
  return stringifyValidated(parseWebhookEnvelope(event));
}

export function assertWebhookEnvelope(value: unknown): asserts value is WebhookEnvelope {
  parseWebhookEnvelope(value);
}

export function isWebhookEnvelope(value: unknown): value is WebhookEnvelope {
  try {
    parseWebhookEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

export function parseWebhookHeaders(value: unknown, expectedType?: WebhookEventType): Record<string, string> {
  const record = requireRecord(value, "webhook headers");
  const entries = Object.entries(record);
  if (entries.length > 64) throw new Error("Invalid webhook headers: too many headers");
  const headers: Record<string, string> = {};
  const normalized = new Map<string, string>();
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME.test(name) || FORBIDDEN_KEYS.has(name.toLowerCase()))
      throw new Error("Invalid webhook headers: invalid header name");
    if (
      typeof headerValue !== "string" ||
      headerValue.length > 4096 ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(headerValue)
    )
      throw new Error("Invalid webhook headers: invalid header value");
    const lowerName = name.toLowerCase();
    if (normalized.has(lowerName)) throw new Error("Invalid webhook headers: duplicate header name");
    normalized.set(lowerName, headerValue);
    headers[name] = headerValue;
  }
  const contentType = normalized.get("content-type");
  if (contentType !== undefined && contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new Error("Invalid webhook headers: content-type must be application/json");
  const eventType = normalized.get("event-type");
  if (eventType !== undefined) {
    if (!isWebhookEventType(eventType)) throw new Error("Invalid webhook headers: invalid event-type");
    if (expectedType !== undefined && eventType !== expectedType)
      throw new Error("Invalid webhook headers: event-type does not match envelope");
  }
  return headers;
}

export function fingerprintWebhookEnvelope(event: WebhookEnvelope): string {
  const parsed = parseWebhookEnvelope(event);
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}

export function webhookIdempotencyScope(event: Pick<WebhookEnvelope, "tenantId" | "idempotencyKey">): string {
  return `${event.tenantId.length}:${event.tenantId}|${event.idempotencyKey.length}:${event.idempotencyKey}`;
}

function requiredString(value: unknown, field: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw invalidEnvelope(`invalid ${field}`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}: expected an object`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`Invalid ${label}: expected a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new Error(`Invalid ${label}: symbol keys are not allowed`);
  return value as Record<string, unknown>;
}

function invalidEnvelope(detail: string): Error {
  return new Error(`Invalid webhook envelope: ${detail}`);
}

function validateJson(value: unknown, path: string, depth: number, budget: { count: number }): void {
  budget.count += 1;
  if (budget.count > 20_000) throw invalidEnvelope("data is too complex");
  if (depth > 16) throw invalidEnvelope(`${path} is nested too deeply`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidEnvelope(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_ENVELOPE_LENGTH) throw invalidEnvelope(`${path} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw invalidEnvelope(`${path} contains too many items`);
    for (let index = 0; index < value.length; index += 1)
      validateJson(value[index], `${path}[${index}]`, depth + 1, budget);
    return;
  }
  if (typeof value === "object") {
    const record = requireRecord(value, "webhook envelope data");
    const entries = Object.entries(record);
    if (entries.length > 512) throw invalidEnvelope(`${path} contains too many fields`);
    for (const [key, nested] of entries) {
      if (FORBIDDEN_KEYS.has(key)) throw invalidEnvelope(`${path} contains a forbidden field`);
      validateJson(nested, `${path}.${key}`, depth + 1, budget);
    }
    return;
  }
  throw invalidEnvelope(`${path} contains a non-JSON value`);
}

function stringifyValidated(value: unknown): string {
  const serialized = JSON.stringify(value) as string | undefined;
  if (serialized === undefined) throw invalidEnvelope("payload is not JSON serializable");
  return serialized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
