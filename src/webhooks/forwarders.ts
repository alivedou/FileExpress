import type { FetchLike } from "../security/clamav";
import type { WebhookEnvelope } from "./events";

export type ForwarderKind = "slack" | "discord" | "feishu" | "dingtalk" | "wecom" | "telegram" | "email" | "pagerduty" | "opsgenie";
export interface ForwarderTarget { kind: ForwarderKind; url: string; token?: string }

export function formatForwardPayload(target: ForwarderTarget, event: WebhookEnvelope): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const text = `[${event.tenantId}] ${event.type}: ${JSON.stringify(event.data)}`;
  switch (target.kind) {
    case "slack": return { url: target.url, headers: {}, body: { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] } };
    case "discord": return { url: target.url, headers: {}, body: { content: text.slice(0, 2000) } };
    case "feishu": return { url: target.url, headers: {}, body: { msg_type: "text", content: { text } } };
    case "dingtalk": return { url: target.url, headers: {}, body: { msgtype: "text", text: { content: text } } };
    case "wecom": return { url: target.url, headers: {}, body: { msgtype: "text", text: { content: text } } };
    case "telegram":
      if (!target.token) throw new Error("Telegram chat id is required");
      return { url: target.url, headers: {}, body: { chat_id: target.token, text, disable_web_page_preview: true } };
    case "email": return { url: target.url, headers: {}, body: { subject: `FileExpress ${event.type}`, text, templateData: event.data } };
    case "pagerduty": return { url: target.url, headers: { Authorization: `Token token=${requiredToken(target)}` }, body: { routing_key: target.token, event_action: "trigger", dedup_key: event.idempotencyKey, payload: { summary: text, source: "fileexpress", severity: event.type.includes("failed") || event.type.includes("threat") ? "critical" : "warning" } } };
    case "opsgenie": return { url: target.url, headers: { Authorization: `GenieKey ${requiredToken(target)}` }, body: { message: text.slice(0, 130), alias: event.idempotencyKey, description: JSON.stringify(event), priority: event.type.includes("failed") ? "P1" : "P3" } };
  }
}

export class WebhookForwarder {
  private readonly fetcher: FetchLike;
  constructor(fetchImpl?: FetchLike) { this.fetcher = fetchImpl ?? fetch; }
  async send(target: ForwarderTarget, event: WebhookEnvelope): Promise<void> {
    const message = formatForwardPayload(target, event);
    const response = await this.fetcher(message.url, { method: "POST", headers: { "Content-Type": "application/json", ...message.headers }, body: JSON.stringify(message.body) });
    if (!response.ok) throw new Error(`${target.kind} forwarder returned HTTP ${response.status}`);
  }
}
function requiredToken(target: ForwarderTarget): string { if (!target.token) throw new Error(`${target.kind} token is required`); return target.token; }
