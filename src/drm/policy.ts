import { isIP } from "node:net";
import { verifyDeviceProof, type DeviceProofInput } from "./device";

export type DrmAction = "view" | "download" | "print" | "screenshot";

export interface DrmPolicy {
  id: string;
  tenantId: string;
  name: string;
  allowedActions: DrmAction[];
  visibleWatermark: boolean;
  invisibleWatermark: boolean;
  watermarkDensity: "low" | "medium" | "high";
  allowedIps: string[];
  allowedDevices: string[];
  expiresAt?: string;
  maxViews?: number;
  destructAfterExpiry: boolean;
  mimePatterns: string[];
  userIds: string[];
  projectIds?: string[];
  requireTenantContext?: boolean;
  requireDeviceProof?: boolean;
  deviceProofRequired?: boolean;
  deviceProofSecret?: string;
  deviceProofMaxAgeMs?: number;
}

export interface AccessContext {
  userId: string;
  action: DrmAction;
  ip: string;
  deviceId?: string;
  mimeType: string;
  viewCount: number;
  now?: Date;
  projectId?: string;
  tenantId?: string;
  deviceProof?: DeviceProofInput;
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
  destruct: boolean;
}

export interface PolicyEvaluationOptions {
  requireTenantContext?: boolean;
  deviceProofSecret?: string;
  requireDeviceProof?: boolean;
  deviceProofMaxAgeMs?: number;
}

export const DEFAULT_POLICY: Omit<DrmPolicy, "id" | "tenantId" | "name"> = {
  allowedActions: ["view"],
  visibleWatermark: true,
  invisibleWatermark: true,
  watermarkDensity: "medium",
  allowedIps: [],
  allowedDevices: [],
  destructAfterExpiry: true,
  mimePatterns: [".*"],
  userIds: [],
};

