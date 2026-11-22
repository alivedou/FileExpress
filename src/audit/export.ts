import type { AuditRecord } from "./logger";

export function exportAuditJson(records: AuditRecord[]): string { return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""); }
export function exportAuditCef(records: AuditRecord[]): string {
  return records.map((record) => {
    const extension = [`rt=${Date.parse(record.timestamp)}`, `suser=${escapeCef(record.actorId)}`, `src=${escapeCef(record.ip)}`, `cs1Label=Tenant`, `cs1=${escapeCef(record.tenantId)}`, `cs2Label=Resource`, `cs2=${escapeCef(record.resourceId)}`, `cs3Label=PreviousHash`, `cs3=${record.previousHash}`, `cs4Label=Signature`, `cs4=${record.hash}`, `outcome=${record.outcome}`].join(" ");
    return `CEF:0|FileExpress|FileExpress|2.0|${escapeCef(record.action)}|${escapeCef(record.resourceType)}|${record.outcome === "failure" ? 8 : 3}|${extension}`;
  }).join("\n") + (records.length ? "\n" : "");
}
function escapeCef(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("=", "\\=").replaceAll("\n", " ").replaceAll("\r", " "); }
