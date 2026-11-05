import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductFeatureManifestV1, ProductTestEvidenceV1 } from "@untangle-code/domain";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectProductInventory, measureProductFiles, readFreshProductFile } from "./analysis.js";
import { analyzeProductAlignment } from "./report.js";

const ROOT = "/project";
const MANIFEST = ".untangle/features.json";
const LIMIT = 5 * 1024 * 1024;
const directories: string[] = [];
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

function manifest(id = "lookup"): ProductFeatureManifestV1 {
  return {
    schemaVersion: 1,
    owners: [
      {
        id: "accounts",
        label: "Accounts",
        kind: "team",
        status: "declared",
        sources: [{ path: "vision.md", heading: "Ownership" }],
      },
    ],
    features: [
      {
        id,
        title: "Lookup",
        stage: "implemented",
        review: "proposed",
        intent: [
          { role: "vision", path: "vision.md", heading: "Intent" },
          { role: "specification", path: "spec.md", heading: "Contract" },
        ],
        owners: ["accounts"],
        code: { include: ["src/lookup.ts"] },
        tests: { include: ["src/lookup.test.ts"] },
        criteria: [{ id: "lookup", description: "Lookup works", tests: ["src/lookup.test.ts"] }],
        dependsOn: [],
      },
    ],
  };
}