const ACTIONS: readonly DrmAction[] = ["view", "download", "print", "screenshot"];
const MIME_PATTERN = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function evaluatePolicy(
  policy: DrmPolicy,
  context: AccessContext,
  options: PolicyEvaluationOptions = {},
): AccessDecision {
  let destruct = false;
  try {
    if (!policy || !context || typeof policy !== "object" || typeof context !== "object")
      return deny("Invalid policy or access context", false);
    destruct = policy.destructAfterExpiry === true;
    if (
      !validIdentifier(policy.id) ||
      !validIdentifier(policy.tenantId) ||
      typeof policy.name !== "string" ||
      policy.name.length > 256 ||
      CONTROL_PATTERN.test(policy.name) ||
      typeof policy.visibleWatermark !== "boolean" ||
      typeof policy.invisibleWatermark !== "boolean" ||
      typeof policy.destructAfterExpiry !== "boolean" ||
      !["low", "medium", "high"].includes(policy.watermarkDensity)
    )
      return deny("Invalid policy", destruct);
    if (
      !validStringArray(policy.allowedActions) ||
      !validStringArray(policy.allowedIps) ||
      !validStringArray(policy.allowedDevices) ||
      !validStringArray(policy.mimePatterns) ||
      !validStringArray(policy.userIds)
    )
      return deny("Invalid policy arrays", destruct);
    if (policy.projectIds !== undefined && !validStringArray(policy.projectIds))
      return deny("Invalid project scope", destruct);
    if (policy.requireTenantContext !== undefined && typeof policy.requireTenantContext !== "boolean")
      return deny("Invalid tenant scope policy", destruct);
    if (options.requireTenantContext !== undefined && typeof options.requireTenantContext !== "boolean")
      return deny("Invalid tenant scope policy", destruct);
    if (policy.requireDeviceProof !== undefined && typeof policy.requireDeviceProof !== "boolean")
      return deny("Invalid device proof policy", destruct);
    if (policy.deviceProofRequired !== undefined && typeof policy.deviceProofRequired !== "boolean")
      return deny("Invalid device proof policy", destruct);
    if (
      policy.deviceProofMaxAgeMs !== undefined &&
      (!Number.isSafeInteger(policy.deviceProofMaxAgeMs) ||
        policy.deviceProofMaxAgeMs <= 0 ||
        policy.deviceProofMaxAgeMs > 30 * 24 * 60 * 60_000)
    )
      return deny("Invalid device proof lifetime", destruct);
    if (options.requireDeviceProof !== undefined && typeof options.requireDeviceProof !== "boolean")
      return deny("Invalid device proof policy", destruct);
    if (
      options.deviceProofMaxAgeMs !== undefined &&
      (!Number.isSafeInteger(options.deviceProofMaxAgeMs) ||
        options.deviceProofMaxAgeMs <= 0 ||
        options.deviceProofMaxAgeMs > 30 * 24 * 60 * 60_000)
    )
      return deny("Invalid device proof lifetime", destruct);
    const now = context.now === undefined ? new Date() : context.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      return deny("Invalid current time", destruct);
    let expiry: number | undefined;
    if (policy.expiresAt !== undefined) {
      if (
        typeof policy.expiresAt !== "string" ||
        policy.expiresAt.length === 0 ||
        policy.expiresAt.length > 128
      )
        return deny("Invalid policy expiry", destruct);
      expiry = new Date(policy.expiresAt).getTime();
      if (!Number.isFinite(expiry)) return deny("Invalid policy expiry", destruct);
    }
    if (expiry !== undefined && expiry <= now.getTime()) return deny("Policy expired", destruct);
    if (
      !ACTIONS.includes(context.action) ||
      !policy.allowedActions.every((action) => ACTIONS.includes(action)) ||
      !policy.allowedActions.includes(context.action)
    )
      return deny(`Action denied: ${String(context.action)}`, destruct);
    if (!validIdentifier(context.userId) || !policy.userIds.every(validIdentifier))
      return deny("Invalid user scope", destruct);
    if (policy.userIds.length > 0 && !policy.userIds.includes(context.userId))
      return deny("User is not bound to policy", destruct);
    if (
      (policy.requireTenantContext === true || options.requireTenantContext === true) &&
      context.tenantId === undefined
    )
      return deny("Tenant context is required", destruct);
    if (
      context.tenantId !== undefined &&
      (!validIdentifier(context.tenantId) || context.tenantId !== policy.tenantId)
    )
      return deny("Tenant is not bound to policy", destruct);
    if (policy.projectIds !== undefined) {
      if (
        !policy.projectIds.every(validIdentifier) ||
        context.projectId === undefined ||
        !validIdentifier(context.projectId) ||
        !policy.projectIds.includes(context.projectId)
      )
        return deny("Project is not bound to policy", destruct);
    }
    if (
      typeof context.mimeType !== "string" ||
      context.mimeType.length > 255 ||
      !MIME_PATTERN.test(context.mimeType)
    )
      return deny("Invalid MIME type", destruct);
    const mimePatterns: RegExp[] = [];
    for (const pattern of policy.mimePatterns) {
      if (
        typeof pattern !== "string" ||
        pattern.length === 0 ||
        pattern.length > 256 ||
        CONTROL_PATTERN.test(pattern) ||
        unsafeRegex(pattern)
      )
        return deny("Invalid MIME pattern", destruct);
      try {
        mimePatterns.push(new RegExp(pattern));
      } catch {
        return deny("Invalid MIME pattern", destruct);
      }
    }
    if (mimePatterns.length === 0 || !mimePatterns.some((pattern) => pattern.test(context.mimeType)))
      return deny("MIME type is outside policy scope", destruct);
    if (typeof context.ip !== "string" || context.ip.length > 128 || isIP(context.ip) === 0)
      return deny("Invalid IP address", destruct);
    if (!policy.allowedIps.every(validIpRule)) return deny("Invalid IP rule", destruct);
    if (policy.allowedIps.length > 0 && !policy.allowedIps.some((cidr) => ipMatches(context.ip, cidr)))
      return deny("IP address is not allowed", destruct);
    if (context.deviceId !== undefined && !validDevice(context.deviceId))
      return deny("Invalid device", destruct);
    if (!policy.allowedDevices.every(validDevice)) return deny("Invalid device policy", destruct);
    if (
      policy.allowedDevices.length > 0 &&
      (!context.deviceId || !policy.allowedDevices.includes(context.deviceId))
    )
      return deny("Device is not bound", destruct);
    const proofRequired =
      policy.requireDeviceProof === true ||
      policy.deviceProofRequired === true ||
      options.requireDeviceProof === true;
    if (proofRequired) {
      const secret = options.deviceProofSecret ?? policy.deviceProofSecret;
      if (!context.deviceId || !context.deviceProof || typeof secret !== "string" || secret.length === 0)
        return deny("Device proof is required", destruct);
      const maxAge = options.deviceProofMaxAgeMs ?? policy.deviceProofMaxAgeMs;
      if (!verifyDeviceProof(context.deviceProof, context.userId, context.deviceId, secret, now, maxAge))
        return deny("Device proof is invalid or expired", destruct);
    }
    if (
      policy.maxViews !== undefined &&
      (!Number.isSafeInteger(policy.maxViews) || policy.maxViews < 0 || policy.maxViews > 1_000_000_000)
    )
      return deny("Invalid view limit", destruct);
    if (
      !Number.isSafeInteger(context.viewCount) ||
      context.viewCount < 0 ||
      context.viewCount > 1_000_000_000
    )
      return deny("Invalid view count", destruct);
    if (policy.maxViews !== undefined && context.viewCount >= policy.maxViews)
      return deny("View limit reached", destruct);
    return { allowed: true, reason: "Allowed", destruct: false };
  } catch {
    return deny("Invalid policy or access context", destruct);
  }
}

