import { canonicalJson, parseAuditRecord } from "./codec";
import type { AuditRecord } from "./types";

export function exportAuditJson(records: readonly AuditRecord[]): string {
  if (!Array.isArray(records)) throw new Error("Audit export records must be an array");
  return records.map((record) => `${canonicalJson(parseAuditRecord(record))}\n`).join("");
}

export function exportAuditCef(records: readonly AuditRecord[]): string {
  if (!Array.isArray(records)) throw new Error("Audit export records must be an array");
  return records
    .map((supplied) => {
      const record = parseAuditRecord(supplied);
      const extension = [
        `rt=${Date.parse(record.timestamp)}`,
        extensionField("suser", record.actorId),
        extensionField("src", record.ip),
        "cs1Label=Tenant",
        extensionField("cs1", record.tenantId),
        "cs2Label=Resource",
        extensionField("cs2", record.resourceId),
        "cs3Label=PreviousHash",
        extensionField("cs3", record.previousHash),
        "cs4Label=Signature",
        extensionField("cs4", record.hash),
        `outcome=${record.outcome}`,
      ].join(" ");
      const action = escapeCefHeader(record.action);
      const resourceType = escapeCefHeader(record.resourceType);
      const severity = record.outcome === "failure" ? 8 : 3;
      return `CEF:0|FileExpress|FileExpress|2.0|${action}|${resourceType}|${severity}|${extension}`;
    })
    .join("\n")
    .concat(records.length > 0 ? "\n" : "");
}

function escapeCefHeader(value: string): string {
  const escaped = sanitizeCefText(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|");
  return escaped.trim().length > 0 ? escaped : "-";
}

function escapeCefExtension(value: string): string {
  const escaped = sanitizeCefText(value).replaceAll("\\", "\\\\").replaceAll("=", "\\=");
  return escaped.trim().length > 0 ? escaped : "-";
}

function extensionField(key: string, value: string): string {
  return `${key}=${escapeCefExtension(value)}`;
}

function sanitizeCefText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");
}

export type { AuditRecord } from "./types";
