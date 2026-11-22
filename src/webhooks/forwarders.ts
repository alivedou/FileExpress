import type { FetchLike } from "./types";
import { parseWebhookEnvelope, type WebhookEnvelope } from "./events";

export type ForwarderKind =
  | "slack"
  | "discord"
  | "feishu"
  | "dingtalk"
  | "wecom"
  | "telegram"
  | "email"
  | "sendgrid"
  | "pagerduty"
  | "opsgenie";
export interface ForwarderTarget {
  kind: ForwarderKind;
  url: string;
  token?: string;
  chatId?: string;
  to?: string | string[];
  from?: string;
  headers?: Record<string, string>;
}
export interface ForwardMessage {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
export interface SafeForwarderTarget {
  kind: ForwarderKind;
  url: "[REDACTED]";
  token?: "[REDACTED]";
  headers?: Record<string, "[REDACTED]">;
}
export interface WebhookForwarderOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const SENSITIVE_KEY =
  /authorization|authentication|cookie|token|secret|password|passwd|signature|api[-_]?key|credential|private[-_]?key|routing[-_]?key|chat[-_]?id|^(?:to|from)$/i;

export function formatForwardPayload(target: ForwarderTarget, event: WebhookEnvelope): ForwardMessage {
  const parsed = parseWebhookEnvelope(event);
  const url = validateForwarderUrl(target.url);
  const headers = validateForwarderHeaders(target.headers);
  const safeData = redactSensitive(parsed.data) as Record<string, unknown>;
  const text = truncateUtf8(`[${parsed.tenantId}] ${parsed.type}: ${safeJson(safeData)}`, 65_536);
  switch (target.kind) {
    case "slack": {
      const slackText = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      return {
        url,
        headers,
        body: {
          text: truncateUtf8(slackText, 40_000),
          blocks: [{ type: "section", text: { type: "mrkdwn", text: truncateUtf8(slackText, 3_000) } }],
        },
      };
    }
    case "discord":
      return { url, headers, body: { content: truncateUtf8(text, 2_000), allowed_mentions: { parse: [] } } };
    case "feishu":
      return { url, headers, body: { msg_type: "text", content: { text: truncateUtf8(text, 30_000) } } };
    case "dingtalk":
      return { url, headers, body: { msgtype: "text", text: { content: truncateUtf8(text, 20_000) } } };
    case "wecom":
      return { url, headers, body: { msgtype: "text", text: { content: truncateUtf8(text, 2_048) } } };
    case "telegram": {
      const chatId = target.chatId ?? target.token;
      if (!chatId) throw new Error("Telegram chat id is required");
      return {
        url,
        headers,
        body: { chat_id: chatId, text: truncateUtf8(text, 4_096), disable_web_page_preview: true },
      };
    }
    case "email": {
      const body: Record<string, unknown> = {
        subject: truncateUtf8(`FileExpress ${parsed.type}`, 200),
        text: truncateUtf8(text, 65_536),
        templateData: safeData,
      };
      if (target.to !== undefined) body.to = normalizeAddresses(target.to, "Email recipient");
      if (target.from !== undefined) body.from = normalizeAddress(target.from, "Email sender");
      return { url, headers, body };
    }
    case "sendgrid": {
      if (target.to === undefined) throw new Error("SendGrid recipient is required");
      if (target.from === undefined) throw new Error("SendGrid sender is required");
      const token = requiredToken(target);
      return {
        url,
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: {
          personalizations: [
            { to: normalizeAddresses(target.to, "SendGrid recipient").map((email) => ({ email })) },
          ],
          from: { email: normalizeAddress(target.from, "SendGrid sender") },
          subject: truncateUtf8(`FileExpress ${parsed.type}`, 200),
          content: [{ type: "text/plain", value: truncateUtf8(text, 65_536) }],
        },
      };
    }
    case "pagerduty": {
      const routingKey = requiredToken(target);
      return {
        url,
        headers,
        body: {
          routing_key: routingKey,
          event_action: "trigger",
          dedup_key: truncateUtf8(parsed.idempotencyKey, 255),
          payload: {
            summary: truncateUtf8(text, 1_024),
            source: "fileexpress",
            severity:
              parsed.type.includes("failed") ||
              parsed.type.includes("threat") ||
              parsed.type.includes("error")
                ? "critical"
                : "warning",
            timestamp: parsed.occurredAt,
            component: "fileexpress-webhooks",
            custom_details: safeData,
          },
        },
      };
    }
    case "opsgenie":
      return {
        url,
        headers: { ...headers, Authorization: `GenieKey ${requiredToken(target)}` },
        body: {
          message: truncateUtf8(text, 130),
          alias: truncateUtf8(parsed.idempotencyKey, 512),
          description: truncateUtf8(safeJson({ ...parsed, data: safeData }), 15_000),
          priority: parsed.type.includes("failed") || parsed.type.includes("threat") ? "P1" : "P3",
          details: opsgenieDetails(safeData),
        },
      };
  }
}

export function safeForwarderTarget(target: ForwarderTarget): SafeForwarderTarget {
  const safe: SafeForwarderTarget = { kind: target.kind, url: REDACTED };
  if (target.token !== undefined || target.chatId !== undefined) safe.token = REDACTED;
  const headers = target.headers ? validateForwarderHeaders(target.headers) : undefined;
  if (headers) safe.headers = Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED]));
  return safe;
}

export function safeForwardPayload(target: ForwarderTarget, event: WebhookEnvelope): ForwardMessage {
  const message = formatForwardPayload(target, event);
  return {
    url: REDACTED,
    headers: Object.fromEntries(Object.keys(message.headers).map((name) => [name, REDACTED])),
    body: redactSensitive(message.body) as Record<string, unknown>,
  };
}

