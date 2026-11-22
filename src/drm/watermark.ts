import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface RawImage { width: number; height: number; channels: 1 | 3 | 4; data: Uint8Array }
export interface WatermarkPayload { userId: string; timestamp: string; salt?: string; email?: string; pickupCode?: string }

export function createWatermarkPayload(input: Omit<WatermarkPayload, "salt">): Required<WatermarkPayload> {
  return { ...input, salt: randomBytes(16).toString("hex"), email: input.email ?? "", pickupCode: input.pickupCode ?? "" };
}

export function embedInvisibleWatermark(image: RawImage, payload: WatermarkPayload, secret: string, strength = 28): RawImage {
  const bits = signedBits(payload, secret);
  const output = transformBlocks(image, bits, strength, true);
  return output;
}

export function extractInvisibleWatermark(image: RawImage, payload: WatermarkPayload, secret: string): boolean {
  const expected = signedBits(payload, secret);
  const actual = transformBlocks(image, expected, 0, false);
  const decoded = decodeBits(expected.length, actual);
  if (decoded.length !== expected.length) return false;
  const left = Buffer.from(decoded);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function visibleWatermarkSvg(width: number, height: number, payload: WatermarkPayload, density: "low" | "medium" | "high" = "medium"): string {
  const count = density === "high" ? 8 : density === "medium" ? 4 : 2;
  const text = escapeXml([payload.pickupCode, payload.email ?? payload.userId, payload.timestamp].filter(Boolean).join(" · "));
  const marks = Array.from({ length: count }, (_, index) => {
    const x = Math.round(((index % 2) + 0.5) * width / 2);
    const y = Math.round((Math.floor(index / 2) + 1) * height / (Math.ceil(count / 2) + 1));
    return `<text x="${x}" y="${y}" transform="rotate(-25 ${x} ${y})" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(12, Math.round(width / 45))}" fill="rgba(100,100,100,0.22)">${text}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${marks}</svg>`;
}

function signedBits(payload: WatermarkPayload, secret: string): number[] {
  const body = Buffer.from(JSON.stringify({ ...payload, salt: payload.salt ?? "unsalted" }), "utf8");
  if (body.length > 65535) throw new Error("Watermark payload is too large");
  const signature = createHmac("sha256", secret).update(body).digest().subarray(0, 8);
  const message = Buffer.concat([Buffer.from([body.length >> 8, body.length & 0xff]), body, signature]);
  return [...message].flatMap((byte) => Array.from({ length: 8 }, (_, index) => (byte >> (7 - index)) & 1));
}

function transformBlocks(image: RawImage, bits: number[], strength: number, embedding: boolean): RawImage | number[] {
  validateImage(image);
  if (embedding && strength < 8) throw new Error("Watermark strength is too low");
  const output = embedding ? { ...image, data: new Uint8Array(image.data) } : image;
  const blocks = Math.floor(image.width / 8) * Math.floor(image.height / 8);
  const repetition = Math.max(1, Math.floor(blocks / bits.length));
  if (embedding && repetition < 3) throw new Error("Image is too small for a redundant watermark");
  const read: number[] = [];
  const planes = blocksPerPlane(image);
  for (let block = 0; block < (embedding ? bits.length * repetition : blocks); block += 1) {
    const bitIndex = embedding ? Math.floor(block / repetition) : Math.floor(block / repetition);
    if (bitIndex >= bits.length) break;
    const bx = (block % planes.x) * 8;
    const by = (Math.floor(block / planes.x) % planes.y) * 8;
    const coefficients = dct(readBlock(output, bx, by));
    if (embedding) {
      const bit = bits[bitIndex] ?? 0;
      if (bit && coefficients[19] <= (coefficients[26] ?? 0)) { coefficients[19] = (coefficients[26] ?? 0) + strength; coefficients[26] = (coefficients[26] ?? 0) - strength / 2; }
      if (!bit && coefficients[19] >= (coefficients[26] ?? 0)) { coefficients[26] = (coefficients[19] ?? 0) + strength; coefficients[19] = (coefficients[19] ?? 0) - strength / 2; }
      writeBlock(output, bx, by, idct(coefficients));
    } else read.push((coefficients[19] ?? 0) > (coefficients[26] ?? 0) ? 1 : 0);
  }
  return embedding ? output : read;
}

function decodeBits(length: number, sampled: number[]): number[] {
  const repetition = Math.max(1, Math.floor(sampled.length / length));
  return Array.from({ length }, (_, bit) => {
    let votes = 0;
    for (let index = bit * repetition; index < (bit + 1) * repetition; index += 1) votes += sampled[index] ?? 0;
    return votes * 2 >= repetition ? 1 : 0;
  });
}
function blocksPerPlane(image: RawImage): { x: number; y: number } { return { x: Math.floor(image.width / 8), y: Math.floor(image.height / 8) }; }
function readBlock(image: RawImage, x: number, y: number): number[] {
  const values: number[] = [];
  for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) values.push(luminance(image, x + column, y + row) - 128);
  return values;
}
function writeBlock(image: RawImage, x: number, y: number, values: number[]): void {
  for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
    const index = (y + row) * image.width + x + column;
    const delta = Math.round(values[row * 8 + column] ?? 0) + 128 - luminance(image, x + column, y + row);
    for (let channel = 0; channel < Math.min(image.channels, 3); channel += 1) image.data[index * image.channels + channel] = Math.max(0, Math.min(255, (image.data[index * image.channels + channel] ?? 0) + delta));
  }
}
function luminance(image: RawImage, x: number, y: number): number {
  const index = (y * image.width + x) * image.channels;
  if (image.channels === 1) return image.data[index] ?? 0;
  return Math.round(0.299 * (image.data[index] ?? 0) + 0.587 * (image.data[index + 1] ?? 0) + 0.114 * (image.data[index + 2] ?? 0));
}
function dct(input: number[]): number[] { return transformDct(input, false); }
function idct(input: number[]): number[] { return transformDct(input, true); }
function transformDct(input: number[], inverse: boolean): number[] {
  const output = new Array<number>(64).fill(0);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
    let sum = 0;
    for (let v = 0; v < 8; v += 1) for (let u = 0; u < 8; u += 1) {
      const value = input[v * 8 + u] ?? 0;
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      sum += inverse ? cu * cv * value * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16) : value * Math.cos((2 * u + 1) * x * Math.PI / 16) * Math.cos((2 * v + 1) * y * Math.PI / 16);
    }
    output[y * 8 + x] = inverse ? sum / 4 : sum * (x === 0 ? Math.SQRT1_2 : 1) * (y === 0 ? Math.SQRT1_2 : 1) / 4;
  }
  return output;
}
function validateImage(image: RawImage): void {
  if (image.width < 8 || image.height < 8 || image.data.length !== image.width * image.height * image.channels) throw new Error("Invalid raw image dimensions");
}
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
