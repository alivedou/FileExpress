import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import sharp from "sharp";
import { visibleWatermarkSvg, type WatermarkPayload } from "./watermark";

const execute = promisify(execFile);
export async function watermarkPdf(source: Uint8Array, payload: WatermarkPayload): Promise<Uint8Array> {
  const document = await PDFDocument.load(source); const font = await document.embedFont(StandardFonts.Helvetica);
  const text = [payload.pickupCode, payload.email ?? payload.userId, payload.timestamp].filter(Boolean).join(" | ");
  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    for (let row = 1; row <= 3; row += 1) page.drawText(text, { x: width * 0.12, y: height * row / 4, size: Math.max(10, width / 55), font, color: rgb(0.4, 0.4, 0.4), opacity: 0.25, rotate: degrees(-25) });
  }
  return document.save();
}
export async function watermarkImage(source: Buffer, payload: WatermarkPayload, density: "low" | "medium" | "high" = "medium"): Promise<Buffer> {
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Unable to determine image dimensions");
  const overlay = Buffer.from(visibleWatermarkSvg(metadata.width, metadata.height, payload, density));
  return sharp(source).composite([{ input: overlay }]).toBuffer();
}
export async function watermarkVideo(inputPath: string, outputPath: string, payload: WatermarkPayload): Promise<void> {
  const text = [payload.pickupCode, payload.email ?? payload.userId, payload.timestamp].filter(Boolean).join(" | ").replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'").replaceAll("%", "\\%");
  const filter = `drawtext=text='${text}':fontcolor=white@0.25:fontsize=24:box=1:boxcolor=black@0.1:x=mod(t*30\,w+tw)-tw:y=h*0.2`;
  await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", inputPath, "-vf", filter, "-c:a", "copy", "-y", outputPath], { timeout: 30 * 60_000 });
}
