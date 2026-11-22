import { createHmac, timingSafeEqual } from "node:crypto";

export type DeviceProofDate = string | number | Date;

export interface DeviceProof {
  userId: string;
  deviceId: string;
  issuedAt: DeviceProofDate;
  expiresAt: DeviceProofDate;
  signature: string;
}

export type DeviceProofInput = DeviceProof | string;

export interface CreateDeviceProofOptions {
  now?: Date;
  ttlMs?: number;
  expiresAt?: DeviceProofDate;
}

const DEFAULT_PROOF_TTL_MS = 5 * 60_000;
const MAX_PROOF_TTL_MS = 30 * 24 * 60 * 60_000;
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,256}$/;
const BINDING_PATTERN = /^[a-zA-Z0-9._:-]{8,256}$/;
const SIGNATURE_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

export function bindDevice(userId: string, deviceFingerprint: string, secret: string): string {
  validateUserId(userId);
  if (!BINDING_PATTERN.test(deviceFingerprint)) throw new Error("Invalid device fingerprint");
  validateSecret(secret);
  return createHmac("sha256", secret)
    .update(JSON.stringify([userId, deviceFingerprint]))
    .digest("base64url");
}

export function verifyDeviceBinding(
  userId: string,
  deviceFingerprint: string,
  binding: string,
  secret: string,
): boolean {
  try {
    const expected = bindDevice(userId, deviceFingerprint, secret);
    return equalSignature(binding, expected);
  } catch {
    return false;
  }
}

export function createDeviceProof(
  userId: string,
  deviceId: string,
  secret: string,
  options: CreateDeviceProofOptions = {},
): DeviceProof {
  validateUserId(userId);
  validateDeviceId(deviceId);
  validateSecret(secret);
  const now = options.now === undefined ? new Date() : options.now;
  const issuedAt = validDate(now);
  if (!issuedAt) throw new Error("Invalid device proof issuance time");
  const expiresAt =
    options.expiresAt === undefined
      ? new Date(issuedAt.getTime() + validateTtl(options.ttlMs ?? DEFAULT_PROOF_TTL_MS))
      : validDate(options.expiresAt);
  if (!expiresAt || expiresAt.getTime() <= issuedAt.getTime()) throw new Error("Invalid device proof expiry");
  if (expiresAt.getTime() - issuedAt.getTime() > MAX_PROOF_TTL_MS)
    throw new Error("Device proof lifetime is too long");
  const issuedText = issuedAt.toISOString();
  const expiryText = expiresAt.toISOString();
  return {
    userId,
    deviceId,
    issuedAt: issuedText,
    expiresAt: expiryText,
    signature: signProof(userId, deviceId, issuedText, expiryText, secret),
  };
}

export function createDeviceProofToken(
  userId: string,
  deviceId: string,
  secret: string,
  options: CreateDeviceProofOptions = {},
): string {
  const proof = createDeviceProof(userId, deviceId, secret, options);
  const body = Buffer.from(
    JSON.stringify({
      userId: proof.userId,
      deviceId: proof.deviceId,
      issuedAt: proof.issuedAt,
      expiresAt: proof.expiresAt,
    }),
    "utf8",
  ).toString("base64url");
  return `v1.${body}.${proof.signature}`;
}

export function verifyDeviceProof(
  proof: DeviceProofInput,
  userId: string,
  deviceId: string,
  secret: string,
  now = new Date(),
  maxAgeMs?: number,
): boolean {
  try {
    validateUserId(userId);
    validateDeviceId(deviceId);
    validateSecret(secret);
    const current = validDate(now);
    if (
      !current ||
      (maxAgeMs !== undefined &&
        (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > MAX_PROOF_TTL_MS))
    )
      return false;
    const decoded = typeof proof === "string" ? decodeProofToken(proof) : proof;
    if (!isDeviceProof(decoded)) return false;
    if (decoded.userId !== userId || decoded.deviceId !== deviceId) return false;
    const issuedAt = validDate(decoded.issuedAt);
    const expiresAt = validDate(decoded.expiresAt);
    if (!issuedAt || !expiresAt || issuedAt.getTime() >= expiresAt.getTime()) return false;
    if (issuedAt.getTime() > current.getTime() + 60_000 || expiresAt.getTime() <= current.getTime())
      return false;
    if (maxAgeMs !== undefined && current.getTime() - issuedAt.getTime() > maxAgeMs) return false;
    const expected = signProof(
      decoded.userId,
      decoded.deviceId,
      issuedAt.toISOString(),
      expiresAt.toISOString(),
      secret,
    );
    return equalSignature(decoded.signature, expected);
  } catch {
    return false;
  }
}

export const validateDeviceProof = verifyDeviceProof;

function signProof(
  userId: string,
  deviceId: string,
  issuedAt: string,
  expiresAt: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify([userId, deviceId, issuedAt, expiresAt]))
    .digest("base64url");
}

function decodeProofToken(token: string): DeviceProof | undefined {
  if (token.length > 4096) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return undefined;
  const encodedBody = parts[1];
  const signature = parts[2];
  if (
    !encodedBody ||
    !signature ||
    !/^[a-zA-Z0-9_-]+$/.test(encodedBody) ||
    !SIGNATURE_PATTERN.test(signature)
  )
    return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed.userId !== "string" ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.issuedAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    )
      return undefined;
    return {
      userId: parsed.userId,
      deviceId: parsed.deviceId,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
      signature,
    };
  } catch {
    return undefined;
  }
}

function isDeviceProof(value: unknown): value is DeviceProof {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.deviceId === "string" &&
    typeof value.signature === "string" &&
    (typeof value.issuedAt === "string" ||
      typeof value.issuedAt === "number" ||
      value.issuedAt instanceof Date) &&
    (typeof value.expiresAt === "string" ||
      typeof value.expiresAt === "number" ||
      value.expiresAt instanceof Date)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function equalSignature(actual: string, expected: string): boolean {
  if (!SIGNATURE_PATTERN.test(actual) || !SIGNATURE_PATTERN.test(expected)) return false;
  const left = Buffer.from(actual, "base64url");
  const right = Buffer.from(expected, "base64url");
  return left.length === right.length && timingSafeEqual(left, right);
}

function validDate(value: DeviceProofDate): Date | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && (value.length === 0 || value.length > 128)) return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function validateTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROOF_TTL_MS)
    throw new Error("Invalid device proof lifetime");
  return value;
}

function validateSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 512)
    throw new Error("Invalid device proof secret");
}

function validateUserId(userId: string): void {
  if (
    typeof userId !== "string" ||
    userId.length === 0 ||
    userId.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(userId)
  )
    throw new Error("Invalid user identifier");
}

function validateDeviceId(deviceId: string): void {
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId))
    throw new Error("Invalid device identifier");
}
