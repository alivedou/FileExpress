import { describe, expect, it } from "vitest";
import { ApiKeyService } from "../../../src/auth/api-key";
import { PERMISSIONS, RbacService, type Principal } from "../../../src/auth/rbac";
import { TeamService } from "../../../src/auth/team";

describe("RBAC and API keys", () => {
  const principal: Principal = { userId: "u", tenantId: "t", roles: ["Member"], projectId: "p", bucket: "b" };
  it("checks tenant, project, bucket, time and custom role scopes", () => {
    const rbac = new RbacService();
    expect(rbac.can(principal, "storage.write", { tenantId: "t" })).toBe(true);
    expect(rbac.can(principal, "audit.read", { tenantId: "t" })).toBe(false);
    expect(rbac.can(principal, "storage.read", { tenantId: "other" })).toBe(false);
    expect(rbac.can(principal, "storage.read", { tenantId: "t", projectId: "other" })).toBe(false);
    expect(rbac.can(principal, "storage.read", { tenantId: "t", bucket: "other" })).toBe(false);
    expect(
      rbac.can(principal, "storage.read", { tenantId: "t", notBefore: "2027-01-01" }, new Date("2026-01-01")),
    ).toBe(false);
    expect(
      rbac.can(principal, "storage.read", { tenantId: "t", expiresAt: "2026-01-01" }, new Date("2026-01-01")),
    ).toBe(false);
    rbac.defineRole({ name: "Auditor", permissions: ["audit.read", "audit.read"] });
    expect(rbac.permissions("Auditor")).toEqual(["audit.read"]);
    expect(() => rbac.assert(principal, "audit.read", { tenantId: "t" })).toThrow("Permission denied");
    expect(rbac.removeRole("Auditor")).toBe(true);
    expect(rbac.permissions("Auditor")).toEqual([]);
    expect(() => rbac.defineRole({ name: "bad role", permissions: ["audit.read"] })).toThrow("Invalid role");
    expect(PERMISSIONS).toHaveLength(8);
  });
  it("issues only hashed keys and enforces scope, expiry and rate limits", () => {
    const service = new ApiKeyService();
    const scope = {
      tenantId: "t",
      projectId: "p",
      bucket: "b",
      permissions: ["storage.read" as const],
      requestsPerMinute: 1,
      expiresAt: "2027-01-01",
    };
    const issued = service.issue("reader", scope, new Date("2026-01-01"));
    expect(issued.secret).not.toBe(issued.record.hash);
    expect(issued.record.hash).toHaveLength(64);
    expect(
      service.authenticate(
        issued.secret,
        "storage.read",
        { tenantId: "t", projectId: "p", bucket: "b" },
        new Date("2026-06-01"),
      ).name,
    ).toBe("reader");
    expect(() =>
      service.authenticate(
        issued.secret,
        "storage.read",
        { tenantId: "t", projectId: "p", bucket: "b" },
        new Date("2026-06-01"),
      ),
    ).toThrow("rate limit");
    expect(() =>
      service.authenticate(
        issued.secret,
        "storage.write",
        { tenantId: "t", projectId: "p", bucket: "b" },
        new Date("2026-06-02"),
      ),
    ).toThrow("scope");
    expect(() =>
      service.authenticate(
        issued.secret,
        "storage.read",
        { tenantId: "other", projectId: "p", bucket: "b" },
        new Date("2026-06-02"),
      ),
    ).toThrow("scope");
    expect(service.list("t")).toHaveLength(1);
    expect(service.revoke(issued.record.id)).toBe(true);
    expect(() =>
      service.authenticate(
        issued.secret,
        "storage.read",
        { tenantId: "t", projectId: "p", bucket: "b" },
        new Date("2026-06-03"),
      ),
    ).toThrow("revoked");
    expect(() => service.issue("bad", { ...scope, permissions: [] })).toThrow("Invalid API key scope");
  });
});

describe("teams", () => {
  function serviceWithTree(): TeamService {
    const service = new TeamService();
    service.create({
      id: "root",
      name: "Root",
      quotaBytes: 1000,
      domain: "Files.Example.COM.",
      branding: { name: "Root", color: "#fff" },
    });
    service.create({
      id: "child",
      name: "Child",
      parentId: "root",
      quotaBytes: 500,
      branding: { name: "Child", color: "#000" },
    });
    return service;
  }
  it("maintains hierarchy, domains, membership and inherited quota", () => {
    const service = serviceWithTree();
    expect(service.byDomain("files.example.com")?.id).toBe("root");
    service.addMember({ teamId: "child", userId: "u", roles: ["Member"] });
    service.addMember({ teamId: "child", userId: "u", roles: ["Viewer", "Viewer"] });
    expect(service.membersOf("child")[0]?.roles).toEqual(["Viewer"]);
    service.consumeQuota("child", 400);
    expect(service.effectiveQuota("child")).toBe(100);
    expect(() => service.consumeQuota("child", 200)).toThrow("quota exceeded");
    expect(service.tree("root").children[0]?.team.id).toBe("child");
    service.move("root", undefined);
    expect(() => service.move("root", "child")).toThrow("cycle");
    expect(() =>
      service.create({
        id: "bad",
        name: "Bad",
        quotaBytes: 100,
        domain: "localhost",
        branding: { name: "b", color: "x" },
      }),
    ).toThrow("Invalid custom domain");
    expect(() =>
      service.create({ id: "root", name: "Root", quotaBytes: 1, branding: { name: "r", color: "x" } }),
    ).toThrow("already exists");
    expect(() =>
      service.create({
        id: "over",
        name: "Over",
        parentId: "root",
        quotaBytes: 10000,
        branding: { name: "o", color: "x" },
      }),
    ).toThrow("exceeds inherited");
  });
});
