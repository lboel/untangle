import { createHash } from "node:crypto";

import type { PortCallOptions } from "@untangle-code/domain";
import { discoverFiles } from "@untangle-code/scanner";
import type { ScannedFileV1 } from "@untangle-code/scanner";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { assessProductContext } from "./product-context.js";
import type { AssessProductContextInputV1 } from "./product-context.js";

const ROOT = "/workspace/project";

function fixture(contents: Readonly<Record<string, string | Uint8Array>>): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock(100));
  fs.seedDirectory(ROOT);
  for (const [relativePath, content] of Object.entries(contents)) {
    fs.seedFile(`${ROOT}/${relativePath}`, content);
  }
  return fs;
}

async function scan(fs: MemoryFileSystem): Promise<ScannedFileV1[]> {
  const files: ScannedFileV1[] = [];
  for await (const file of discoverFiles({ fs, roots: [ROOT], repoRoot: ROOT })) files.push(file);
  return files;
}

async function assess(
  fs: MemoryFileSystem,
  options: Omit<Partial<AssessProductContextInputV1>, "fs" | "root"> = {},
) {
  const files = options.files ?? (await scan(fs));
  return assessProductContext({ fs, root: ROOT, files, inventoryTruncated: false, ...options });
}

function hash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function acceptedBytes(relativePath: string, content: Uint8Array): ScannedFileV1 {
  return {
    relativePath,
    absolutePath: `${ROOT}/${relativePath}`,
    contentHash: hash(content),
    sizeBytes: content.byteLength,
    mtimeEpochMs: 100,
    languageId: "markdown",
    languageDetectedBy: "extension",
    isMinified: false,
    encoding: "unknown",
    hasBom: false,
  };
}

