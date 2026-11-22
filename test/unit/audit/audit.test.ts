import { describe, expect, it } from "vitest";
import { exportAuditCef, exportAuditJson } from "../../../src/audit/export";
import { AuditLogger, type AuditInput } from "../../../src/audit/logger";

const input: AuditInput = { tenantId: "t", actorId: "user", action: "file.uploaded", resourceType: "file", resourceId: "f=1", ip: "127.0.0.1", userAgent: "agent", outcome: "success", details: { token: "do-not-log", size: 12 } };

describe("audit logging", () => {
  it("appends a verifiable signed chain and redacts secrets", () => {
    const logger = new AuditLogger("audit-signing-secret");
    const first = logger.append(input, new Date("2026-01-01")); const second = logger.append({ ...input, action: "file.downloaded", outcome: "failure" }, new Date("2026-01-02"));
    expect(first.previousHash).toHaveLength(64); expect(second.previousHash).toBe(first.hash);
    expect(first.details?.token).toBe("[REDACTED]"); expect(logger.verify()).toBe(true);
    const tampered = logger.search({ tenantId: "t" }); tampered[0]!.resourceId = "changed";
    expect(logger.verify(tampered)).toBe(false);
    expect(logger.search({ tenantId: "t", actorId: "user", action: "file.uploaded", from: new Date("2025-01-01"), to: new Date("2027-01-01"), text: "download" })).toEqual([]);
    expect(logger.search({ tenantId: "t", text: "file.uploaded", limit: 1 })).toHaveLength(1);
    expect(logger.search({ tenantId: "other" })).toEqual([]);
  });
  it("exports JSONL, CEF and immutable retention archives", () => {
    const logger = new AuditLogger("audit-signing-secret"); logger.append(input, new Date("2025-01-01")); logger.append(input, new Date("2026-01-01"));
    const archive = logger.exportArchive(new Date("2026-01-01"));
    expect(archive.records).toHaveLength(1); expect(archive.merkleRoot).toHaveLength(64);
    expect(exportAuditJson(archive.records)).toContain("file.uploaded\n");
    expect(exportAuditCef(logger.search({ tenantId: "t" }))).toContain("CEF:0|FileExpress");
    expect(exportAuditCef(logger.search({ tenantId: "t" }))).toContain("f\\=1");
    expect(() => logger.purgeBefore(new Date("2026-01-01"))).toThrow("append-only");
    expect(logger.purgeBefore(new Date("2020-01-01")).removed).toBe(0);
    expect(exportAuditJson([])).toBe(""); expect(exportAuditCef([])).toBe("");
    expect(() => new AuditLogger("short")).toThrow("too short");
  });
});