export class WebhookForwarder {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(fetchImpl?: FetchLike, options: WebhookForwarderOptions = {}) {
    this.fetcher = fetchImpl ?? fetch;
    this.timeoutMs = boundedNumber(options.timeoutMs ?? 10_000, 1, 120_000, "Forwarder timeout");
    this.maxResponseBytes = boundedNumber(
      options.maxResponseBytes ?? 65_536,
      1,
      1_048_576,
      "Forwarder response limit",
    );
  }

  async send(target: ForwarderTarget, event: WebhookEnvelope): Promise<void> {
    const message = formatForwardPayload(target, event);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(message.url, {
        method: "POST",
        headers: { ...message.headers, "Content-Type": "application/json" },
        body: JSON.stringify(message.body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
        throw new Error(`${target.kind} forwarder request timed out`);
      throw new Error(`${target.kind} forwarder request failed`);
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw new Error(`${target.kind} forwarder returned HTTP ${response.status}`);
    }
    try {
      await validateProviderResponse(target.kind, response, this.maxResponseBytes);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, 0, { count: 0 });
}

function redactValue(value: unknown, depth: number, budget: { count: number }, redact = false): unknown {
  budget.count += 1;
  if (redact) return REDACTED;
  if (budget.count > 20_000 || depth > 16) return TRUNCATED;
  if (typeof value === "string") return redactString(truncateUtf8(value, 8_192));
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactValue(item, depth + 1, budget));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 500))
      output[key] = redactValue(nested, depth + 1, budget, SENSITIVE_KEY.test(key));
    return output;
  }
  return TRUNCATED;
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\b(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]")
    .replace(/((?:token|secret|password|signature|api[-_]?key)=)[^\s&]+/gi, `$1${REDACTED}`);
}

function safeJson(value: unknown): string {
  return JSON.stringify(redactSensitive(value)) ?? "{}";
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  if (maximumBytes <= 3) return ".".repeat(Math.max(0, maximumBytes));
  const limit = maximumBytes - 3;
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    output += character;
    bytes += size;
  }
  return `${output}...`;
}

function opsgenieDetails(data: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data)
      .slice(0, 100)
      .map(([key, value]) => [
        truncateUtf8(key, 100),
        truncateUtf8(typeof value === "string" ? value : safeJson(value), 500),
      ]),
  );
}

function validateForwarderUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid forwarder URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid forwarder URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Forwarder endpoints must use HTTPS");
  if (url.username || url.password || url.hash)
    throw new Error("Forwarder URL must not contain credentials or fragments");
  return value;
}

function validateForwarderHeaders(value: Record<string, string> | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new Error("Invalid forwarder headers");
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error("Too many forwarder headers");
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, headerValue] of entries) {
    const lower = name.toLowerCase();
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
      names.has(lower) ||
      ["content-type", "content-length", "host", "connection", "transfer-encoding"].includes(lower)
    )
      throw new Error("Invalid or reserved forwarder header");
    if (
      typeof headerValue !== "string" ||
      headerValue.length > 4096 ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(headerValue)
    )
      throw new Error("Invalid forwarder header value");
    names.add(lower);
    headers[name] = headerValue;
  }
  return headers;
}

async function validateProviderResponse(
  kind: ForwarderKind,
  response: Response,
  maximumBytes: number,
): Promise<void> {
  let text: string;
  try {
    text = await readLimitedResponse(response, maximumBytes);
  } catch {
    throw new Error(`${kind} forwarder returned an unreadable response`);
  }
  if (text.trim().length === 0) return;
  if (kind === "slack" && text.trim().toLowerCase() === "ok") return;
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    if (kind === "email") return;
    if (kind === "slack") throw providerBusinessError(kind);
    throw new Error(`${kind} forwarder returned an invalid response`);
  }
  if (!isPlainRecord(body)) throw new Error(`${kind} forwarder returned an invalid response`);
  const code = body.code ?? body.errcode ?? body.error_code ?? body.StatusCode;
  if ((typeof code === "number" || typeof code === "string") && String(code) !== "0")
    throw providerBusinessError(
      kind,
      typeof code === "number" && Number.isFinite(code) ? String(code) : undefined,
    );
  if (body.ok === false || body.success === false || body.StatusCode === 400)
    throw providerBusinessError(kind, optionalProviderCode(body.error));
  if (kind === "telegram" && body.ok !== true)
    throw providerBusinessError(kind, optionalProviderCode(body.error_code));
  if (kind === "pagerduty" && body.status !== undefined && body.status !== "success")
    throw providerBusinessError(kind);
  if (kind === "slack" && body.ok !== true)
    throw providerBusinessError(kind, optionalProviderCode(body.error));
}

function providerBusinessError(kind: ForwarderKind, code?: string): Error {
  const safeCode = code && /^[A-Za-z0-9_. -]{1,64}$/.test(code) ? ` (code ${code})` : "";
  return new Error(`${kind} forwarder rejected the request${safeCode}`);
}

function optionalProviderCode(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maximumBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!chunk.value) continue;
    const remaining = maximumBytes - total;
    chunks.push(chunk.value.slice(0, Math.max(0, remaining)));
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeAddresses(value: string | string[], label: string): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 100) throw new Error(`${label} list is invalid`);
  return values.map((item) => normalizeAddress(item, label));
}

function normalizeAddress(value: string, label: string): string {
  if (typeof value !== "string" || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function requiredToken(target: ForwarderTarget): string {
  if (!target.token || target.token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(target.token))
    throw new Error(`${target.kind} token is required`);
  return target.token;
}

function boundedNumber(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${label} must be finite and within bounds`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