describe("product context source binding", () => {
  it("binds required documents in role order while leaving features and ownership unverified", async () => {
    const vision = "# Vision\nMake local code review useful.\n";
    const spec = "# Requirements\n## Search\nFind symbols.\n";
    const fs = fixture({ "VISION.md": vision, "docs/Requirements.MARKDOWN": spec });
    const result = await assess(fs);

    expect(result.status).toBe("ready_for_review");
    expect(result.sources).toEqual([
      {
        role: "vision",
        path: "VISION.md",
        contentHash: hash(vision),
        status: "readable",
        selected: true,
        selection: "filename_candidate",
        sections: [{ title: "Vision", startLine: 1, endLine: 3 }],
      },
      {
        role: "specification",
        path: "docs/Requirements.MARKDOWN",
        contentHash: hash(spec),
        status: "readable",
        selected: true,
        selection: "filename_candidate",
        sections: [
          { title: "Requirements", startLine: 1, endLine: 1 },
          { title: "Requirements › Search", startLine: 2, endLine: 4 },
        ],
      },
    ]);
    expect(result.missingRoles).toEqual([]);
    expect(result.ambiguousRoles).toEqual([]);
    expect(result.referencesTruncated).toBe(false);
    expect(result.alignment).toEqual({
      status: "unverified",
      reason: "feature_and_ownership_not_confirmed",
    });
    expect(result.reviewDraft.features).toEqual([]);
    expect(result.reviewDraft.ownership).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Make local code review useful");
  });

  it("reports missing vision/specification without treating optional product documentation as required", async () => {
    const fs = fixture({ "main.ts": "export const main = true;\n" });
    const writes = vi.spyOn(fs, "writeFile");
    const result = await assess(fs);
    expect(result.status).toBe("needs_context");
    expect(result.missingRoles).toEqual(["vision", "specification"]);
    expect(result.sources).toEqual([]);
    expect(result.reviewDraft.questions.join("\n")).toContain("authoritative vision");
    expect(writes).not.toHaveBeenCalled();
  });

  it("does not choose between multiple filename candidates", async () => {
    const result = await assess(
      fixture({ "vision.md": "# Vision", "docs/spec.md": "# A", "specification.md": "# B" }),
    );
    expect(result.status).toBe("needs_selection");
    expect(result.ambiguousRoles).toEqual(["specification"]);
    expect(result.sources.filter((source) => source.role === "specification")).toMatchObject([
      { path: "docs/spec.md", status: "readable", selected: false },
      { path: "specification.md", status: "readable", selected: false },
    ]);
    expect(result.reviewDraft.questions.join("\n")).toContain("takes precedence");
  });

  it("explicit custom documents override ambiguous filename selection without hiding other candidates", async () => {
    const fs = fixture({
      "vision.md": "# Candidate",
      "vision-future.md": "# Other",
      "spec.md": "# Candidate",
      "planning/north-star.md": "# Intent",
      "planning/contract.md": "# Contract",
    });
    const result = await assess(fs, {
      visionPath: "planning/../planning/north-star.md",
      specPath: "planning\\contract.md",
    });
    expect(result.status).toBe("ready_for_review");
    expect(result.ambiguousRoles).toEqual([]);
    expect(
      result.sources
        .filter((source) => source.selected)
        .map(({ role, path, selection }) => ({ role, path, selection })),
    ).toEqual([
      { role: "vision", path: "planning/north-star.md", selection: "explicit" },
      { role: "specification", path: "planning/contract.md", selection: "explicit" },
    ]);
    expect(result.sources).toHaveLength(5);
  });

  it("reads a document shared by explicit roles once and retains both bindings", async () => {
    const fs = fixture({ "planning.md": "# Joint intent and specification" });
    const files = await scan(fs);
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, {
      files,
      visionPath: "planning.md",
      specPath: "planning.md",
      maxDocuments: 1,
    });
    expect(result.status).toBe("ready_for_review");
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.selected)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("optional product ambiguity stays visible without blocking selected required sources", async () => {
    const result = await assess(
      fixture({
        "vision.md": "# Intent",
        "spec.md": "# Contract",
        "PRD.md": "# PRD",
        "product-overview.mdx": "# Product",
      }),
    );
    expect(result.status).toBe("ready_for_review");
    expect(result.ambiguousRoles).toEqual(["product"]);
    expect(
      result.sources
        .filter((source) => source.role === "product")
        .every((source) => !source.selected),
    ).toBe(true);
  });

  it("an empty required document cannot become a selected authority", async () => {
    const result = await assess(fixture({ "vision.md": " \r\n\t", "spec.md": "# Contract" }));
    expect(result.status).toBe("needs_context");
    expect(result.sources[0]).toMatchObject({
      role: "vision",
      status: "empty",
      selected: false,
      contentHash: hash(" \r\n\t"),
      sections: [],
    });
    expect(result.missingRoles).toEqual([]);
  });

  it("keeps complete candidate metadata beyond the read limit and prioritizes explicit required sources", async () => {
    const fs = fixture({
      "product.md": "# Product",
      "vision.md": "# Candidate",
      "spec.md": "# Candidate",
      "z-intent.md": "# Intent",
    });
    const files = await scan(fs);
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, { files, visionPath: "z-intent.md", maxDocuments: 1 });
    expect(result.status).toBe("incomplete");
    expect(result.sources).toHaveLength(4);
    expect(result.sources.find((source) => source.path === "z-intent.md")).toMatchObject({
      selected: true,
      status: "readable",
      selection: "explicit",
    });
    expect(
      result.sources
        .filter((source) => source.path !== "z-intent.md")
        .every(
          (source) =>
            source.status === "not_assessed" &&
            !source.selected &&
            source.contentHash === undefined,
        ),
    ).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(result.limitations.join("\n")).toContain("document limit of 1");
  });

  it("accepts a zero document budget without reading or silently dropping candidates", async () => {
    const fs = fixture({ "vision.md": "# Intent", "spec.md": "# Contract" });
    const files = await scan(fs);
    const reads = vi.spyOn(fs, "readFile");
    const paths = vi.spyOn(fs, "realPath");
    const result = await assess(fs, { files, maxDocuments: 0 });
    expect(result.status).toBe("incomplete");
    expect(result.sources).toHaveLength(2);
    expect(
      result.sources.every((source) => source.status === "not_assessed" && !source.selected),
    ).toBe(true);
    expect(result.missingRoles).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(paths).not.toHaveBeenCalled();
  });

  it("uses the hard default ceiling of 32 while preserving all discovered candidates", async () => {
    const contents: Record<string, string> = { "vision.md": "# Intent", "spec.md": "# Contract" };
    for (let index = 0; index < 33; index += 1)
      contents[`product-${String(index).padStart(2, "0")}.md`] = "# Product";
    const fs = fixture(contents);
    const files = await scan(fs);
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, { files });
    expect(result.status).toBe("incomplete");
    expect(result.sources).toHaveLength(35);
    expect(result.sources.filter((source) => source.status === "not_assessed")).toHaveLength(3);
    expect(reads).toHaveBeenCalledTimes(32);
    expect(result.sources.filter((source) => source.selected).map((source) => source.role)).toEqual(
      ["vision", "specification"],
    );
  });

  it.each([-1, 33, 0.5, Number.NaN])(
    "rejects an invalid document ceiling %s before I/O",
    async (maxDocuments) => {
      const fs = fixture({});
      const reads = vi.spyOn(fs, "readFile");
      await expect(assess(fs, { files: [], maxDocuments })).rejects.toThrow(RangeError);
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it("never asserts missing roles or unique filename authority from a truncated inventory", async () => {
    const fs = fixture({ "vision.md": "# Intent" });
    const result = await assess(fs, { inventoryTruncated: true });
    expect(result.status).toBe("incomplete");
    expect(result.missingRoles).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: "readable", selected: false });
    expect(result.limitations.join("\n")).toContain("inventory was truncated");
  });

  it("remains incomplete for truncated discovery even with both explicitly selected sources", async () => {
    const fs = fixture({ "intent.md": "# Intent", "contract.md": "# Contract" });
    const result = await assess(fs, {
      inventoryTruncated: true,
      visionPath: "intent.md",
      specPath: "contract.md",
    });
    expect(result.status).toBe("incomplete");
    expect(result.missingRoles).toEqual([]);
    expect(result.sources.every((source) => source.selected)).toBe(true);
  });
});

