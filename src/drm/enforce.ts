import { createHmac } from "node:crypto";
import { evaluatePolicy, type AccessContext, type DrmPolicy } from "./policy";

export class DrmDeniedError extends Error {
  constructor(readonly reason: string, readonly destruct: boolean) { super(`DRM access denied: ${reason}`); this.name = "DrmDeniedError"; }
}

export class DrmEnforcer {
  private readonly policies = new Map<string, DrmPolicy>();
  bind(policy: DrmPolicy): void { this.policies.set(policy.id, { ...policy, allowedActions: [...policy.allowedActions], allowedIps: [...policy.allowedIps], allowedDevices: [...policy.allowedDevices], mimePatterns: [...policy.mimePatterns], userIds: [...policy.userIds] }); }
  unbind(policyId: string): boolean { return this.policies.delete(policyId); }
  assert(policyId: string, context: AccessContext): DrmPolicy {
    const policy = this.policies.get(policyId);
    if (!policy) throw new DrmDeniedError("Policy not found", false);
    const decision = evaluatePolicy(policy, context);
    if (!decision.allowed) throw new DrmDeniedError(decision.reason, decision.destruct);
    return policy;
  }
}

export function bindDevice(userId: string, deviceFingerprint: string, secret: string): string {
  if (!/^[a-zA-Z0-9._:-]{8,256}$/.test(deviceFingerprint)) throw new Error("Invalid device fingerprint");
  return createHmac("sha256", secret).update(`${userId}:${deviceFingerprint}`).digest("base64url");
}

export function selfDestructDecision(policy: DrmPolicy, now = new Date()): boolean {
  return policy.destructAfterExpiry && ((policy.expiresAt !== undefined && new Date(policy.expiresAt) <= now) || policy.maxViews === 0);
}
