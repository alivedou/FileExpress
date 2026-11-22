import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import sharp from "sharp";
import { formatWatermarkText, visibleWatermarkSvg, type WatermarkPayload } from "./watermark";

export { FfmpegVideoWatermarkAdapter, watermarkVideo } from "./ffmpeg";
export type { FfmpegExecutionOptions, FfmpegExecutor, FfmpegVideoWatermarkAdapterOptions } from "./ffmpeg";

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_PAGE_COUNT = 4096;
const MAX_PAGE_DIMENSION = 1_000_000;

export async function watermarkPdf(source: Uint8Array, payload: WatermarkPayload): Promise<Uint8Array> {
  if (!(source instanceof Uint8Array) || source.byteLength === 0 || source.byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("PDF size is outside the allowed range");
  const document = await PDFDocument.load(source);
  const pages = document.getPages();
  if (pages.length > MAX_PAGE_COUNT) throw new Error("PDF page count is too large");
  const font = await document.embedFont(StandardFonts.Helvetica);
  const text = formatWatermarkText(payload, " | ").replace(/[^\x20-\x7E]/g, "?");
  for (const page of pages) {
    const { width, height } = page.getSize();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_PAGE_DIMENSION ||
      height > MAX_PAGE_DIMENSION
    )
      throw new Error("PDF page dimensions are invalid");
    const size = Math.min(72, Math.max(10, width / 55));
    for (let row = 1; row <= 3; row += 1)
      page.drawText(text, {
        x: width * 0.12,
        y: (height * row) / 4,
        size,
        font,
        color: rgb(0.4, 0.4, 0.4),
        opacity: 0.25,
        rotate: degrees(-25),
      });
  }
  return document.save();
}

export async function watermarkImage(
  source: Buffer,
  payload: WatermarkPayload,
  density: "low" | "medium" | "high" = "medium",
): Promise<Buffer> {
  if (!Buffer.isBuffer(source) || source.byteLength === 0 || source.byteLength > MAX_IMAGE_BYTES)
    throw new Error("Image size is outside the allowed range");
  const metadata = await sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Unable to determine image dimensions");
  const overlay = Buffer.from(visibleWatermarkSvg(metadata.width, metadata.height, payload, density), "utf8");
  return sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS })
    .composite([{ input: overlay }])
    .toBuffer();
}
