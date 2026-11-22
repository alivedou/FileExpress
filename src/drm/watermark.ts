import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface RawImage {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array;
}
export interface WatermarkPayload {
  userId: string;
  timestamp: string;
  salt?: string;
  email?: string;
  pickupCode?: string;
}

export interface WatermarkExtractionResult {
  valid: boolean;
  confidence: number;
  payload: WatermarkPayload | null;
  reason: string;
}

const MAGIC = "DRMW";
const VERSION = 1;
const HEADER_BYTES = 8;
const SIGNATURE_BYTES = 16;
const MAX_PAYLOAD_BYTES = 2048;
const MAX_FIELD_BYTES = 512;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MIN_STRENGTH = 8;
const MAX_STRENGTH = 96;
const MIN_REPETITION = 3;
const MAX_REPETITION = 16;
const ABSENT_FIELD = 0xffff;
const PAIRS: readonly (readonly [number, number])[] = [
  [19, 26],
  [20, 27],
];
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DCT_MATRIX: readonly (readonly number[])[] = Array.from({ length: 8 }, (_, frequency) =>
  Array.from(
    { length: 8 },
    (_, position) =>
      ((frequency === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * position + 1) * frequency * Math.PI) / 16)) / 2,
  ),
);

export function createWatermarkPayload(input: Omit<WatermarkPayload, "salt">): Required<WatermarkPayload> {
  return {
    ...input,
    salt: randomBytes(16).toString("hex"),
    email: input.email ?? "",
    pickupCode: input.pickupCode ?? "",
  };
}

export function embedInvisibleWatermark(
  image: RawImage,
  payload: WatermarkPayload,
  secret: string,
  strength = 28,
): RawImage {
  validateImage(image);
  validateSecret(secret);
  if (!Number.isFinite(strength) || strength < MIN_STRENGTH || strength > MAX_STRENGTH)
    throw new Error("Watermark strength is outside the allowed range");
  const body = serializePayload(payload);
  const frame = createFrame(body, secret);
  const bits = bytesToBits(frame);
  const output: RawImage = { ...image, data: new Uint8Array(image.data) };
  const planes = blocksPerPlane(image);
  const blockCount = planes.x * planes.y;
  const slotCount = blockCount * PAIRS.length;
  const repetition = Math.min(MAX_REPETITION, Math.floor(slotCount / bits.length));
  if (repetition < MIN_REPETITION) throw new Error("Image is too small for a redundant watermark");
  const permutation = blockPermutation(blockCount, secret, image.width, image.height);
  const usedSlots = bits.length * repetition;
  const usedBlocks = Math.ceil(usedSlots / PAIRS.length);
  for (let orderIndex = 0; orderIndex < usedBlocks; orderIndex += 1) {
    const blockIndex = permutation[orderIndex];
    if (blockIndex === undefined) break;
    const bx = (blockIndex % planes.x) * 8;
    const by = Math.floor(blockIndex / planes.x) * 8;
    const coefficients = dct(readBlock(output, bx, by));
    for (let pairIndex = 0; pairIndex < PAIRS.length; pairIndex += 1) {
      const position = orderIndex * PAIRS.length + pairIndex;
      if (position >= usedSlots) break;
      const bitIndex = Math.floor(position / repetition);
      const pair = PAIRS[pairIndex];
      const bit = bits[bitIndex];
      if (!pair || bit === undefined) continue;
      embedRelation(coefficients, pair, bit, strength);
    }
    writeBlock(output, bx, by, idct(coefficients));
  }
  return output;
}

