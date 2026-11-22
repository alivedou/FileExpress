import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation, type Locale } from "../i18n";
import { ResumableChunkUploader, type ChunkUploadProgress, type ResumableUploadResult } from "./client";

export function LargeFileUpload({ file, locale, onComplete }: { file: File; locale: Locale; onComplete: (result: ResumableUploadResult) => void }) {
  const { t } = useTranslation(locale);
  const uploader = useRef<ResumableChunkUploader | undefined>(undefined);
  const [progress, setProgress] = useState<ChunkUploadProgress>({ uploadedBytes: 0, totalBytes: file.size, percentage: 0, activeChunks: 0 });
  const [paused, setPaused] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const start = async (): Promise<void> => {
    setRunning(true); setError("");
    uploader.current = new ResumableChunkUploader({ file, concurrency: 3, retries: 3, onProgress: setProgress });
    try { onComplete(await uploader.current.start()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Upload failed"); }
    finally { setRunning(false); }
  };
  return <section className="rounded-xl border border-[var(--accent)]/30 p-4 space-y-3" aria-label={t("upload.largeMode")}>
    <div className="flex justify-between text-xs font-bold"><span>{t("upload.largeMode")}</span><span>{progress.percentage}%</span></div>
    <div className="h-2 rounded bg-black/10 overflow-hidden"><motion.div className="h-full bg-[var(--accent)]" animate={{ width: `${progress.percentage}%` }} /></div>
    <p className="text-[10px] opacity-60">{Math.round(progress.uploadedBytes / 1048576)} / {Math.round(progress.totalBytes / 1048576)} MiB · {t("upload.retry")}</p>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    <div className="flex gap-2">
      <button type="button" disabled={running} onClick={() => { void start(); }} className="flex-1 rounded bg-[var(--accent)] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t("upload.start")}</button>
      {running && <button type="button" onClick={() => { if (paused) uploader.current?.continue(); else uploader.current?.pause(); setPaused(!paused); }} className="rounded border px-3 py-2 text-xs">{paused ? t("upload.continue") : t("upload.pause")}</button>}
    </div>
  </section>;
}
