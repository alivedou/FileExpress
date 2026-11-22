import {
  evaluatePolicy,
  type AccessContext,
  type AccessDecision,
  type DrmPolicy,
  type PolicyEvaluationOptions,
} from "./policy";

export {
  bindDevice,
  createDeviceProof,
  createDeviceProofToken,
  validateDeviceProof,
  verifyDeviceBinding,
  verifyDeviceProof,
} from "./device";
export type { CreateDeviceProofOptions, DeviceProof, DeviceProofDate, DeviceProofInput } from "./device";

export class DrmDeniedError extends Error {
  constructor(
    readonly reason: string,
    readonly destruct: boolean,
  ) {
    super(`DRM access denied: ${reason}`);
    this.name = "DrmDeniedError";
  }
}

export interface DrmEnforcerOptions extends PolicyEvaluationOptions {
  onDestruct?: (policy: DrmPolicy, context: AccessContext, reason: string) => void;
}

export interface DestructionDecision {
  destruct: boolean;
  reason: string;
}

export class DrmEnforcer {
  private readonly policies = new Map<string, DrmPolicy>();
  private readonly viewCounts = new Map<string, Map<string, number>>();
  private readonly options: DrmEnforcerOptions;

  constructor(options: DrmEnforcerOptions = {}) {
    this.options = { ...options };
  }

  bind(policy: DrmPolicy): void {
    if (!policy || typeof policy.id !== "string" || policy.id.length === 0) throw new Error("Invalid policy");
    const snapshot = clonePolicy(policy);
    if (
      !Array.isArray(snapshot.allowedActions) ||
      !Array.isArray(snapshot.allowedIps) ||
      !Array.isArray(snapshot.allowedDevices) ||
      !Array.isArray(snapshot.mimePatterns) ||
      !Array.isArray(snapshot.userIds)
    )
      throw new Error("Invalid policy arrays");
    freezePolicy(snapshot);
    this.policies.set(snapshot.id, snapshot);
  }

  unbind(policyId: string): boolean {
    this.viewCounts.delete(policyId);
    return this.policies.delete(policyId);
  }

  list(tenantId?: string): DrmPolicy[] {
    return [...this.policies.values()]
      .filter((policy) => !tenantId || policy.tenantId === tenantId)
      .map(clonePolicy);
  }

  assert(policyId: string, context: AccessContext): DrmPolicy {
    const policy = this.policies.get(policyId);
    if (!policy) throw new DrmDeniedError("Policy not found", false);
    const decision = evaluatePolicy(policy, context, this.options);
    if (!decision.allowed) {
      this.notifyDestruction(policy, context, decision);
      throw new DrmDeniedError(decision.reason, decision.destruct);
    }
    return clonePolicy(policy);
  }

  authorizeAndConsume(policyId: string, context: AccessContext): DrmPolicy {
    const policy = this.policies.get(policyId);
    if (!policy) throw new DrmDeniedError("Policy not found", false);
    let key: string;
    let previous: number;
    let effectiveContext: AccessContext;
    try {
      if (
        !Number.isSafeInteger(context.viewCount) ||
        context.viewCount < 0 ||
        context.viewCount > 1_000_000_000
      )
        throw new Error("Invalid view count");
      key = viewKey(context);
      previous = this.viewCounts.get(policyId)?.get(key) ?? 0;
      effectiveContext = { ...context, viewCount: Math.max(context.viewCount, previous) };
    } catch {
      throw new DrmDeniedError("Invalid access context", false);
    }
    const decision = evaluatePolicy(policy, effectiveContext, this.options);
    if (!decision.allowed) {
      this.notifyDestruction(policy, effectiveContext, decision);
      throw new DrmDeniedError(decision.reason, decision.destruct);
    }
    if (context.action === "view") {
      const next = Math.max(previous, effectiveContext.viewCount) + 1;
      let counts = this.viewCounts.get(policyId);
      if (!counts) {
        counts = new Map<string, number>();
        this.viewCounts.set(policyId, counts);
      }
      counts.set(key, next);
    }
    return clonePolicy(policy);
  }

  consumeView(policyId: string, context: AccessContext): DrmPolicy {
    return this.authorizeAndConsume(policyId, context);
  }

  assertAndConsume(policyId: string, context: AccessContext): DrmPolicy {
    return this.authorizeAndConsume(policyId, context);
  }

  getConsumedViews(
    policyId: string,
    context: Pick<AccessContext, "userId" | "deviceId" | "projectId" | "tenantId">,
  ): number {
    try {
      return this.viewCounts.get(policyId)?.get(viewKey(context)) ?? 0;
    } catch {
      return 0;
    }
  }

  private notifyDestruction(policy: DrmPolicy, context: AccessContext, decision: AccessDecision): void {
    if (!decision.destruct || !this.options.onDestruct) return;
    try {
      this.options.onDestruct(clonePolicy(policy), { ...context }, decision.reason);
    } catch {
      return;
    }
  }
}

export function destructionDecision(policy: DrmPolicy, now = new Date()): DestructionDecision {
  const enabled = policy?.destructAfterExpiry === true;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    return { destruct: enabled, reason: "Invalid current time" };
  if (policy.expiresAt !== undefined) {
    if (
      typeof policy.expiresAt !== "string" ||
      policy.expiresAt.length === 0 ||
      policy.expiresAt.length > 128
    )
      return { destruct: enabled, reason: "Invalid policy expiry" };
    const expiry = new Date(policy.expiresAt).getTime();
    if (!Number.isFinite(expiry)) return { destruct: enabled, reason: "Invalid policy expiry" };
    if (expiry <= now.getTime()) return { destruct: enabled, reason: "Policy expired" };
  }
  if (
    policy.maxViews !== undefined &&
    (!Number.isSafeInteger(policy.maxViews) || policy.maxViews < 0 || policy.maxViews > 1_000_000_000)
  )
    return { destruct: enabled, reason: "Invalid view limit" };
  if (policy.maxViews === 0) return { destruct: enabled, reason: "View limit reached" };
  return { destruct: false, reason: "No self-destruction required" };
}

export function selfDestructDecision(policy: DrmPolicy, now = new Date()): boolean {
  return destructionDecision(policy, now).destruct;
}

function clonePolicy(policy: DrmPolicy): DrmPolicy {
  return {
    ...policy,
    allowedActions: [...policy.allowedActions],
    allowedIps: [...policy.allowedIps],
    allowedDevices: [...policy.allowedDevices],
    mimePatterns: [...policy.mimePatterns],
    userIds: [...policy.userIds],
    projectIds: policy.projectIds === undefined ? undefined : [...policy.projectIds],
  };
}

function freezePolicy(policy: DrmPolicy): void {
  Object.freeze(policy.allowedActions);
  Object.freeze(policy.allowedIps);
  Object.freeze(policy.allowedDevices);
  Object.freeze(policy.mimePatterns);
  Object.freeze(policy.userIds);
  if (policy.projectIds) Object.freeze(policy.projectIds);
  Object.freeze(policy);
}

function viewKey(context: Pick<AccessContext, "userId" | "projectId" | "tenantId">): string {
  return JSON.stringify([context.userId, context.projectId ?? "", context.tenantId ?? ""]);
}