export function extractInvisibleWatermark(
  image: RawImage,
  payload: WatermarkPayload,
  secret: string,
): boolean {
  try {
    const extracted = extractWatermark(image, secret);
    if (!extracted.valid || !extracted.payload) return false;
    const expected = serializePayload(payload);
    const actual = serializePayload(extracted.payload);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function extractWatermark(image: RawImage, secret: string): WatermarkExtractionResult {
  try {
    validateImage(image);
    validateSecret(secret);
    const samples = readSamples(image, secret);
    const headerBits = HEADER_BYTES * 8;
    const maximumRepetition = Math.min(MAX_REPETITION, Math.floor(samples.length / headerBits));
    let bestConfidence = 0;
    let foundFrame = false;
    for (let repetition = MIN_REPETITION; repetition <= maximumRepetition; repetition += 1) {
      const header = decodeBits(samples, headerBits, repetition);
      const headerBytes = bitsToBytes(header.bits);
      if (
        headerBytes.length !== HEADER_BYTES ||
        headerBytes.toString("ascii", 0, 4) !== MAGIC ||
        headerBytes[4] !== VERSION ||
        headerBytes[5] !== 0
      )
        continue;
      const bodyLength = headerBytes.readUInt16BE(6);
      if (bodyLength === 0 || bodyLength > MAX_PAYLOAD_BYTES) continue;
      const frameBytes = HEADER_BYTES + bodyLength + SIGNATURE_BYTES;
      const frameBits = frameBytes * 8;
      if (frameBits * repetition > samples.length) continue;
      const decoded = decodeBits(samples, frameBits, repetition);
      bestConfidence = Math.max(bestConfidence, decoded.confidence);
      const bytes = bitsToBytes(decoded.bits);
      if (bytes.length !== frameBytes) continue;
      foundFrame = true;
      const signedPart = bytes.subarray(0, HEADER_BYTES + bodyLength);
      const suppliedSignature = bytes.subarray(HEADER_BYTES + bodyLength);
      const expectedSignature = createHmac("sha256", secret)
        .update(signedPart)
        .digest()
        .subarray(0, SIGNATURE_BYTES);
      if (
        suppliedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      )
        continue;
      const payload = parsePayload(bytes.subarray(HEADER_BYTES, HEADER_BYTES + bodyLength));
      if (!payload) continue;
      return { valid: true, confidence: decoded.confidence, payload, reason: "OK" };
    }
    return {
      valid: false,
      confidence: bestConfidence,
      payload: null,
      reason: foundFrame ? "Watermark signature or payload is invalid" : "Watermark not found",
    };
  } catch {
    return { valid: false, confidence: 0, payload: null, reason: "Invalid image or watermark secret" };
  }
}

export const extractBlindWatermark = extractWatermark;

export function visibleWatermarkSvg(
  width: number,
  height: number,
  payload: WatermarkPayload,
  density: "low" | "medium" | "high" = "medium",
): string {
  validateDimensions(width, height);
  const count = densityCount(density);
  const text = escapeXml(formatWatermarkText(payload));
  const fontSize = Math.min(256, Math.max(12, Math.round(width / 45)));
  const marks = Array.from({ length: count }, (_, index) => {
    const x = Math.round((((index % 2) + 0.5) * width) / 2);
    const y = Math.round(((Math.floor(index / 2) + 1) * height) / (Math.ceil(count / 2) + 1));
    return `<text x="${x}" y="${y}" transform="rotate(-25 ${x} ${y})" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" fill="rgba(100,100,100,0.22)">${text}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${marks}</svg>`;
}

export function formatWatermarkText(payload: WatermarkPayload, separator = " · "): string {
  if (!payload || typeof payload !== "object") return "DRM";
  const values = [payload.pickupCode, payload.userId, payload.email, payload.timestamp];
  const text = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => boundedText(value, 160))
    .filter((value) => value.length > 0)
    .join(separator);
  return Array.from(text).slice(0, 512).join("") || "DRM";
}

function createFrame(body: Buffer, secret: string): Buffer {
  if (body.length === 0 || body.length > MAX_PAYLOAD_BYTES) throw new Error("Watermark payload is too large");
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, "ascii");
  header[4] = VERSION;
  header[5] = 0;
  header.writeUInt16BE(body.length, 6);
  const signedPart = Buffer.concat([header, body]);
  const signature = createHmac("sha256", secret).update(signedPart).digest().subarray(0, SIGNATURE_BYTES);
  return Buffer.concat([signedPart, signature]);
}

function serializePayload(payload: WatermarkPayload): Buffer {
  if (!payload || typeof payload !== "object") throw new Error("Invalid watermark payload");
  const parts: Buffer[] = [];
  const addField = (value: string | undefined, required: boolean): void => {
    if (value === undefined && !required) {
      const absent = Buffer.alloc(2);
      absent.writeUInt16BE(ABSENT_FIELD, 0);
      parts.push(absent);
      return;
    }
    if (
      typeof value !== "string" ||
      (!required && value.length > MAX_FIELD_BYTES) ||
      (required && value.length === 0) ||
      value.length > MAX_FIELD_BYTES ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)
    )
      throw new Error("Invalid watermark payload text");
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > MAX_FIELD_BYTES || bytes.length >= ABSENT_FIELD)
      throw new Error("Watermark payload field is too large");
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length, 0);
    parts.push(length, bytes);
  };
  addField(payload.userId, true);
  addField(payload.timestamp, true);
  addField(payload.salt, false);
  addField(payload.email, false);
  addField(payload.pickupCode, false);
  const body = Buffer.concat(parts);
  if (body.length > MAX_PAYLOAD_BYTES) throw new Error("Watermark payload is too large");
  return body;
}