describe("product context accepted-scan boundaries", () => {
  it("does not bypass scanner ignores, even for explicitly requested documents", async () => {
    const fs = fixture({
      ".gitignore": "private/\n",
      "private/vision.md": "# Private",
      "spec.md": "# Contract",
      "node_modules/pkg/product.md": "# Vendored",
    });
    const files = await scan(fs);
    expect(files.map((file) => file.relativePath)).not.toContain("private/vision.md");
    const reads = vi.spyOn(fs, "readFile");
    const paths = vi.spyOn(fs, "realPath");
    const result = await assess(fs, { files, visionPath: "private/vision.md" });
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({
      path: "private/vision.md",
      status: "not_in_scan",
      selected: false,
      selection: "explicit",
    });
    expect(reads.mock.calls.map(([file]) => file)).toEqual([`${ROOT}/spec.md`]);
    expect(paths.mock.calls.map(([file]) => file)).toEqual([`${ROOT}/spec.md`]);
    expect(result.sources.some((source) => source.path.includes("node_modules"))).toBe(false);
  });

  it("reports a missing explicit path instead of inventing a source or reading it", async () => {
    const fs = fixture({ "spec.md": "# Contract" });
    const files = await scan(fs);
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, { files, visionPath: "missing.md" });
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toEqual({
      role: "vision",
      path: "missing.md",
      selection: "explicit",
      status: "not_in_scan",
      selected: false,
      sections: [],
    });
    expect(reads.mock.calls.some(([file]) => file.endsWith("missing.md"))).toBe(false);
  });

  it("rejects explicit root escapes and scanner entries whose physical path is outside", async () => {
    const fs = fixture({ "spec.md": "# Contract" });
    fs.seedFile("/workspace/outside.md", "# Outside");
    const files = await scan(fs);
    const invalid = {
      ...acceptedBytes("vision.md", new TextEncoder().encode("# Outside")),
      absolutePath: "/workspace/outside.md",
    };
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, { files: [...files, invalid], visionPath: "../outside.md" });
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({ path: "../outside.md", status: "not_in_scan" });
    expect(result.sources.some((source) => source.path === "vision.md")).toBe(false);
    expect(reads.mock.calls.map(([file]) => file)).toEqual([`${ROOT}/spec.md`]);
  });

  it("revalidates a source symlink changed after scanning instead of reading its old target", async () => {
    const fs = fixture({ "planning.md": "# Intent", "spec.md": "# Contract" });
    fs.seedSymlink(`${ROOT}/vision.md`, "planning.md");
    const files = await scan(fs);
    fs.seedFile("/workspace/outside.md", "# Outside");
    fs.seedSymlink(`${ROOT}/vision.md`, "/workspace/outside.md");
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, { files });
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({
      path: "vision.md",
      status: "not_in_scan",
      selected: false,
      sections: [],
    });
    expect(reads.mock.calls.map(([file]) => file)).toEqual([`${ROOT}/spec.md`]);
    expect(result.limitations.join("\n")).toContain("now resolves outside");
  });

  it("records actual and scanned hashes without interpreting a changed source", async () => {
    const original = "# Original intent";
    const changed = "# Changed intent\n[link](missing.md)";
    const fs = fixture({ "vision.md": original, "spec.md": "# Contract" });
    const files = await scan(fs);
    fs.seedFile(`${ROOT}/vision.md`, changed);
    const result = await assess(fs, { files });
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({
      status: "changed",
      contentHash: hash(changed),
      scannedContentHash: hash(original),
      selected: false,
      sections: [],
    });
    expect(result.references).toEqual([]);
  });

  it("reports ordinary read errors as incomplete without stopping other source assessment", async () => {
    const fs = fixture({ "vision.md": "# Intent", "spec.md": "# Contract" });
    const files = await scan(fs);
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((file, options) =>
      file.endsWith("vision.md") ? Promise.reject(new Error("EACCES")) : original(file, options),
    );
    const result = await assess(fs, { files });
    expect(result.status).toBe("incomplete");
    expect(result.sources).toMatchObject([
      { status: "unreadable", selected: false },
      { status: "readable", selected: true },
    ]);
    expect(result.sources[0]?.contentHash).toBeUndefined();
  });

  it("rejects an oversized source before a full content read", async () => {
    const fs = fixture({ "vision.md": "# Intent", "spec.md": "# Contract" });
    const files = await scan(fs);
    fs.seedFile(`${ROOT}/vision.md`, new Uint8Array(5 * 1024 * 1024 + 1).fill(65));
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, { files });
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]?.status).toBe("unreadable");
    expect(reads.mock.calls.map(([file]) => file)).toEqual([`${ROOT}/spec.md`]);
  });

  it("preserves BOM and CRLF raw hashes while ignoring fenced headings", async () => {
    const vision = "\uFEFF# Vision\r\n```md\r\n# Example\r\n```\r\n## Goal\r\nShip safely.\r\n";
    const result = await assess(fixture({ "vision.md": vision, "spec.md": "# Contract" }));
    expect(result.status).toBe("ready_for_review");
    expect(result.sources[0]?.contentHash).toBe(hash(vision));
    expect(result.sources[0]?.sections).toEqual([
      { title: "Vision", startLine: 1, endLine: 4 },
      { title: "Vision › Goal", startLine: 5, endLine: 7 },
    ]);
  });

  it("does not replace malformed UTF-8 with fabricated source text", async () => {
    const bytes = new Uint8Array([0x23, 0x20, 0xff, 0x0a]);
    const fs = fixture({ "vision.md": bytes });
    const result = await assess(fs, { files: [acceptedBytes("vision.md", bytes)] });
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({
      status: "unreadable",
      contentHash: hash(bytes),
      selected: false,
      sections: [],
    });
  });

  it.each(["utf16le", "utf16be"] as const)(
    "reports unsupported %s instead of inferring headings",
    async (encoding) => {
      const bytes = new Uint8Array([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x41, 0x00]);
      const fs = fixture({ "vision.md": bytes });
      const result = await assess(fs, {
        files: [{ ...acceptedBytes("vision.md", bytes), encoding }],
      });
      expect(result.status).toBe("incomplete");
      expect(result.sources[0]).toMatchObject({
        status: "unreadable",
        contentHash: hash(bytes),
        sections: [],
      });
      expect(result.limitations.join("\n")).toContain(`unsupported ${encoding}`);
    },
  );
});

