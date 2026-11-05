import { createHash } from "node:crypto";

import type { LanguageAdapter } from "@untangle-code/domain";
import { LazyParserRegistry, createParserRegistry } from "@untangle-code/parser-registry";
import type { ScannedFileV1 } from "@untangle-code/scanner";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import {
  aggregateProductMeasurements,
  collectProductInventory,
  createProductInventory,
  isProductCodeFile,
  measureProductFiles,
  readFreshProductFile,
} from "./analysis.js";

const ROOT = "/workspace/project";
const SOURCE = [
  "// A real source comment",
  "",
  "export function feature(enabled: boolean): boolean {",
  "  if (enabled) return helper(enabled);",
  "  return false;",
  "}",
  "",
  "function helper(value: boolean): boolean {",
  "  if (value) return true;",
  "  return false;",
  "}",
  "",
].join("\n");

function fixture(contents: Readonly<Record<string, string | Uint8Array>>): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock(100));
  fs.seedDirectory(ROOT);
  for (const [filePath, content] of Object.entries(contents))
    fs.seedFile(`${ROOT}/${filePath}`, content);
  return fs;
}

function accepted(relativePath: string, text: string | Uint8Array): ScannedFileV1 {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return {
    relativePath,
    absolutePath: `${ROOT}/${relativePath}`,
    contentHash: hash(bytes),
    sizeBytes: bytes.byteLength,
    mtimeEpochMs: 100,
    languageId: "typescript",
    languageDetectedBy: "extension",
    isMinified: false,
    encoding: "utf8",
    hasBom: false,
  };
}

function hash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function alteredRegistry(changes: Partial<LanguageAdapter>) {
  const native = createParserRegistry().getAdapterForPath("file.ts");
  if (native === null) throw new Error("TypeScript adapter missing");
  const registry = new LazyParserRegistry();
  registry.register({ ...native, ...changes });
  return { registry, native };
}

