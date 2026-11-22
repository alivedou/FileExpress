export const WEBHOOK_EVENTS = ["file.uploaded", "file.downloaded", "file.expired", "file.scanned", "scan.completed", "scan.threat_detected", "scan.error", "storage.quota_warning", "storage.backend_failed"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
export interface WebhookEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  idempotencyKey: string;
  type: WebhookEventType;
  occurredAt: string;
  tenantId: string;
  data: T;
}
export function isWebhookEventType(value: string): value is WebhookEventType { return (WEBHOOK_EVENTS as readonly string[]).includes(value); }