describe("product context path reference evidence", () => {
  it("binds accepted file paths only and distinguishes missing, ignored, and outside references", async () => {
    const vision =
      "# Intent\n[code](../src/main.ts#nonexistent)\n[private](../private.md)\n[missing](missing.md)\n[escape](../../outside.md)\n";
    const fs = fixture({
      ".gitignore": "private.md\n",
      "docs/vision.md": vision,
      "spec.md": "# Contract",
      "src/main.ts": "export const main = true;",
      "private.md": "Private prose",
    });
    const result = await assess(fs);
    expect(result.status).toBe("ready_for_review");
    expect(result.references).toEqual([
      {
        sourcePath: "docs/vision.md",
        sourceLine: 2,
        targetPath: "src/main.ts",
        status: "present",
        targetContentHash: hash("export const main = true;"),
      },
      {
        sourcePath: "docs/vision.md",
        sourceLine: 3,
        targetPath: "private.md",
        status: "not_in_scan",
      },
      {
        sourcePath: "docs/vision.md",
        sourceLine: 4,
        targetPath: "docs/missing.md",
        status: "missing",
      },
      {
        sourcePath: "docs/vision.md",
        sourceLine: 5,
        targetPath: "../outside.md",
        status: "outside_workspace",
      },
    ]);
    expect(result.limitations.join("\n")).toContain(
      "anchors, features, behavior, and ownership remain unverified",
    );
    expect(result.reviewDraft.questions.join("\n")).toContain("unresolved document references");
  });

  it("decodes URI file parts without treating encoded root escapes as accepted paths", async () => {
    const fs = fixture({
      "docs/vision.md":
        "# Intent\n[star](North%20Star.md#not-confirmed)\n[escape](%2e%2e/%2e%2e/outside.md)\n[bad](broken%ZZ.md)",
      "docs/North Star.md": "A reference",
      "spec.md": "# Contract",
    });
    const files = await scan(fs);
    const stats = vi.spyOn(fs, "stat");
    const result = await assess(fs, { files });
    expect(result.references).toMatchObject([
      { targetPath: "docs/North Star.md", status: "present" },
      { targetPath: "../outside.md", status: "outside_workspace" },
      { targetPath: "docs/broken%ZZ.md", status: "not_in_scan" },
    ]);
    expect(result.limitations.join("\n")).toContain(
      "malformed URI path; no target path was inspected",
    );
    expect(
      stats.mock.calls
        .map(([file]) => file)
        .some((file) => file.includes("%ZZ") || file.includes("outside.md")),
    ).toBe(false);
  });

  it("never converts an absolute file reference into an existing relative decoy", async () => {
    const fs = fixture({
      "docs/vision.md": "# Intent\n[absolute](/tmp/file.md)",
      "docs/tmp/file.md": "Decoy",
      "spec.md": "# Contract",
    });
    const files = await scan(fs);
    const stats = vi.spyOn(fs, "stat");
    const result = await assess(fs, { files });
    expect(result.references).toEqual([
      {
        sourcePath: "docs/vision.md",
        sourceLine: 2,
        targetPath: "../../tmp/file.md",
        status: "outside_workspace",
      },
    ]);
    expect(stats.mock.calls.some(([file]) => file === "/tmp/file.md")).toBe(false);
  });

  it("marks a reference to a symlink escape outside without reading external content", async () => {
    const fs = fixture({ "vision.md": "# Intent\n[external](escape.md)", "spec.md": "# Contract" });
    fs.seedFile("/workspace/external.md", "External text");
    fs.seedSymlink(`${ROOT}/escape.md`, "/workspace/external.md");
    const files = await scan(fs);
    const reads = vi.spyOn(fs, "readFile");
    const result = await assess(fs, { files });
    expect(result.references).toMatchObject([
      { targetPath: "escape.md", status: "outside_workspace" },
    ]);
    expect(reads.mock.calls.some(([file]) => file === "/workspace/external.md")).toBe(false);
  });

  it("does not follow remote, anchor-only, or fenced links or recurse into linked documents", async () => {
    const fs = fixture({
      "vision.md":
        "# Intent\n[remote](https://example.invalid/spec.md)\n[anchor](#anything)\n[linked](notes.md)\n```md\n[fenced](missing.md)\n```",
      "spec.md": "# Contract",
      "notes.md": "[nested](unvisited.md)",
    });
    const files = await scan(fs);
    const reads = vi.spyOn(fs, "readFile");
    const stats = vi.spyOn(fs, "stat");
    const result = await assess(fs, { files });
    expect(result.references).toMatchObject([
      { sourceLine: 4, targetPath: "notes.md", status: "present" },
    ]);
    expect(reads.mock.calls.map(([file]) => file)).toEqual([
      `${ROOT}/vision.md`,
      `${ROOT}/spec.md`,
    ]);
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it("does not report truncation at exactly 256 local links, ignoring fenced and remote extras", async () => {
    const links = Array.from({ length: 256 }, () => "[code](main.ts)").join("\n");
    const result = await assess(
      fixture({
        "vision.md": `# Intent\n${links}\n[remote](https://example.invalid)\n~~~\n[example](overflow.md)\n~~~`,
        "spec.md": "# Contract",
        "main.ts": "export const main = true;",
      }),
    );
    expect(result.references).toHaveLength(256);
    expect(result.referencesTruncated).toBe(false);
    expect(result.status).toBe("ready_for_review");
  });

  it("stops reference I/O at 256 and marks incomplete only when a further local link exists", async () => {
    const links = Array.from(
      { length: 257 },
      (_, index) => `[missing](missing-${String(index)}.md)`,
    ).join("\n");
    const fs = fixture({ "vision.md": `# Intent\n${links}`, "spec.md": "# Contract" });
    const files = await scan(fs);
    const stats = vi.spyOn(fs, "stat");
    const result = await assess(fs, { files });
    expect(result.references).toHaveLength(256);
    expect(result.referencesTruncated).toBe(true);
    expect(result.status).toBe("incomplete");
    expect(stats.mock.calls.filter(([file]) => file.includes("missing-"))).toHaveLength(256);
    expect(result.limitations.join("\n")).toContain("exceeded the limit of 256");
  });

  it("returns identical evidence for a differently ordered accepted inventory", async () => {
    const fs = fixture({
      "vision.md": "# Intent\n[spec](spec.md)",
      "spec.md": "# Contract\n[code](a.ts)",
      "product.md": "# Product",
      "a.ts": "export const a = 1;",
    });
    const files = await scan(fs);
    expect(await assess(fs, { files: [...files].reverse() })).toEqual(await assess(fs, { files }));
  });
});

describe("product context Markdown parse budgets", () => {
  it("accepts a line at the 16,384 character ceiling", async () => {
    const result = await assess(
      fixture({ "vision.md": `# Intent\n${"x".repeat(16_384)}`, "spec.md": "# Contract" }),
    );
    expect(result.status).toBe("ready_for_review");
    expect(result.sources[0]?.status).toBe("readable");
  });

  it("does not interpret or select a very long malformed link line, while retaining its raw hash", async () => {
    const vision = `# Intent\n${"[".repeat(16_385)}\n[missing](missing.md)`;
    const result = await assess(fixture({ "vision.md": vision, "spec.md": "# Contract" }));
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({
      status: "not_assessed",
      selected: false,
      contentHash: hash(vision),
      sections: [],
    });
    expect(result.references).toEqual([]);
    expect(result.limitations.join("\n")).toContain("16,384 characters per line");
    expect(result.sources[1]?.status).toBe("readable");
  });

  it("accepts exactly 4,096 opening brackets across ordinary short lines", async () => {
    const result = await assess(
      fixture({
        "vision.md": `# Intent\n${"[unmatched\n".repeat(4_096)}`,
        "spec.md": "# Contract",
      }),
    );
    expect(result.status).toBe("ready_for_review");
    expect(result.sources[0]?.status).toBe("readable");
  });

  it("reports an opening bracket budget exceeded across multiple short lines", async () => {
    const vision = `# Intent\n${"[unmatched\n".repeat(4_097)}`;
    const result = await assess(fixture({ "vision.md": vision, "spec.md": "# Contract" }));
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({
      status: "not_assessed",
      selected: false,
      contentHash: hash(vision),
      sections: [],
    });
    expect(result.limitations.join("\n")).toContain("4,096 opening link brackets");
  });

  it("accepts exactly 2,048 actual heading candidates using the unchanged outline", async () => {
    const result = await assess(
      fixture({ "vision.md": "## Goal\n".repeat(2_048), "spec.md": "# Contract" }),
    );
    expect(result.status).toBe("ready_for_review");
    expect(result.sources[0]?.sections).toHaveLength(2_048);
  });

  it("reports excessive heading candidates conservatively even when they appear in a fence", async () => {
    const vision = `~~~md\n${"# Example\n".repeat(2_049)}~~~`;
    const result = await assess(fixture({ "vision.md": vision, "spec.md": "# Contract" }));
    expect(result.status).toBe("incomplete");
    expect(result.sources[0]).toMatchObject({
      status: "not_assessed",
      selected: false,
      contentHash: hash(vision),
      sections: [],
    });
    expect(result.limitations.join("\n")).toContain("2,048 heading candidates");
  });
});

describe("product context cancellation", () => {
  it("propagates a pre-aborted signal reason before any file I/O", async () => {
    const fs = fixture({});
    const controller = new AbortController();
    const reason = new Error("Caller stopped discovery");
    controller.abort(reason);
    const reads = vi.spyOn(fs, "readFile");
    const paths = vi.spyOn(fs, "realPath");
    await expect(assess(fs, { files: [], signal: controller.signal })).rejects.toBe(reason);
    expect(reads).not.toHaveBeenCalled();
    expect(paths).not.toHaveBeenCalled();
  });

  it("preserves cancellation identity and stops assessment after a source read aborts", async () => {
    const fs = fixture({ "vision.md": "# Intent", "spec.md": "# Contract" });
    const files = await scan(fs);
    const controller = new AbortController();
    const reason = new Error("Stop during source read");
    const original = fs.readFile.bind(fs);
    const reads = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      expect(options?.signal).toBe(controller.signal);
      const bytes = await original(file, options);
      controller.abort(reason);
      return bytes;
    });
    await expect(assess(fs, { files, signal: controller.signal })).rejects.toBe(reason);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it.each(["AbortError", "JOB_CANCELLED"])(
    "propagates port %s even when the caller signal remains active",
    async (kind) => {
      const fs = fixture({ "vision.md": "# Intent", "spec.md": "# Contract" });
      const files = await scan(fs);
      const controller = new AbortController();
      const reason = Object.assign(
        new Error("Port cancelled"),
        kind === "AbortError" ? { name: kind } : { code: kind },
      );
      const reads = vi.spyOn(fs, "readFile").mockRejectedValue(reason);
      await expect(assess(fs, { files, signal: controller.signal })).rejects.toBe(reason);
      expect(controller.signal.aborted).toBe(false);
      expect(reads).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates reference cancellation instead of turning it into missing evidence", async () => {
    const fs = fixture({ "vision.md": "# Intent\n[missing](missing.md)", "spec.md": "# Contract" });
    const files = await scan(fs);
    const controller = new AbortController();
    const reason = new Error("Reference check cancelled");
    const original = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation((file: string, options?: PortCallOptions) => {
      expect(options?.signal).toBe(controller.signal);
      if (file.endsWith("missing.md")) {
        controller.abort(reason);
        return Promise.resolve(null);
      }
      return original(file, options);
    });
    await expect(assess(fs, { files, signal: controller.signal })).rejects.toBe(reason);
  });
});