describe("product source inventory", () => {
  it("uses the actual scanner ignores and excludes only its self-managed output from evidence", async () => {
    const fs = fixture({
      ".gitignore": ".untangle/\nprivate.ts\n",
      ".untangleignore": "generated.ts\n",
      "main.ts": SOURCE,
      "vision.md": "# Vision",
      "private.ts": SOURCE,
      "generated.ts": SOURCE,
      ".untangle/cache.ts": SOURCE,
      "untangle.toml": "old",
      "untangle.toml.untangle-init-tmp": "temp",
    });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    expect(inventory.files.map((file) => file.relativePath)).toEqual([
      ".gitignore",
      ".untangleignore",
      "main.ts",
      "vision.md",
    ]);
    expect(inventory.excluded).toBe(3);
    expect(inventory.truncated).toBe(false);
    expect(inventory.sourceTreeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      inventory.files.filter((file) => isProductCodeFile(file)).map((file) => file.relativePath),
    ).toEqual(["main.ts"]);
  });

  it("creates an immutable deterministic digest of all accepted sources, not just mapped code", () => {
    const fs = fixture({});
    const code = accepted("main.ts", SOURCE);
    const vision = accepted("vision.md", "# Vision");
    const first = createProductInventory({
      root: ROOT,
      fs,
      files: [code, vision],
      truncated: true,
      excluded: 4,
    });
    const second = createProductInventory({ root: ROOT, fs, files: [vision, code] });
    expect(first.sourceTreeDigest).toBe(second.sourceTreeDigest);
    expect(first.truncated).toBe(true);
    expect(first.excluded).toBe(4);
    code.contentHash = "0".repeat(64);
    expect(first.files[0]?.contentHash).toBe(hash(SOURCE));
    expect(Object.isFrozen(first.files)).toBe(true);
    const changed = createProductInventory({
      root: ROOT,
      fs,
      files: [accepted("main.ts", SOURCE), accepted("vision.md", "# Different vision")],
    });
    expect(changed.sourceTreeDigest).not.toBe(first.sourceTreeDigest);
  });

  it("preserves an explicit scanner scope on repeated collection", async () => {
    const fs = fixture({
      "main.ts": SOURCE,
      "excluded.ts": SOURCE,
      "oversize.ts": SOURCE.repeat(2),
      "untangle.toml": "managed",
    });
    const scope = {
      additionalDefaultExcludes: ["excluded.ts"],
      maxFileSizeBytes: new TextEncoder().encode(SOURCE).byteLength,
      maxFilesScanned: 10,
      concurrency: 1,
    };
    const first = await collectProductInventory({ root: ROOT, fs, scope });
    const second = await collectProductInventory({ root: ROOT, fs, scope });
    expect(first.files.map((file) => file.relativePath)).toEqual(["main.ts"]);
    expect(second.sourceTreeDigest).toBe(first.sourceTreeDigest);
    expect(first.truncated).toBe(false);
    expect(first.excluded).toBe(2);
  });

  it("only reports a scoped file-count limit after finding an actual additional file", async () => {
    const fs = fixture({ "main.ts": SOURCE });
    const scope = { maxFilesScanned: 1, concurrency: 1 };
    expect((await collectProductInventory({ root: ROOT, fs, scope })).truncated).toBe(false);
    fs.seedFile(`${ROOT}/other.ts`, SOURCE);
    const limited = await collectProductInventory({ root: ROOT, fs, scope });
    expect(limited.files).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(
      (await collectProductInventory({ root: ROOT, fs, scope: { maxFilesScanned: 0 } })).files,
    ).toEqual([]);
    expect(
      (await collectProductInventory({ root: ROOT, fs, scope: { maxFilesScanned: 0 } })).truncated,
    ).toBe(true);
  });

  it("rejects conflicting accepted hashes instead of silently selecting one", () => {
    expect(() =>
      createProductInventory({
        root: ROOT,
        fs: fixture({}),
        files: [accepted("main.ts", "a"), accepted("main.ts", "b")],
      }),
    ).toThrow("Conflicting accepted source path");
  });

  it("deduplicates repeated identical paths and keeps self-managed files out of the digest", () => {
    const fs = fixture({});
    const file = accepted("main.ts", SOURCE);
    const inventory = createProductInventory({
      root: ROOT,
      fs,
      files: [file, file, accepted("untangle.toml", "old")],
    });
    expect(inventory.files).toHaveLength(1);
    expect(inventory.sourceTreeDigest).toBe(
      createProductInventory({ root: ROOT, fs, files: [file] }).sourceTreeDigest,
    );
  });

  it("honors a pre-aborted inventory collection before filesystem reads", async () => {
    const fs = fixture({});
    const controller = new AbortController();
    const reason = new Error("Inventory cancelled");
    controller.abort(reason);
    const paths = vi.spyOn(fs, "realPath");
    await expect(
      collectProductInventory({ root: ROOT, fs, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(paths).not.toHaveBeenCalled();
  });
});

describe("fresh accepted product files", () => {
  it("binds raw BOM/CRLF bytes while preserving text byte offsets", async () => {
    const source = "\uFEFFexport const value = 1;\r\n";
    const fs = fixture({ "main.ts": source });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    expect(await readFreshProductFile(inventory, "./main.ts")).toEqual({
      status: "resolved",
      contentHash: hash(source),
      text: source,
    });
  });

  it("distinguishes absent paths from ignored existing paths without reading either", async () => {
    const fs = fixture({ ".gitignore": "ignored.md\n", "ignored.md": "Secret context" });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    const reads = vi.spyOn(fs, "readFile");
    expect(await readFreshProductFile(inventory, "missing.md")).toEqual({ status: "missing" });
    expect(await readFreshProductFile(inventory, "ignored.md")).toEqual({ status: "not_in_scan" });
    expect(reads).not.toHaveBeenCalled();
  });

  it("does no filesystem access for relative and absolute root escapes", async () => {
    const fs = fixture({});
    const inventory = createProductInventory({ root: ROOT, fs, files: [] });
    const reads = vi.spyOn(fs, "readFile");
    const stats = vi.spyOn(fs, "stat");
    const paths = vi.spyOn(fs, "realPath");
    expect(await readFreshProductFile(inventory, "../outside.md")).toEqual({
      status: "not_in_scan",
    });
    expect(await readFreshProductFile(inventory, "/external/source.ts")).toEqual({
      status: "not_in_scan",
    });
    expect(reads).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(paths).not.toHaveBeenCalled();
  });

  it("detects content changes and keeps the new hash without interpreting new text", async () => {
    const fs = fixture({ "main.ts": SOURCE });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    fs.seedFile(`${ROOT}/main.ts`, "export const changed = true;");
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({
      status: "changed",
      contentHash: hash("export const changed = true;"),
    });
  });

  it("rejects an escaped symlink after scanning without reading external content", async () => {
    const fs = fixture({ "main.ts": SOURCE });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    fs.seedFile("/external/main.ts", SOURCE);
    fs.seedSymlink(`${ROOT}/main.ts`, "/external/main.ts");
    const reads = vi.spyOn(fs, "readFile");
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({ status: "not_in_scan" });
    expect(reads).not.toHaveBeenCalled();
  });

  it("detects an in-root target change even when both targets contain identical bytes", async () => {
    const fs = fixture({ "old.ts": SOURCE, "new.ts": SOURCE });
    fs.seedSymlink(`${ROOT}/main.ts`, "old.ts");
    const inventory = await collectProductInventory({ root: ROOT, fs });
    fs.seedSymlink(`${ROOT}/main.ts`, "new.ts");
    const reads = vi.spyOn(fs, "readFile");
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({ status: "changed" });
    expect(reads).not.toHaveBeenCalled();
  });

  it("detects a symlink retargeted during the read instead of publishing old contents as fresh", async () => {
    const fs = fixture({ "main.ts": SOURCE, "other.ts": SOURCE });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await original(file, options);
      fs.seedSymlink(`${ROOT}/main.ts`, "other.ts");
      return bytes;
    });
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({
      status: "changed",
      contentHash: hash(SOURCE),
    });
  });

  it("rejects a synthetic scanner entry with an outside physical path before filesystem access", async () => {
    const fs = fixture({});
    const inventory = createProductInventory({
      root: ROOT,
      fs,
      files: [{ ...accepted("main.ts", SOURCE), absolutePath: "/external/main.ts" }],
    });
    const paths = vi.spyOn(fs, "realPath");
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({ status: "not_in_scan" });
    expect(paths).not.toHaveBeenCalled();
  });

  it("reports a formerly accepted missing file without inventing an empty source", async () => {
    const fs = fixture({});
    const inventory = createProductInventory({
      root: ROOT,
      fs,
      files: [accepted("main.ts", SOURCE)],
    });
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({ status: "missing" });
  });

  it("rejects malformed UTF-8 and unsupported UTF-16 while retaining available raw hashes", async () => {
    const bytes = new Uint8Array([0x23, 0x20, 0xff]);
    const fs = fixture({ "main.ts": bytes });
    const inventory = createProductInventory({
      root: ROOT,
      fs,
      files: [accepted("main.ts", bytes)],
    });
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({
      status: "unreadable",
      contentHash: hash(bytes),
      sourceUnchanged: true,
    });
    const utf16 = new Uint8Array([0xff, 0xfe, 0x23, 0x00]);
    fs.seedFile(`${ROOT}/main.ts`, utf16);
    const other = createProductInventory({
      root: ROOT,
      fs,
      files: [{ ...accepted("main.ts", utf16), encoding: "utf16le" }],
    });
    expect(await readFreshProductFile(other, "main.ts")).toEqual({
      status: "unreadable",
      contentHash: hash(utf16),
      sourceUnchanged: true,
    });
  });

  it("does not certify unchanged content if post-read physical identity verification fails", async () => {
    const bytes = new Uint8Array([0x23, 0x20, 0xff]);
    const fs = fixture({ "main.ts": bytes });
    const inventory = createProductInventory({
      root: ROOT,
      fs,
      files: [accepted("main.ts", bytes)],
    });
    vi.spyOn(fs, "realPath")
      .mockResolvedValueOnce(`${ROOT}/main.ts`)
      .mockRejectedValueOnce(new Error("Post-read identity unavailable"));
    expect(await readFreshProductFile(inventory, "main.ts")).toEqual({
      status: "unreadable",
      contentHash: hash(bytes),
    });
  });

  it.each(["AbortError", "JOB_CANCELLED"])(
    "propagates port %s with an active caller signal",
    async (kind) => {
      const fs = fixture({ "main.ts": SOURCE });
      const inventory = await collectProductInventory({ root: ROOT, fs });
      const controller = new AbortController();
      const reason = Object.assign(
        new Error("Port cancelled"),
        kind === "AbortError" ? { name: kind } : { code: kind },
      );
      vi.spyOn(fs, "readFile").mockRejectedValue(reason);
      await expect(readFreshProductFile(inventory, "main.ts", controller.signal)).rejects.toBe(
        reason,
      );
      expect(controller.signal.aborted).toBe(false);
    },
  );

  it("passes the signal to ports and preserves cancellation after a successful read", async () => {
    const fs = fixture({ "main.ts": SOURCE });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    const controller = new AbortController();
    const reason = new Error("Stop after read");
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      expect(options?.signal).toBe(controller.signal);
      const bytes = await original(file, options);
      controller.abort(reason);
      return bytes;
    });
    await expect(readFreshProductFile(inventory, "main.ts", controller.signal)).rejects.toBe(
      reason,
    );
  });
});