export function ipMatches(ip: string, rule: string): boolean {
  if (rule === "*") return true;
  if (typeof ip !== "string" || typeof rule !== "string" || rule.length === 0 || rule.length > 128)
    return false;
  const ruleParts = rule.split("/");
  if (ruleParts.length === 1) {
    if (isIP(ip) === 6 || isIP(rule) === 6) return isIP(ip) === 6 && isIP(rule) === 6 && ip === rule;
    const address = ipv4Number(ip);
    const exact = ipv4Number(rule);
    return address !== undefined && exact !== undefined && address === exact;
  }
  if (ruleParts.length !== 2) return false;
  const network = ruleParts[0];
  const bitsText = ruleParts[1];
  if (!network || !bitsText || !/^(?:0|[1-9][0-9]*)$/.test(bitsText)) return false;
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const address = ipv4Number(ip);
  const base = ipv4Number(network);
  if (address === undefined || base === undefined) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function deny(reason: string, destruct: boolean): AccessDecision {
  return { allowed: false, reason, destruct };
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !CONTROL_PATTERN.test(value);
}

function validDevice(value: unknown): value is string {
  return validIdentifier(value) && value.length <= 256;
}

function validStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 4096 &&
    Array.from(value).every((item) => typeof item === "string")
  );
}

function validIpRule(rule: string): boolean {
  if (rule === "*") return true;
  if (rule.length === 0 || rule.length > 128 || CONTROL_PATTERN.test(rule)) return false;
  const parts = rule.split("/");
  if (parts.length === 1) return ipv4Number(rule) !== undefined || isIP(rule) === 6;
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^(?:0|[1-9][0-9]*)$/.test(parts[1])) return false;
  const bits = Number(parts[1]);
  return Number.isInteger(bits) && bits >= 0 && bits <= 32 && ipv4Number(parts[0]) !== undefined;
}

function unsafeRegex(pattern: string): boolean {
  return (
    /\([^)]*(?:\*|\+|\{\d+,?\d*\})[^)]*\)(?:\*|\+|\{)/.test(pattern) || /(?:\.\*|\.\+){2,}/.test(pattern)
  );
}

function ipv4Number(ip: string): number | undefined {
  if (ip.length > 15) return undefined;
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return undefined;
  const bytes = parts.map(Number);
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return bytes.reduce((value, part) => (value * 256 + part) >>> 0, 0);
}