function project(): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock());
  fs.seedFile(`${ROOT}/vision.md`, "# Intent\nFind accounts.\n# Ownership\nAccounts team.\n");
  fs.seedFile(`${ROOT}/spec.md`, "# Contract\nLookup an account.\n");
  fs.seedFile(
    `${ROOT}/src/lookup.ts`,
    "export function lookup(value: number) { if (value > 0) return value; return 0; }\n",
  );
  fs.seedFile(`${ROOT}/src/lookup.test.ts`, "export const lookupTest = true;\n");
  fs.seedFile(`${ROOT}/${MANIFEST}`, JSON.stringify(manifest()));
  return fs;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("feature manifests stored as root-owned control metadata", () => {
  it("loads an explicit metadata manifest with complete code and test metrics without promoting ownership", async () => {
    const fs = project();
    const before = await collectProductInventory({ root: ROOT, fs });
    const testEvidence: ProductTestEvidenceV1 = {
      schemaVersion: 1,
      sourceTreeBefore: before.sourceTreeDigest,
      sourceTreeAfter: before.sourceTreeDigest,
      command: ["vitest", "run"],
      exitCode: 0,
      tests: [{ path: "src/lookup.test.ts", name: "Lookup works", status: "passed" }],
    };
    fs.seedFile(`${ROOT}/.untangle/evidence.json`, JSON.stringify(testEvidence));
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs,
      manifestPath: MANIFEST,
      testEvidencePath: ".untangle/evidence.json",
    });
    expect(report.manifest).toEqual({
      path: MANIFEST,
      status: "loaded",
      contentHash: hash(JSON.stringify(manifest())),
    });
    expect(report.status).toBe("needs_review");
    expect(report.sourceTreeDigest).toBe(before.sourceTreeDigest);
    expect(report.inventory.files).toBe(4);
    expect(report.features[0]?.code).toMatchObject({ complete: true, metrics: { files: 1 } });
    expect(report.features[0]?.tests).toMatchObject({ complete: true, metrics: { files: 1 } });
    expect(report.features[0]?.intent.every((source) => source.status === "resolved")).toBe(true);
    expect(report.features[0]?.ownership[0]?.status).toBe("declared");
    expect(report.features[0]?.review).toBe("proposed");
    expect(report.features[0]?.testEvidence.status).toBe("bound_passed");
    expect(report.features[0]?.criteria[0]?.status).toBe("passed");
    expect(report.coverage.mappedCodeFiles).toBe(1);
    expect(report.coverage.unmappedCodeFileCount).toBe(0);
    expect((await collectProductInventory({ root: ROOT, fs })).files).toEqual(before.files);
  });

  it("uses metadata only when the default legacy manifest is absent", async () => {
    const fs = project();
    const metadata = await analyzeProductAlignment({ root: ROOT, fs });
    expect(metadata.manifest).toMatchObject({ path: MANIFEST, status: "loaded" });
    expect(metadata.features[0]?.id).toBe("lookup");
    fs.seedFile(`${ROOT}/untangle.features.json`, JSON.stringify(manifest("legacy")));
    const legacy = await analyzeProductAlignment({ root: ROOT, fs });
    expect(legacy.manifest).toMatchObject({ path: "untangle.features.json", status: "loaded" });
    expect(legacy.features[0]?.id).toBe("legacy");
    const explicit = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
    expect(explicit.features[0]?.id).toBe("lookup");
  });

  it("retains the original missing-manifest contract when both default files are absent", async () => {
    const fs = project();
    await fs.remove(`${ROOT}/${MANIFEST}`);
    const report = await analyzeProductAlignment({ root: ROOT, fs });
    expect(report.status).toBe("needs_manifest");
    expect(report.manifest).toEqual({ path: "untangle.features.json", status: "missing" });
    expect(report.features).toEqual([]);
  });

  it.each(["{", '{"schemaVersion":99}'])(
    "keeps invalid legacy JSON authoritative: %s",
    async (text) => {
      const fs = project();
      fs.seedFile(`${ROOT}/untangle.features.json`, text);
      const report = await analyzeProductAlignment({ root: ROOT, fs });
      expect(report.status).toBe("invalid_manifest");
      expect(report.manifest).toMatchObject({ path: "untangle.features.json", status: "invalid" });
      expect(report.features).toEqual([]);
    },
  );

  it("does not replace an explicitly missing path with an existing metadata default", async () => {
    const report = await analyzeProductAlignment({
      root: ROOT,
      fs: project(),
      manifestPath: "missing.json",
    });
    expect(report.status).toBe("needs_manifest");
    expect(report.manifest).toEqual({ path: "missing.json", status: "missing" });
  });

  it("does not bypass an unreadable legacy path or read its metadata fallback", async () => {
    const fs = project();
    fs.seedDirectory(`${ROOT}/untangle.features.json`);
    const reads = vi.spyOn(fs, "readFile");
    const report = await analyzeProductAlignment({ root: ROOT, fs });
    expect(report.manifest).toEqual({ path: "untangle.features.json", status: "not_in_scan" });
    expect(report.features).toEqual([]);
    expect(reads.mock.calls.some(([file]) => file === `${ROOT}/${MANIFEST}`)).toBe(false);
  });

  it("keeps ignored non-metadata manifests outside the accepted inventory", async () => {
    const fs = project();
    fs.seedFile(`${ROOT}/.gitignore`, "ignored.json\n");
    fs.seedFile(`${ROOT}/ignored.json`, JSON.stringify(manifest()));
    const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: "ignored.json" });
    expect(report.manifest.status).toBe("not_in_scan");
    expect(report.features).toEqual([]);
  });

  it("does not expose metadata as source, test, intent or ownership evidence", async () => {
    const fs = project();
    fs.seedFile(`${ROOT}/.untangle/hidden.ts`, "export const hidden = true;");
    fs.seedFile(`${ROOT}/.untangle/intent.md`, "# Hidden\nControl metadata.\n");
    const input = manifest();
    input.features[0]!.code.include.push(".untangle/hidden.ts");
    input.features[0]!.tests.include.push(".untangle/hidden.ts");
    input.features[0]!.intent.push({
      role: "vision",
      path: ".untangle/intent.md",
      heading: "Hidden",
    });
    input.owners[0]!.sources.push({ path: ".untangle/intent.md", heading: "Hidden" });
    fs.seedFile(`${ROOT}/${MANIFEST}`, JSON.stringify(input));
    const inventory = await collectProductInventory({ root: ROOT, fs });
    expect(await readFreshProductFile(inventory, MANIFEST)).toEqual({ status: "not_in_scan" });
    const measurements = await measureProductFiles(inventory, [".untangle/hidden.ts"]);
    expect(measurements.get(".untangle/hidden.ts")).toMatchObject({
      evidence: { status: "not_in_scan" },
      metrics: null,
    });
    const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
    expect(report.features[0]?.code.complete).toBe(false);
    expect(report.features[0]?.tests.complete).toBe(false);
    expect(report.features[0]?.intent.at(-1)?.status).toBe("not_in_scan");
    expect(report.features[0]?.ownership[0]?.sources.at(-1)?.status).toBe("not_in_scan");
    expect(report.coverage.mappedCodeFiles).toBe(1);
  });

  it("keeps source digests and test bindings stable when local metadata is written", async () => {
    const fs = project();
    const inventory = await collectProductInventory({ root: ROOT, fs });
    const testEvidence: ProductTestEvidenceV1 = {
      schemaVersion: 1,
      sourceTreeBefore: inventory.sourceTreeDigest,
      sourceTreeAfter: inventory.sourceTreeDigest,
      command: ["vitest", "run"],
      exitCode: 0,
      tests: [{ path: "src/lookup.test.ts", name: "Lookup works", status: "passed" }],
    };
    const options = { root: ROOT, fs, manifestPath: MANIFEST, testEvidence };
    const before = await analyzeProductAlignment(options);
    fs.seedFile(`${ROOT}/.untangle/indices/new.json`, '{"revision":2}');
    fs.seedFile(`${ROOT}/.untangle/reports/product.json`, JSON.stringify(before));
    const changed = manifest();
    changed.features[0]!.title = "Current lookup declaration";
    fs.seedFile(`${ROOT}/${MANIFEST}`, JSON.stringify(changed));
    const after = await analyzeProductAlignment(options);
    expect(after.sourceTreeDigest).toBe(before.sourceTreeDigest);
    expect(after.manifest.contentHash).not.toBe(before.manifest.contentHash);
    expect(after.features[0]?.code.metrics).toEqual(before.features[0]?.code.metrics);
    expect(after.features[0]?.tests.metrics).toEqual(before.features[0]?.tests.metrics);
    expect(after.features[0]?.title).toBe("Current lookup declaration");
    expect(before.features[0]?.testEvidence.status).toBe("bound_passed");
    expect(after.features[0]?.testEvidence.status).toBe("bound_passed");
  });

  it.each(["{", '{"schemaVersion":99}', "\u0000"])(
    "rejects malformed metadata manifests: %j",
    async (text) => {
      const fs = project();
      fs.seedFile(`${ROOT}/${MANIFEST}`, text);
      const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
      expect(report.status).toBe("invalid_manifest");
      expect(report.manifest.status).toBe("invalid");
      expect(report.features).toEqual([]);
    },
  );

  it.each(["../outside/features.json", "/outside/features.json"])(
    "rejects outside-root control paths before reading them: %s",
    async (manifestPath) => {
      const fs = project();
      fs.seedFile("/outside/features.json", JSON.stringify(manifest()));
      const reads = vi.spyOn(fs, "readFile");
      const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath });
      expect(report.status).toBe("invalid_manifest");
      expect(reads.mock.calls.some(([file]) => file.startsWith("/outside/"))).toBe(false);
    },
  );

  it("does not read an external metadata file symlink", async () => {
    const fs = project();
    fs.seedFile("/outside/features.json", JSON.stringify(manifest()));
    fs.seedSymlink(`${ROOT}/${MANIFEST}`, "/outside/features.json");
    const reads = vi.spyOn(fs, "readFile");
    const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
    expect(report.manifest.status).toBe("not_in_scan");
    expect(report.features).toEqual([]);
    expect(reads.mock.calls.some(([file]) => file.startsWith("/outside/"))).toBe(false);
  });

  it("rejects a real external metadata directory symlink", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "untangle-external-metadata-"));
    directories.push(directory);
    const root = path.join(directory, "project");
    const outside = path.join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "features.json"), JSON.stringify(manifest()));
    await symlink(outside, path.join(root, ".untangle"), "dir");
    const report = await analyzeProductAlignment({ root, manifestPath: MANIFEST });
    expect(report.manifest.status).toBe("not_in_scan");
    expect(report.features).toEqual([]);
  });

  it("rejects directories, invalid UTF-8 and files larger than the established read budget", async () => {
    for (const contents of [null, new Uint8Array([0xff, 0xfe, 0x23, 0]), " ".repeat(LIMIT + 1)]) {
      const fs = project();
      await fs.remove(`${ROOT}/${MANIFEST}`);
      if (contents === null) fs.seedDirectory(`${ROOT}/${MANIFEST}`);
      else fs.seedFile(`${ROOT}/${MANIFEST}`, contents);
      const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
      expect(report.manifest.status).toBe("unreadable");
      expect(report.features).toEqual([]);
    }
  });

  it("rejects a control file which grows beyond the budget after stat", async () => {
    const fs = project();
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) =>
      file === `${ROOT}/${MANIFEST}`
        ? new TextEncoder().encode(" ".repeat(LIMIT + 1))
        : readFile(file, options),
    );
    const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
    expect(report.manifest.status).toBe("unreadable");
    expect(report.features).toEqual([]);
  });

  it("detects a metadata symlink retargeted while its bytes are read", async () => {
    const fs = project();
    fs.seedFile(`${ROOT}/.untangle/other.json`, JSON.stringify(manifest()));
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await readFile(file, options);
      if (file === `${ROOT}/${MANIFEST}`)
        fs.seedSymlink(`${ROOT}/${MANIFEST}`, `${ROOT}/.untangle/other.json`);
      return bytes;
    });
    const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
    expect(report.manifest.status).toBe("changed");
    expect(report.features).toEqual([]);
  });

  it.each(["content", "physical identity"])(
    "invalidates an initially loaded manifest when its %s changes during analysis",
    async (change) => {
      const fs = project();
      fs.seedFile(`${ROOT}/.untangle/other.json`, JSON.stringify(manifest()));
      const readFile = fs.readFile.bind(fs);
      let manifestWasRead = false;
      vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
        const bytes = await readFile(file, options);
        if (file === `${ROOT}/${MANIFEST}`) manifestWasRead = true;
        if (manifestWasRead && file === `${ROOT}/src/lookup.ts`) {
          if (change === "content")
            fs.seedFile(`${ROOT}/${MANIFEST}`, JSON.stringify(manifest("replacement")));
          else fs.seedSymlink(`${ROOT}/${MANIFEST}`, `${ROOT}/.untangle/other.json`);
        }
        return bytes;
      });
      const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
      expect(report.status).toBe("incomplete");
      expect(report.manifest.status).toBe("changed");
      expect(report.features[0]?.code.complete).toBe(false);
      expect(report.features[0]?.code.metrics).toBeNull();
      expect(report.coverage.mappedCodeUnion).toBeNull();
      expect(fs.readFile).not.toHaveBeenCalledWith(
        `${ROOT}/.untangle/other.json`,
        expect.anything(),
      );
    },
  );

  it("checks manifest freshness after the final source inventory scan", async () => {
    const fs = project();
    const readFile = fs.readFile.bind(fs);
    const readDir = fs.readDir.bind(fs);
    let manifestWasRead = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await readFile(file, options);
      if (file === `${ROOT}/${MANIFEST}`) manifestWasRead = true;
      return bytes;
    });
    vi.spyOn(fs, "readDir").mockImplementation(async (directory, options) => {
      const entries = await readDir(directory, options);
      if (manifestWasRead) fs.seedFile(`${ROOT}/${MANIFEST}`, JSON.stringify(manifest("changed")));
      return entries;
    });
    const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
    expect(report.manifest.status).toBe("changed");
    expect(report.status).toBe("incomplete");
    expect(report.coverage.mappedCodeUnion).toBeNull();
  });

  it("allows a stable in-root metadata symlink without adding its control bytes to source inventory", async () => {
    const fs = project();
    fs.seedFile(`${ROOT}/.untangle/actual.json`, JSON.stringify(manifest()));
    fs.seedSymlink(`${ROOT}/${MANIFEST}`, `${ROOT}/.untangle/actual.json`);
    const inventory = await collectProductInventory({ root: ROOT, fs });
    const report = await analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST });
    expect(report.manifest.status).toBe("loaded");
    expect(report.features[0]?.code.complete).toBe(true);
    expect(report.sourceTreeDigest).toBe(inventory.sourceTreeDigest);
    expect(inventory.files.every((file) => !file.relativePath.startsWith(".untangle/"))).toBe(true);
  });

  it.each(["AbortError", "JOB_CANCELLED"])("preserves a metadata port %s", async (kind) => {
    const fs = project();
    const readFile = fs.readFile.bind(fs);
    const error = Object.assign(
      new Error("Metadata cancelled"),
      kind === "AbortError" ? { name: kind } : { code: kind },
    );
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (file === `${ROOT}/${MANIFEST}`) throw error;
      return readFile(file, options);
    });
    await expect(analyzeProductAlignment({ root: ROOT, fs, manifestPath: MANIFEST })).rejects.toBe(
      error,
    );
  });

  it("passes cancellation to metadata ports and checks after a successful read", async () => {
    const fs = project();
    const controller = new AbortController();
    const reason = new Error("Stop after control read");
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await readFile(file, options);
      if (file === `${ROOT}/${MANIFEST}`) {
        expect(options?.signal).toBe(controller.signal);
        controller.abort(reason);
      }
      return bytes;
    });
    await expect(
      analyzeProductAlignment({
        root: ROOT,
        fs,
        manifestPath: MANIFEST,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it.each(["relative", "alias absolute", "canonical absolute"])(
    "reads %s metadata through a real selected-root alias",
    async (mode) => {
      const directory = await mkdtemp(path.join(tmpdir(), "untangle-metadata-manifest-"));
      directories.push(directory);
      const root = path.join(directory, "project");
      await mkdir(path.join(root, ".untangle"), { recursive: true });
      const canonical = await realpath(root);
      await writeFile(
        path.join(root, MANIFEST),
        JSON.stringify({ schemaVersion: 1, owners: [], features: [] }),
      );
      const alias = path.join(directory, "alias");
      await symlink(canonical, alias, "dir");
      const manifestPath =
        mode === "relative"
          ? MANIFEST
          : path.join(mode === "alias absolute" ? alias : canonical, MANIFEST);
      const report = await analyzeProductAlignment({ root: alias, manifestPath });
      expect(report.root).toBe(canonical);
      expect(report.manifest).toMatchObject({ path: MANIFEST, status: "loaded" });
      expect(report.inventory.files).toBe(0);
    },
  );
});