describe("full-file product code measurement", () => {
  it("includes a private helper and reports all three readings with actual SLOC", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": SOURCE }),
    });
    const result = (await measureProductFiles(inventory, ["main.ts"])).get("main.ts");
    expect(result?.evidence).toEqual({
      path: "main.ts",
      status: "measured",
      contentHash: hash(SOURCE),
    });
    expect(result?.metrics).toMatchObject({
      files: 1,
      scopes: 3,
      executionUnitRoots: 2,
      sloc: 8,
      cognitive: { self: 2, execution_unit: 2, top_level: 4 },
      cyclomaticClassic: { self: 5, execution_unit: 5, top_level: 3 },
      cyclomaticExtended: { self: 5, execution_unit: 5, top_level: 3 },
      cyclomaticPerScopeBase: 1,
    });
    expect(result?.hotspots.map((hotspot) => hotspot.symbol)).toEqual(["feature", "helper"]);
    expect(result?.hotspots.every((hotspot) => hotspot.contentHash === hash(SOURCE))).toBe(true);
  });

  it("keeps nested closures visible without adding their inclusive values twice", async () => {
    const text =
      "export function outer(value: boolean) {\n  return () => { if (value) return 1; return 0; };\n}\n";
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": text }),
    });
    const result = (await measureProductFiles(inventory, ["main.ts"])).get("main.ts");
    expect(result?.evidence.status).toBe("measured");
    expect(result?.metrics).toMatchObject({
      scopes: 3,
      executionUnitRoots: 1,
      cognitive: { self: 1, execution_unit: 2, top_level: 3 },
    });
    expect(result?.hotspots).toHaveLength(2);
    expect(result?.hotspots.reduce((sum, hotspot) => sum + hotspot.cognitive, 0)).toBeGreaterThan(
      result?.metrics?.cognitive.execution_unit ?? Infinity,
    );
  });

  it("parses normalized duplicate file selections once", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": SOURCE }),
    });
    const { native, registry } = alteredRegistry({});
    const parse = vi.fn(native.parse);
    registry.register({ ...native, parse });
    const measurements = await measureProductFiles(inventory, ["main.ts", "./main.ts", "main.ts"], {
      parserRegistry: registry,
    });
    expect([...measurements.keys()]).toEqual(["main.ts"]);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret text-only formats or invent metrics for unsupported sources", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "vision.md": "# Vision", "settings.json": "{}", "file.unknown": "plain text" }),
    });
    expect(inventory.files.every((file) => !isProductCodeFile(file))).toBe(true);
    const measured = await measureProductFiles(
      inventory,
      inventory.files.map((file) => file.relativePath),
    );
    expect(
      [...measured.values()].every(
        (file) =>
          file.evidence.status === "unsupported" &&
          file.metrics === null &&
          file.hotspots.length === 0,
      ),
    ).toBe(true);
  });

  it("does not count a partial AST as zero or expose its unreliable hotspots", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "broken.ts": "export function broken( {" }),
    });
    const measured = await measureProductFiles(inventory, ["broken.ts"]);
    expect(measured.get("broken.ts")).toMatchObject({
      evidence: { status: "partial" },
      metrics: null,
      hotspots: [],
    });
    expect(aggregateProductMeasurements(["broken.ts"], measured)).toBeNull();
  });

  it("classifies ordinary parser failure as unavailable evidence", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": SOURCE }),
    });
    const { registry } = alteredRegistry({
      parse: () => {
        throw new Error("Native parser unavailable");
      },
    });
    const measured = await measureProductFiles(inventory, ["main.ts"], {
      parserRegistry: registry,
    });
    expect(measured.get("main.ts")).toMatchObject({
      evidence: { status: "partial" },
      metrics: null,
      hotspots: [],
    });
  });

  it("refuses metrics with residual same-range scope ID collisions", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": SOURCE }),
    });
    const { native, registry } = alteredRegistry({});
    registry.register({
      ...native,
      computeComplexity: (ast) => {
        const facts = native.computeComplexity(ast);
        const root = facts.symbolScopes[0];
        if (root === undefined) throw new Error("No native root");
        return {
          ...facts,
          symbolScopes: [
            ...facts.symbolScopes,
            { ...root, symbolScopeId: "duplicate-root", name: "duplicate-root" },
          ],
        };
      },
    });
    const measured = await measureProductFiles(inventory, ["main.ts"], {
      parserRegistry: registry,
    });
    expect(measured.get("main.ts")).toMatchObject({
      evidence: { status: "invalid_metrics" },
      metrics: null,
      hotspots: [],
    });
  });

  it("preserves all callbacks after raw scope identity repair and reports the limitation", async () => {
    const text =
      "run(() => { register(() => { if (a) return 1; return 0; }); });\nrun(() => { register(() => { if (b) return 2; return 0; }); });\n";
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": text }),
    });
    const measured = (await measureProductFiles(inventory, ["main.ts"])).get("main.ts");
    expect(measured?.evidence.status).toBe("measured");
    expect(measured?.metrics).toMatchObject({ scopes: 5, executionUnitRoots: 2 });
    expect(measured?.hotspots).toHaveLength(4);
    expect(new Set(measured?.hotspots.map((hotspot) => hotspot.scopeId)).size).toBe(4);
    expect(measured?.limitations?.join("\n")).toContain("colliding raw adapter scope IDs");
  });

  it("withholds measurements when the source changes during parsing", async () => {
    const fs = fixture({ "main.ts": SOURCE });
    const inventory = await collectProductInventory({ root: ROOT, fs });
    const { native, registry } = alteredRegistry({});
    registry.register({
      ...native,
      parse: (source) => {
        const parsed = native.parse(source);
        fs.seedFile(`${ROOT}/main.ts`, "export const changed = 1;");
        return parsed;
      },
    });
    const measured = await measureProductFiles(inventory, ["main.ts"], {
      parserRegistry: registry,
    });
    expect(measured.get("main.ts")).toMatchObject({
      evidence: {
        status: "changed",
        contentHash: hash("export const changed = 1;"),
        scannedContentHash: hash(SOURCE),
      },
      metrics: null,
      hotspots: [],
    });
  });

  it("propagates cancellation initiated by the synchronous parser", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": SOURCE }),
    });
    const controller = new AbortController();
    const reason = new Error("Parser cancelled");
    const { native, registry } = alteredRegistry({});
    registry.register({
      ...native,
      parse: (source) => {
        const parsed = native.parse(source);
        controller.abort(reason);
        return parsed;
      },
    });
    await expect(
      measureProductFiles(inventory, ["main.ts"], {
        parserRegistry: registry,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("keeps union metrics unique across features sharing code and refuses missing members", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "a.ts": SOURCE, "b.ts": SOURCE, "shared.ts": SOURCE }),
    });
    const measured = await measureProductFiles(inventory, ["a.ts", "b.ts", "shared.ts"]);
    const first = aggregateProductMeasurements(["a.ts", "shared.ts"], measured);
    const second = aggregateProductMeasurements(["b.ts", "shared.ts"], measured);
    const union = aggregateProductMeasurements(
      ["a.ts", "shared.ts", "b.ts", "shared.ts"],
      measured,
    );
    expect(first?.files).toBe(2);
    expect(second?.files).toBe(2);
    expect(union).toMatchObject({
      files: 3,
      scopes: 9,
      sloc: 24,
      cognitive: { self: 6, execution_unit: 6, top_level: 12 },
    });
    expect((first?.cognitive.self ?? 0) + (second?.cognitive.self ?? 0)).toBeGreaterThan(
      union?.cognitive.self ?? Infinity,
    );
    expect(aggregateProductMeasurements(["a.ts", "missing.ts"], measured)).toBeNull();
    expect(aggregateProductMeasurements([], measured)).toMatchObject({
      files: 0,
      scopes: 0,
      sloc: 0,
      cognitive: { self: 0, execution_unit: 0, top_level: 0 },
    });
  });

  it("refuses mixed metric versions rather than combining incomparable measurements", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: fixture({ "main.ts": SOURCE }),
    });
    const measured = await measureProductFiles(inventory, ["main.ts"]);
    const entry = measured.get("main.ts");
    if (entry?.metrics === undefined || entry.metrics === null)
      throw new Error("Expected measured source");
    entry.metrics.metricsVersion = "different-version";
    expect(aggregateProductMeasurements(["main.ts"], measured)).toBeNull();
  });
});
