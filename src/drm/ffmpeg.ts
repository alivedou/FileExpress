import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatWatermarkText, type WatermarkPayload } from "./watermark";

export interface FfmpegExecutionOptions {
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  killSignal: "SIGKILL";
}

export type FfmpegExecutor = (
  file: string,
  args: readonly string[],
  options: FfmpegExecutionOptions,
) => Promise<unknown> | unknown;

export interface FfmpegVideoWatermarkAdapterOptions {
  executor?: FfmpegExecutor;
  execute?: FfmpegExecutor;
  ffmpegPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  tempDirectory?: string;
}

const defaultExecutor: FfmpegExecutor = (file, args, options) =>
  new Promise((resolveResult, rejectResult) => {
    execFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) rejectResult(error);
      else resolveResult({ stdout, stderr });
    });
  });

export class FfmpegVideoWatermarkAdapter {
  private readonly executor: FfmpegExecutor;
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly tempDirectory: string;

  constructor(options: FfmpegVideoWatermarkAdapterOptions | FfmpegExecutor = {}) {
    const normalized = typeof options === "function" ? { executor: options } : options;
    this.executor = normalized.executor ?? normalized.execute ?? defaultExecutor;
    this.ffmpegPath = normalized.ffmpegPath ?? "ffmpeg";
    this.timeoutMs = boundedInteger(normalized.timeoutMs ?? 30 * 60_000, 1, 60 * 60_000, "FFmpeg timeout");
    this.maxBuffer = boundedInteger(
      normalized.maxBuffer ?? 4 * 1024 * 1024,
      1024,
      64 * 1024 * 1024,
      "FFmpeg maxBuffer",
    );
    this.tempDirectory = resolve(normalized.tempDirectory ?? tmpdir());
    if (this.ffmpegPath.length === 0 || this.ffmpegPath.length > 4096 || this.ffmpegPath.includes("\0"))
      throw new Error("Invalid FFmpeg executable");
  }

  async watermark(inputPath: string, outputPath: string, payload: WatermarkPayload): Promise<void> {
    const input = absolutePath(inputPath, "Input");
    const output = absolutePath(outputPath, "Output");
    if (input === output) throw new Error("Input and output paths must differ");
    const text = formatWatermarkText(payload, " | ");
    const temporaryDirectory = await mkdtemp(join(this.tempDirectory, "fileexpress-drm-"));
    try {
      const textPath = join(temporaryDirectory, "watermark.txt");
      await writeFile(textPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const filter = `drawtext=textfile='${escapeFilterPath(textPath)}':fontcolor=white@0.25:fontsize=24:box=1:boxcolor=black@0.1:x=mod(t*30\\,w+tw)-tw:y=h*0.2`;
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        input,
        "-vf",
        filter,
        "-c:a",
        "copy",
        "-y",
        output,
      ];
      await this.executor(this.ffmpegPath, args, {
        timeout: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        shell: false,
        windowsHide: true,
        killSignal: "SIGKILL",
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async watermarkVideo(inputPath: string, outputPath: string, payload: WatermarkPayload): Promise<void> {
    return this.watermark(inputPath, outputPath, payload);
  }
}

export async function watermarkVideo(
  inputPath: string,
  outputPath: string,
  payload: WatermarkPayload,
  options: FfmpegVideoWatermarkAdapterOptions | FfmpegExecutor = {},
): Promise<void> {
  return new FfmpegVideoWatermarkAdapter(options).watermark(inputPath, outputPath, payload);
}

function absolutePath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0"))
    throw new Error(`${label} path is invalid`);
  return resolve(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label} is outside the allowed range`);
  return value;
}

function escapeFilterPath(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid temporary watermark path");
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll(",", "\\,")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll(";", "\\;");
}
