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
}
export interface AccessContext { userId: string; action: DrmAction; ip: string; deviceId?: string; mimeType: string; viewCount: number; now?: Date }
export interface AccessDecision { allowed: boolean; reason: string; destruct: boolean }

export const DEFAULT_POLICY: Omit<DrmPolicy, "id" | "tenantId" | "name"> = { allowedActions: ["view"], visibleWatermark: true, invisibleWatermark: true, watermarkDensity: "medium", allowedIps: [], allowedDevices: [], destructAfterExpiry: true, mimePatterns: [".*"], userIds: [] };

export function evaluatePolicy(policy: DrmPolicy, context: AccessContext): AccessDecision {
  const now = context.now ?? new Date();
  const expired = policy.expiresAt !== undefined && new Date(policy.expiresAt).getTime() <= now.getTime();
  if (expired) return { allowed: false, reason: "Policy expired", destruct: policy.destructAfterExpiry };
  if (!policy.allowedActions.includes(context.action)) return { allowed: false, reason: `Action denied: ${context.action}`, destruct: false };
  if (policy.userIds.length && !policy.userIds.includes(context.userId)) return { allowed: false, reason: "User is not bound to policy", destruct: false };
  if (!policy.mimePatterns.some((pattern) => new RegExp(pattern).test(context.mimeType))) return { allowed: false, reason: "MIME type is outside policy scope", destruct: false };
  if (policy.allowedIps.length && !policy.allowedIps.some((cidr) => ipMatches(context.ip, cidr))) return { allowed: false, reason: "IP address is not allowed", destruct: false };
  if (policy.allowedDevices.length && (!context.deviceId || !policy.allowedDevices.includes(context.deviceId))) return { allowed: false, reason: "Device is not bound", destruct: false };
  if (policy.maxViews !== undefined && context.viewCount >= policy.maxViews) return { allowed: false, reason: "View limit reached", destruct: policy.destructAfterExpiry };
  return { allowed: true, reason: "Allowed", destruct: false };
}

export function ipMatches(ip: string, rule: string): boolean {
  if (rule === "*") return true;
  if (!rule.includes("/")) return ip === rule;
  const [network, bitsText] = rule.split("/");
  const bits = Number(bitsText);
  if (!network || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const address = ipv4Number(ip);
  const base = ipv4Number(network);
  if (address === undefined || base === undefined) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}
function ipv4Number(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map(Number);
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return bytes.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}
