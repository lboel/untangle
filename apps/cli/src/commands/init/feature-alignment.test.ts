import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "@untangle-code/config";
import type { ProductFeatureManifestV1 } from "@untangle-code/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs } from "../../cli/args.js";
import { BufferIo } from "../../cli/io.js";

import { createInitCommand, initOptionsFrom } from "./command.js";
import { formatTextReport } from "./report.js";
import { CONFIG_FILE_NAME, runInit } from "./run.js";

const MANIFEST: ProductFeatureManifestV1 = {
  schemaVersion: 1,
  owners: [
    {
      id: "search-team",
      label: "Search team",
      kind: "team",
      status: "declared",
      sources: [{ path: "vision.md", heading: "Search" }],
    },
  ],
  features: [
    {
      id: "search.local",
      title: "Local search",
      stage: "implemented",
      review: "proposed",
      intent: [
        { role: "vision", path: "vision.md", heading: "Search" },
        { role: "specification", path: "spec.md", heading: "Contract" },
      ],
      owners: ["search-team"],
      code: { include: ["main.ts"] },
      tests: { include: ["main.test.ts"] },
      criteria: [{ id: "find", description: "Find a target", tests: ["main.test.ts"] }],
      dependsOn: [],
    },
  ],
};

describe("init feature alignment integration", () => {
  let temporary: string;
  let root: string;

  beforeEach(() => {
    temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-init-features-")));
    root = path.join(temporary, "project");
    mkdirSync(path.join(root, "planning"), { recursive: true });
    writeFileSync(
      path.join(root, "main.ts"),
      "export function localSearch(): boolean {\n  return true;\n}\n",
    );
    writeFileSync(path.join(root, "main.test.ts"), "export const declaredTestFile = true;\n");
    writeFileSync(path.join(root, "vision.md"), "# Search\n\nLocal product intent.\n");
    writeFileSync(path.join(root, "spec.md"), "# Contract\n\nDeclared behavior.\n");
  });

  afterEach(() => rmSync(temporary, { recursive: true, force: true }));

  it("automatically inspects the default feature map and retains a single infrastructure next step", async () => {
    writeFileSync(path.join(root, "untangle.features.json"), JSON.stringify(MANIFEST));
    const result = await runInit({ root, offline: true, dryRun: true, force: false }, { env: {} });
    expect(result.findings.featureAlignment).toMatchObject({
      status: "needs_review",
      semanticConformance: "not_independently_proven",
      ownershipAuthority: "manifest_declarations",
      features: [
        {
          id: "search.local",
          ownership: [{ id: "search-team", status: "declared" }],
          code: { complete: true },
          testEvidence: { status: "not_run" },
        },
      ],
    });
    expect(result.rendered).toContain("FEATURE EVIDENCE");
    expect(result.rendered).toContain('"search.local": needs_review');
    expect(result.rendered).toContain("test evidence not_run");
    expect(result.rendered).toContain('"search-team":declared');
    expect(result.rendered).toContain("Code cognitive: execution_unit=");
    const lines = formatTextReport(result);
    expect(lines.join("\n")).toContain("Feature evidence needs_review");
    expect(lines.filter((line) => line.includes("Next step:"))).toHaveLength(1);
    expect(lines.at(-1)).toContain("ollama serve");
    expect(existsSync(path.join(root, CONFIG_FILE_NAME))).toBe(false);
  });

  it("keeps an explicit feature map relative to the selected root in the actual dry-run JSON command", async () => {
    const relative = "planning/features.json";
    writeFileSync(path.join(root, relative), JSON.stringify(MANIFEST));
    const command = createInitCommand();
    const parsed = parseArgs(
      [root, `--feature-map=${relative}`, "--offline", "--dry-run", "--format=json"],
      command.spec.flags,
    );
    expect(initOptionsFrom(parsed, temporary).featureManifestPath).toBe(relative);
    const beforeFiles = readdirSync(root);
    const io = new BufferIo();
    expect(
      await command.run(
        { cwd: temporary, env: {}, signal: new AbortController().signal, io },
        parsed,
      ),
    ).toBe(0);
    const result = JSON.parse(io.outText) as Awaited<ReturnType<typeof runInit>>;
    expect(result.findings.featureAlignment?.manifest).toMatchObject({ status: "loaded" });
    expect(result.findings.featureAlignment?.features[0]?.id).toBe("search.local");
    expect(result.outcome).toBe("would-create");
    expect(io.errText).toBe("");
    expect(readdirSync(root)).toEqual(beforeFiles);
    expect(readFileSync(path.join(root, relative), "utf8")).toBe(JSON.stringify(MANIFEST));
  });

  it("exposes missing and invalid feature maps as evidence findings without creating a map or claiming conformance", async () => {
    const missing = await runInit({ root, offline: true, dryRun: true, force: false }, { env: {} });
    expect(missing.findings.featureAlignment?.status).toBe("needs_manifest");
    expect(missing.findings.featureAlignment?.draft).not.toBeNull();
    expect(existsSync(path.join(root, "untangle.features.json"))).toBe(false);
    writeFileSync(path.join(root, "planning", "invalid.json"), '{"schemaVersion":99}');
    const invalid = await runInit(
      {
        root,
        offline: true,
        dryRun: true,
        force: false,
        featureManifestPath: "planning/invalid.json",
      },
      { env: {} },
    );
    expect(invalid.findings.featureAlignment?.status).toBe("invalid_manifest");
    expect(invalid.exitCode).toBe(0);
    expect(invalid.rendered).toContain("Status: invalid_manifest");
    expect(invalid.rendered).toContain("not_independently_proven");
    expect(existsSync(path.join(root, CONFIG_FILE_NAME))).toBe(false);
  });

  it("writes only the loadable config and remains idempotent with unchanged feature evidence", async () => {
    writeFileSync(path.join(root, "untangle.features.json"), JSON.stringify(MANIFEST));
    const first = await runInit({ root, offline: true, dryRun: false, force: false }, { env: {} });
    const second = await runInit({ root, offline: true, dryRun: false, force: false }, { env: {} });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("unchanged");
    expect(second.rendered).toBe(first.rendered);
    expect(first.findings.featureAlignment?.sourceTreeDigest).toBe(
      second.findings.featureAlignment?.sourceTreeDigest,
    );
    expect(
      loadConfig({
        cwd: root,
        env: { XDG_CONFIG_HOME: path.join(temporary, "isolated-config") },
        platform: "linux",
      }).errors,
    ).toEqual([]);
    expect(readFileSync(path.join(root, "untangle.features.json"), "utf8")).toBe(
      JSON.stringify(MANIFEST),
    );
    expect(readdirSync(root).sort()).toEqual(
      [
        "main.ts",
        "main.test.ts",
        "vision.md",
        "spec.md",
        "planning",
        "untangle.features.json",
        CONFIG_FILE_NAME,
      ].sort(),
    );
  });
});
