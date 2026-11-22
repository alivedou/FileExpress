import { describe, expect, it } from "vitest";
import { bindDevice, DrmDeniedError, DrmEnforcer, selfDestructDecision } from "../../../src/drm/enforce";
import { DEFAULT_POLICY, evaluatePolicy, ipMatches, type DrmPolicy } from "../../../src/drm/policy";
import { createWatermarkPayload, embedInvisibleWatermark, extractInvisibleWatermark, visibleWatermarkSvg } from "../../../src/drm/watermark";

const policy: DrmPolicy = { id: "p", tenantId: "t", name: "restricted", ...DEFAULT_POLICY, allowedActions: ["view", "print"], allowedIps: ["10.0.0.0/8"], allowedDevices: ["device"], maxViews: 2, expiresAt: "2027-01-01T00:00:00Z" };
const context = { userId: "u", action: "view" as const, ip: "10.1.2.3", deviceId: "device", mimeType: "image/png", viewCount: 0, now: new Date("2026-01-01") };

describe("DRM policies", () => {
  it("enforces actions, users, MIME, IP, device, views and expiry", () => {
    expect(evaluatePolicy(policy, context)).toEqual({ allowed: true, reason: "Allowed", destruct: false });
    expect(evaluatePolicy(policy, { ...context, action: "download" }).reason).toContain("denied");
    expect(evaluatePolicy({ ...policy, userIds: ["other"] }, context).reason).toContain("User");
    expect(evaluatePolicy(policy, { ...context, mimeType: "application/pdf" }).allowed).toBe(true);
    expect(evaluatePolicy({ ...policy, mimePatterns: ["^image/"] }, { ...context, mimeType: "text/plain" }).reason).toContain("MIME");
    expect(evaluatePolicy(policy, { ...context, ip: "192.168.1.1" }).reason).toContain("IP");
    expect(evaluatePolicy(policy, { ...context, deviceId: undefined }).reason).toContain("Device");
    expect(evaluatePolicy(policy, { ...context, viewCount: 2 })).toMatchObject({ allowed: false, destruct: true });
    expect(evaluatePolicy(policy, { ...context, now: new Date("2028-01-01") })).toMatchObject({ reason: "Policy expired", destruct: true });
    expect(ipMatches("10.2.3.4", "10.0.0.0/8")).toBe(true);
    expect(ipMatches("11.2.3.4", "10.0.0.0/8")).toBe(false);
    expect(ipMatches("anything", "*")).toBe(true);
    expect(ipMatches("::1", "::1/128")).toBe(false);
    expect(ipMatches("999.1.1.1", "0.0.0.0/0")).toBe(false);
  });
  it("binds devices and raises typed denial errors", () => {
    const enforcer = new DrmEnforcer(); enforcer.bind(policy);
    expect(enforcer.assert("p", context)).toMatchObject({ id: "p" });
    expect(() => enforcer.assert("p", { ...context, action: "download" })).toThrow(DrmDeniedError);
    expect(() => enforcer.assert("missing", context)).toThrow("Policy not found");
    expect(enforcer.unbind("p")).toBe(true);
    expect(bindDevice("user", "device-1234", "secret")).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(() => bindDevice("user", "bad", "secret")).toThrow("Invalid device");
    expect(selfDestructDecision(policy, new Date("2028-01-01"))).toBe(true);
    expect(selfDestructDecision({ ...policy, maxViews: 0 })).toBe(true);
  });
});

describe("watermarks", () => {
  it("creates salted payloads and escapes visible SVG overlays", () => {
    const payload = createWatermarkPayload({ userId: "<user>", timestamp: "2026", email: "a&b@test", pickupCode: "123" });
    expect(payload.salt).toHaveLength(32);
    const svg = visibleWatermarkSvg(800, 600, payload, "high");
    expect(svg.match(/<text/g)).toHaveLength(8);
    expect(svg).toContain("&lt;user&gt;");
    expect(svg).toContain("a&amp;b@test");
    expect(visibleWatermarkSvg(100, 100, payload, "low").match(/<text/g)).toHaveLength(2);
  });
  it("round-trips signed bits in a redundant DCT watermark", () => {
    const width = 384, height = 384;
    const data = new Uint8Array(width * height * 3);
    for (let index = 0; index < data.length; index += 3) { data[index] = index % 251; data[index + 1] = 120; data[index + 2] = 180; }
    const payload = { userId: "u", timestamp: "t", salt: "s" };
    const marked = embedInvisibleWatermark({ width, height, channels: 3, data }, payload, "secret", 30);
    expect(marked.data).not.toBe(data);
    expect(extractInvisibleWatermark(marked, payload, "secret")).toBe(true);
    expect(extractInvisibleWatermark(marked, { ...payload, userId: "attacker" }, "secret")).toBe(false);
    expect(() => embedInvisibleWatermark({ width: 8, height: 8, channels: 1, data: new Uint8Array(64) }, payload, "secret")).toThrow("too small");
    expect(() => embedInvisibleWatermark({ width: 8, height: 8, channels: 1, data: new Uint8Array(1) }, payload, "secret")).toThrow("dimensions");
  }, 60_000);
});
