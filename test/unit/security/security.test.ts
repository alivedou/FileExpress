import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClamAvScanner } from "../../../src/security/clamav";
import { analyseHeuristics, HeuristicScanner, shannonEntropy } from "../../../src/security/heuristic";
import { ScanPipeline } from "../../../src/security/pipeline";
import { FileQuarantineStore } from "../../../src/security/quarantine";
import type { EngineScanResult, ScanEngine } from "../../../src/security/types";
import { VirusTotalScanner } from "../../../src/security/virustotal";
import { parseYaraCli, YaraScanner } from "../../../src/security/yara";
import { fileMeta, temporaryDirectory } from "../../helpers";

describe("heuristic scanner", () => {
  it("calculates entropy and detects executable, macro and active PDF content", () => {
    expect(shannonEntropy(Buffer.alloc(0))).toBe(0);
    expect(shannonEntropy(Buffer.from([0, 0, 1, 1]))).toBe(1);
    expect(analyseHeuristics(Buffer.from("MZ executable"), "application/pdf").verdict).toBe("malicious");
    expect(analyseHeuristics(Buffer.from("pdfMZ"), "application/pdf").details[0]).toContain("offset 3");
    const office = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("[Content_Types].xml vbaProject.bin"),
    ]);
    expect(analyseHeuristics(office, "application/zip")).toMatchObject({ verdict: "suspicious" });
    expect(analyseHeuristics(Buffer.from("%PDF /JavaScript"), "application/pdf").verdict).toBe("suspicious");
    expect(analyseHeuristics(Buffer.alloc(4096, 1), "application/octet-stream").verdict).toBe("clean");
    expect(analyseHeuristics(Buffer.alloc(0), "text/plain").details).toEqual(["Empty file"]);
  });
  it("implements the scan engine contract", async () => {
    expect(await new HeuristicScanner().scan(Readable.from(["text"]), fileMeta())).toMatchObject({
      engine: "heuristic",
      verdict: "clean",
    });
    expect(await new HeuristicScanner().version()).toBe("builtin-v1");
  });
});

describe("external scanners", () => {
  it("parses ClamAV responses and rejects unknown or failed responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("ClamAV 1.0", { status: 200 }))
      .mockResolvedValueOnce(
        new Response("stream: OK", { status: 200, headers: { "X-ClamAV-Signature-Version": "123" } }),
      )
      .mockResolvedValueOnce(new Response("Eicar FOUND", { status: 200 }))
      .mockResolvedValueOnce(new Response("mystery", { status: 200 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }));
    const scanner = new ClamAvScanner({ baseUrl: "http://clam.test/", fetchImpl: fetcher });
    expect(await scanner.version()).toBe("ClamAV 1.0");
    expect(await scanner.scan(Readable.from(["a"]), fileMeta())).toMatchObject({
      verdict: "clean",
      signatureVersion: "123",
    });
    expect(await scanner.scan(Readable.from(["a"]), fileMeta())).toMatchObject({ verdict: "malicious" });
    await expect(scanner.scan(Readable.from(["a"]), fileMeta())).rejects.toThrow("Unrecognised");
    await expect(scanner.scan(Readable.from(["a"]), fileMeta())).rejects.toThrow("HTTP 503");
    expect(fetcher).toHaveBeenCalledWith(
      "http://clam.test/scan",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("uses VirusTotal hash cache, aggregates verdicts and validates callbacks", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            attributes: {
              last_analysis_stats: { malicious: 1, suspicious: 0, harmless: 40, undetected: 2 },
            },
          },
        }),
        { status: 200 },
      ),
    );
    const scanner = new VirusTotalScanner({ apiKey: "secret", fetchImpl: fetcher });
    expect(await scanner.scan(Readable.from(["same"]), fileMeta())).toMatchObject({ verdict: "malicious" });
    expect(await scanner.scan(Readable.from(["same"]), fileMeta())).toMatchObject({ verdict: "malicious" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(scanner.verifyCallback("{}", "100", "bad", "secret", 300)).toBe(false);
    expect(await scanner.version()).toBe("multi-engine-cloud");
  });
  it("queues unknown files and normalises YARA matches", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "analysis" } }), { status: 200 }));
    const scanner = new VirusTotalScanner({ apiKey: "secret", fetchImpl: fetcher });
    expect(await scanner.scan(Readable.from(["new"]), fileMeta())).toMatchObject({
      verdict: "suspicious",
      details: ["Analysis queued: analysis"],
    });
    const runner = {
      version: vi.fn(async () => "rules-v1"),
      scan: vi.fn(async () => [{ rule: "Trojan", severity: "malicious" as const }]),
    };
    expect(await new YaraScanner(runner).scan(Readable.from(["bad"]), fileMeta())).toMatchObject({
      verdict: "malicious",
      signatureVersion: "rules-v1",
    });
    expect(parseYaraCli("MacroRule /tmp/a\nTrojan /tmp/a")[0]?.severity).toBe("suspicious");
    expect(() => parseYaraCli("broken")).toThrow("Invalid YARA");
  });
});

describe("scan pipeline and quarantine", () => {
  it("runs engines independently, quarantines threats and emits events", async () => {
    const root = await temporaryDirectory("quarantine");
    const quarantine = new FileQuarantineStore(root);
    const clean: ScanEngine = {
      name: "clean",
      version: async () => "1",
      scan: async (): Promise<EngineScanResult> => ({ engine: "clean", verdict: "clean", details: [] }),
    };
    const threat: ScanEngine = {
      name: "threat",
      version: async () => "1",
      scan: async () => ({ engine: "threat", verdict: "malicious", details: ["Eicar"] }),
    };
    const publish = vi.fn(async () => undefined);
    const pipeline = new ScanPipeline({
      engines: [clean, threat],
      quarantine,
      events: { publish },
      concurrency: 1,
    });
    const result = await pipeline.scan("file", () => Readable.from(["payload"]), fileMeta());
    expect(result).toMatchObject({ verdict: "malicious", action: "quarantine" });
    expect(result.results).toHaveLength(2);
    expect(publish).toHaveBeenCalledWith("scan.threat_detected", expect.objectContaining({ id: "file" }));
    expect(publish).toHaveBeenCalledWith(
      "scan.completed",
      expect.objectContaining({ id: "file", verdict: "malicious" }),
    );
    const directory = (await import("node:fs/promises")).readdir;
    const ids = await directory(root);
    expect(ids).toHaveLength(1);
    const record = await quarantine.get(ids[0] ?? "");
    expect(record.record.released).toBe(false);
    expect((await quarantine.release(ids[0] ?? "")).released).toBe(true);
    await expect(readFile(path.join(root, ids[0] ?? "", "payload.bin"), "utf8")).resolves.toBe("payload");
    await expect(quarantine.get("bad")).rejects.toThrow("Invalid quarantine");
  });
  it("handles scanner failures and queues work within concurrency", async () => {
    const failure: ScanEngine = {
      name: "down",
      version: async () => "1",
      scan: async () => {
        throw new Error("offline");
      },
    };
    const pipeline = new ScanPipeline({ engines: [failure] });
    const result = await pipeline.scan("file", () => Readable.from(["a"]), fileMeta());
    expect(result).toMatchObject({ verdict: "error", action: "review" });
    expect(result.results[0]?.details).toEqual(["offline"]);
    expect(pipeline.depth).toBe(0);
  });
});
