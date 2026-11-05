import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BufferIo } from "../cli/io.js";
import { run } from "../index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project(framework: "spec-kit" | "openspec") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "untangle-sdd-public-")));
  roots.push(root);
  const files: Record<string, string> = {
    "src/account.ts":
      'export function account(id: string) { if (!id) return "missing"; return id.trim(); }\n',
    "tests/account.test.ts": "export const notExecutedByTheConnector = true;\n",
  };
  if (framework === "spec-kit")
    Object.assign(files, {
      ".specify/memory/constitution.md":
        "# Engineering principles\nKeep account responsibilities explicit.\n",
      "specs/001-accounts/spec.md":
        "# Feature Specification: Accounts\n\n## Functional Requirements\n\n- **FR-001**: Find an account by its identifier.\n",
      "specs/001-accounts/tasks.md":
        "# Tasks\n\n- [x] T001 [US1] Implement `src/account.ts`\n- [ ] T002 [US1] Check `tests/account.test.ts`\n",
    });
  else
    Object.assign(files, {
      "openspec/specs/accounts/spec.md":
        "# Accounts\n\n## Requirements\n\n### Requirement: Account lookup\nThe system SHALL find an account by its identifier.\n\n#### Scenario: Known account\n- **WHEN** a known identifier is supplied\n- **THEN** return that account\n",
      "openspec/changes/add-accounts/proposal.md":
        "# Add account lookup\n\n## Why\nMake account responsibility explicit.\n",
      "openspec/changes/add-accounts/tasks.md":
        "# Tasks\n\n- [x] 1.1 Implement `src/account.ts`\n- [ ] 1.2 Check `tests/account.test.ts`\n",
    });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return { root, files };
}

async function invoke(root: string, args: string[]) {
  const io = new BufferIo();
  const exitCode = await run([...args, `--root=${root}`, "--format=json"], { io, cwd: tmpdir() });
  return { exitCode, io };
}

describe("public SDD connector workflow", () => {
  it.each(["spec-kit", "openspec"] as const)(
    "inspects %s through the public CLI without dry-run writes",
    async (framework) => {
      const { root, files } = await project(framework);
      const result = await invoke(root, ["product", "connect", "auto", "--dry-run"]);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.io.outText);
      expect(data.report.frameworks).toEqual([framework]);
      expect(data.manifestPath).toBeNull();
      expect(data.reportPath).toBeNull();
      expect(data.report.features.length).toBeGreaterThan(0);
      expect(data.report.draft.owners).toEqual([]);
      expect(
        data.report.draft.features.every(
          (feature: { stage: string; review: string }) =>
            feature.stage === "planned" && feature.review === "proposed",
        ),
      ).toBe(true);
      expect(await readdir(root)).not.toContain(".untangle");
      for (const [file, content] of Object.entries(files))
        expect(await readFile(path.join(root, file), "utf8")).toBe(content);
    },
  );

  it.each(["spec-kit", "openspec"] as const)(
    "connects %s, then measures and maps the actual saved draft",
    async (framework) => {
      const { root, files } = await project(framework);
      const connected = await invoke(root, ["product", "connect", framework]);
      expect(connected.exitCode).toBe(0);
      const artifact = JSON.parse(connected.io.outText);
      expect(path.relative(root, artifact.manifestPath)).toMatch(/^\.untangle[/\\]sdd[/\\]/u);
      expect(
        artifact.report.features.some((feature: { tasks: { checked: boolean }[] }) =>
          feature.tasks.some((task) => task.checked),
        ),
      ).toBe(true);
      const analyzed = await invoke(root, ["product", `--manifest=${artifact.manifestPath}`]);
      expect(analyzed.exitCode).toBe(0);
      const report = JSON.parse(analyzed.io.outText);
      expect(report.manifest.status).toBe("loaded");
      expect(
        report.features.some(
          (feature: { code: { metrics: { cognitive: { execution_unit: number } } | null } }) =>
            (feature.code.metrics?.cognitive.execution_unit ?? 0) > 0,
        ),
      ).toBe(true);
      expect(
        report.features.every(
          (feature: { stage: string; review: string; testEvidence: { status: string } }) =>
            feature.stage === "planned" &&
            feature.review === "proposed" &&
            feature.testEvidence.status === "not_run",
        ),
      ).toBe(true);
      expect(report.semanticConformance).toBe("not_independently_proven");
      const mapped = await invoke(root, [
        "graph",
        "features",
        `--feature-map=${artifact.manifestPath}`,
      ]);
      expect(mapped.exitCode).toBe(0);
      const map = JSON.parse(mapped.io.outText);
      expect(map.report.sourceTreeDigest).toBe(report.sourceTreeDigest);
      expect(map.summary.features).toBe(report.features.length);
      expect(await readFile(map.htmlPath, "utf8")).toContain('<html lang="en">');
      expect(await readFile(map.htmlPath, "utf8")).toContain("3D");
      const repeated = await invoke(root, ["product", "connect", framework]);
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.io.outText).manifestPath).toBe(artifact.manifestPath);
      for (const [file, content] of Object.entries(files))
        expect(await readFile(path.join(root, file), "utf8")).toBe(content);
    },
  );

  it.each([["--run-tests"], ["--manifest=other.json"], ["--feature=accounts.lookup"]])(
    "rejects unrelated product flags before connector writes: %s",
    async (flags) => {
      const { root } = await project("spec-kit");
      const result = await invoke(root, ["product", "connect", "spec-kit", flags]);
      expect(result.exitCode).toBe(2);
      expect(result.io.errText).toContain("not supported by product connect");
      expect(await readdir(root)).not.toContain(".untangle");
    },
  );

  it("rejects connector-only flags outside the connect subcommand", async () => {
    const { root } = await project("spec-kit");
    const result = await invoke(root, ["product", "--dry-run"]);
    expect(result.exitCode).toBe(2);
    expect(result.io.errText).toContain("--dry-run is supported only by product connect");
    expect(await readdir(root)).not.toContain(".untangle");
  });
});
