import type { AuditInput, AuditRecord } from "./types";

export const AUDIT_ZERO_HASH = "0".repeat(64);
export const AUDIT_HASH_PATTERN = /^[a-f0-9]{64}$/;

const inputFields = [
  "tenantId",
  "actorId",
  "action",
  "resourceType",
  "resourceId",
  "ip",
  "userAgent",
  "outcome",
] as const;
const recordFields = [...inputFields, "details", "id", "timestamp", "previousHash", "hash"] as const;
const allowedInputFields = new Set<string>([...inputFields, "details"]);
const allowedRecordFields = new Set<string>(recordFields);
const sensitiveKey =
  /password|passwd|secret|token|authorization|api[-_]?key|credential|private[-_]?key|cookie|session/i;
const maximumDepth = 64;
const maximumNodes = 100_000;
const maximumStringLength = 1_048_576;

export function parseAuditInput(value: unknown): AuditInput {
  const object = requireObject(value, "Audit input");
  assertKeys(object, allowedInputFields, inputFields, "Audit input");
  const result: AuditInput = {
    tenantId: requiredString(object.tenantId, "tenantId"),
    actorId: requiredString(object.actorId, "actorId"),
    action: requiredString(object.action, "action"),
    resourceType: requiredString(object.resourceType, "resourceType"),
    resourceId: requiredString(object.resourceId, "resourceId"),
    ip: requiredString(object.ip, "ip"),
    userAgent: requiredString(object.userAgent, "userAgent"),
    outcome: requireOutcome(object.outcome),
    details: parseDetails(object.details),
  };
  return result;
}

export function parseAuditRecord(value: unknown): AuditRecord {
  const object = requireObject(value, "Audit record");
  assertKeys(
    object,
    allowedRecordFields,
    [...inputFields, "id", "timestamp", "previousHash", "hash"],
    "Audit record",
  );
  const id = object.id;
  const timestamp = object.timestamp;
  const previousHash = object.previousHash;
  const hash = object.hash;
  if (!Number.isSafeInteger(id) || typeof id !== "number" || id < 1)
    throw new Error("Invalid audit record id");
  if (typeof timestamp !== "string" || !isCanonicalTimestamp(timestamp)) {
    throw new Error("Invalid audit record timestamp");
  }
  if (!isAuditHash(previousHash) || !isAuditHash(hash)) throw new Error("Invalid audit record hash");
  const result: AuditRecord = {
    tenantId: requiredString(object.tenantId, "tenantId", true),
    actorId: requiredString(object.actorId, "actorId", true),
    action: requiredString(object.action, "action", true),
    resourceType: requiredString(object.resourceType, "resourceType", true),
    resourceId: requiredString(object.resourceId, "resourceId", true),
    ip: requiredString(object.ip, "ip", true),
    userAgent: requiredString(object.userAgent, "userAgent", true),
    outcome: requireOutcome(object.outcome),
    id,
    timestamp,
    previousHash,
    hash,
  };
  if (object.details !== undefined) result.details = parseJsonObject(object.details, false);
  return result;
}

export function canonicalJson(value: unknown): string {
  const normalized = normalizeJson(value, false, 0, { count: 0 }, new Set<object>());
  return serializeCanonical(normalized);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  const object = requireObject(value, "Canonical JSON");
  const entries = Object.keys(object)
    .sort(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(object[key])}`);
  return `{${entries.join(",")}}`;
}

export function isAuditHash(value: unknown): value is string {
  return typeof value === "string" && AUDIT_HASH_PATTERN.test(value);
}

export function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseDetails(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  return parseJsonObject(value, true);
}

function parseJsonObject(value: unknown, redact: boolean): Record<string, unknown> {
  const normalized = normalizeJson(value, redact, 0, { count: 0 }, new Set<object>());
  if (!isObject(normalized) || Array.isArray(normalized))
    throw new Error("Audit details must be a JSON object");
  return normalized;
}

function normalizeJson(
  value: unknown,
  redact: boolean,
  depth: number,
  budget: { count: number },
  ancestors: Set<object>,
): unknown {
  budget.count += 1;
  if (budget.count > maximumNodes || depth > maximumDepth) throw new Error("Audit JSON data is too complex");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > maximumStringLength) throw new Error("Audit JSON string is too long");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Audit JSON numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw new Error("Audit details must contain JSON data only");
  if (ancestors.has(value)) throw new Error("Audit JSON data must not contain cycles");
  if (Array.isArray(value)) {
    assertArrayDescriptors(value);
    ancestors.add(value);
    const result = value.map((item) => normalizeJson(item, redact, depth + 1, budget, ancestors));
    ancestors.delete(value);
    return result;
  }
  const object = requireObject(value, "Audit details");
  ancestors.add(value);
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(object).sort(compareStrings)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Unsafe audit JSON property");
    }
    if (redact && sensitiveKey.test(key)) {
      entries.push([key, "[REDACTED]"]);
      continue;
    }
    const item = normalizeJson(object[key], redact, depth + 1, budget, ancestors);
    entries.push([key, item]);
  }
  ancestors.delete(value);
  return Object.fromEntries(entries);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} contains a non-JSON property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} contains a non-JSON property`);
    }
  }
  return value;
}

function assertArrayDescriptors(value: unknown[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
      throw new Error("Audit arrays contain a non-JSON property");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("Audit arrays contain a non-JSON property");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error("Audit arrays must not contain holes");
  }
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing field: ${key}`);
  }
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumStringLength
  ) {
    throw new Error(`Invalid audit field: ${field}`);
  }
  return value;
}

function requireOutcome(value: unknown): "success" | "failure" {
  if (value !== "success" && value !== "failure") throw new Error("Invalid audit outcome");
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