function parsePayload(body: Buffer): WatermarkPayload | null {
  try {
    let offset = 0;
    const user = readField(body, offset, true);
    if (!user || typeof user.value !== "string") return null;
    offset = user.next;
    const timestamp = readField(body, offset, true);
    if (!timestamp || typeof timestamp.value !== "string") return null;
    offset = timestamp.next;
    const salt = readField(body, offset, false);
    if (!salt) return null;
    offset = salt.next;
    const email = readField(body, offset, false);
    if (!email) return null;
    offset = email.next;
    const pickupCode = readField(body, offset, false);
    if (!pickupCode || pickupCode.next !== body.length) return null;
    const payload: WatermarkPayload = { userId: user.value, timestamp: timestamp.value };
    if (salt.value !== undefined) payload.salt = salt.value;
    if (email.value !== undefined) payload.email = email.value;
    if (pickupCode.value !== undefined) payload.pickupCode = pickupCode.value;
    return payload;
  } catch {
    return null;
  }
}

function readField(
  body: Buffer,
  offset: number,
  required: boolean,
): { value: string | undefined; next: number } | null {
  if (offset < 0 || offset + 2 > body.length) return null;
  const length = body.readUInt16BE(offset);
  const start = offset + 2;
  if (length === ABSENT_FIELD) return required ? null : { value: undefined, next: start };
  if (length > MAX_FIELD_BYTES || start + length > body.length) return null;
  const bytes = body.subarray(start, start + length);
  try {
    const value = UTF8_DECODER.decode(bytes);
    if (
      (required && value.length === 0) ||
      value.length > MAX_FIELD_BYTES ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)
    )
      return null;
    return { value, next: start + length };
  } catch {
    return null;
  }
}

function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) for (let index = 0; index < 8; index += 1) bits.push((byte >> (7 - index)) & 1);
  return bits;
}

function bitsToBytes(bits: readonly number[]): Buffer {
  if (bits.length % 8 !== 0) return Buffer.alloc(0);
  const bytes = Buffer.alloc(bits.length / 8);
  for (let index = 0; index < bits.length; index += 1) {
    const bit = bits[index] ?? 0;
    const byteIndex = Math.floor(index / 8);
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (bit << (7 - (index % 8)));
  }
  return bytes;
}

function embedRelation(
  coefficients: number[],
  pair: readonly [number, number],
  bit: number,
  strength: number,
): void {
  const first = pair[0];
  const second = pair[1];
  const left = coefficients[first] ?? 0;
  const right = coefficients[second] ?? 0;
  const difference = left - right;
  const minimumDifference = Math.max(16, strength);
  const target = bit === 1 ? minimumDifference : -minimumDifference;
  if ((bit === 1 && difference >= minimumDifference) || (bit === 0 && difference <= -minimumDifference))
    return;
  const adjustment = (target - difference) / 2;
  coefficients[first] = left + adjustment;
  coefficients[second] = right - adjustment;
}

function readSamples(image: RawImage, secret: string): number[] {
  const planes = blocksPerPlane(image);
  const blockCount = planes.x * planes.y;
  const permutation = blockPermutation(blockCount, secret, image.width, image.height);
  const samples: number[] = [];
  for (const blockIndex of permutation) {
    const bx = (blockIndex % planes.x) * 8;
    const by = Math.floor(blockIndex / planes.x) * 8;
    const coefficients = dct(readBlock(image, bx, by));
    for (const pair of PAIRS) samples.push((coefficients[pair[0]] ?? 0) - (coefficients[pair[1]] ?? 0));
  }
  return samples;
}

function decodeBits(
  samples: readonly number[],
  length: number,
  repetition: number,
): { bits: number[]; confidence: number } {
  const bits = new Array<number>(length).fill(0);
  let confidence = 0;
  let magnitude = 0;
  for (let bitIndex = 0; bitIndex < length; bitIndex += 1) {
    let weightedVote = 0;
    let totalWeight = 0;
    for (let repeat = 0; repeat < repetition; repeat += 1) {
      const value = samples[bitIndex * repetition + repeat] ?? 0;
      const weight = Math.max(1, Math.min(64, Math.abs(value)));
      weightedVote += value >= 0 ? weight : -weight;
      totalWeight += weight;
      magnitude += Math.min(64, Math.abs(value));
    }
    bits[bitIndex] = weightedVote >= 0 ? 1 : 0;
    confidence += totalWeight === 0 ? 0 : Math.abs(weightedVote) / totalWeight;
  }
  const averageMagnitude = magnitude / Math.max(1, length * repetition);
  return {
    bits,
    confidence: Math.max(
      0,
      Math.min(1, (confidence / Math.max(1, length)) * Math.min(1, averageMagnitude / 8)),
    ),
  };
}

function blockPermutation(count: number, secret: string, width: number, height: number): number[] {
  const seed = createHmac("sha256", secret).update(`block-permutation:${width}:${height}:${count}`).digest();
  let state = seed.readUInt32BE(0) || 0x6d2b79f5;
  const random = (): number => {
    state ^= (state << 13) >>> 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const permutation = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = permutation[index];
    const swap = permutation[other];
    if (current !== undefined && swap !== undefined) {
      permutation[index] = swap;
      permutation[other] = current;
    }
  }
  return permutation;
}

function blocksPerPlane(image: RawImage): { x: number; y: number } {
  return { x: Math.floor(image.width / 8), y: Math.floor(image.height / 8) };
}

function readBlock(image: RawImage, x: number, y: number): number[] {
  const values = new Array<number>(64).fill(0);
  for (let row = 0; row < 8; row += 1)
    for (let column = 0; column < 8; column += 1)
      values[row * 8 + column] = luminance(image, x + column, y + row) - 128;
  return values;
}

function writeBlock(image: RawImage, x: number, y: number, values: readonly number[]): void {
  for (let row = 0; row < 8; row += 1)
    for (let column = 0; column < 8; column += 1) {
      const index = (y + row) * image.width + x + column;
      const oldLuminance = luminance(image, x + column, y + row);
      const nextLuminance = Math.max(0, Math.min(255, Math.round((values[row * 8 + column] ?? 0) + 128)));
      const delta = nextLuminance - oldLuminance;
      for (let channel = 0; channel < Math.min(image.channels, 3); channel += 1) {
        const dataIndex = index * image.channels + channel;
        image.data[dataIndex] = Math.max(0, Math.min(255, Math.round((image.data[dataIndex] ?? 0) + delta)));
      }
    }
}

function luminance(image: RawImage, x: number, y: number): number {
  const index = (y * image.width + x) * image.channels;
  if (image.channels === 1) return image.data[index] ?? 0;
  return Math.round(
    0.299 * (image.data[index] ?? 0) +
      0.587 * (image.data[index + 1] ?? 0) +
      0.114 * (image.data[index + 2] ?? 0),
  );
}

function dct(input: readonly number[]): number[] {
  const temporary = new Array<number>(64).fill(0);
  const output = new Array<number>(64).fill(0);
  for (let row = 0; row < 8; row += 1)
    for (let column = 0; column < 8; column += 1) {
      let sum = 0;
      for (let position = 0; position < 8; position += 1)
        sum += (DCT_MATRIX[column]?.[position] ?? 0) * (input[row * 8 + position] ?? 0);
      temporary[row * 8 + column] = sum;
    }
  for (let frequency = 0; frequency < 8; frequency += 1)
    for (let column = 0; column < 8; column += 1) {
      let sum = 0;
      for (let row = 0; row < 8; row += 1)
        sum += (DCT_MATRIX[frequency]?.[row] ?? 0) * (temporary[row * 8 + column] ?? 0);
      output[frequency * 8 + column] = sum;
    }
  return output;
}

function idct(input: readonly number[]): number[] {
  const temporary = new Array<number>(64).fill(0);
  const output = new Array<number>(64).fill(0);
  for (let row = 0; row < 8; row += 1)
    for (let column = 0; column < 8; column += 1) {
      let sum = 0;
      for (let frequency = 0; frequency < 8; frequency += 1)
        sum += (DCT_MATRIX[frequency]?.[row] ?? 0) * (input[frequency * 8 + column] ?? 0);
      temporary[row * 8 + column] = sum;
    }
  for (let row = 0; row < 8; row += 1)
    for (let column = 0; column < 8; column += 1) {
      let sum = 0;
      for (let frequency = 0; frequency < 8; frequency += 1)
        sum += (DCT_MATRIX[column]?.[frequency] ?? 0) * (temporary[row * 8 + frequency] ?? 0);
      output[row * 8 + column] = sum;
    }
  return output;
}

function validateImage(image: RawImage): void {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 8 ||
    image.height < 8 ||
    image.width > MAX_IMAGE_DIMENSION ||
    image.height > MAX_IMAGE_DIMENSION ||
    image.width * image.height > MAX_IMAGE_PIXELS ||
    ![1, 3, 4].includes(image.channels) ||
    !(image.data instanceof Uint8Array) ||
    image.data.length !== image.width * image.height * image.channels
  )
    throw new Error("Invalid raw image dimensions");
}

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new Error("Invalid watermark dimensions");
}

function validateSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 512)
    throw new Error("Invalid watermark secret");
}

function densityCount(density: "low" | "medium" | "high"): number {
  if (density === "high") return 8;
  if (density === "medium") return 4;
  if (density === "low") return 2;
  throw new Error("Invalid watermark density");
}

function boundedText(value: string, maximum: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return Array.from(safe).slice(0, maximum).join("");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
