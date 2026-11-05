import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { parseProductManifest } from "../product-alignment/manifest.js";

import { discoverSddArtifacts, SDD_LIMITS } from "./index.js";

const ROOT = "/project";
function project(files: Record<string, string>): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock());
  fs.seedDirectory(ROOT);
  for (const [file, text] of Object.entries(files)) fs.seedFile(`${ROOT}/${file}`, text);
  return fs;
}
function specKit(): MemoryFileSystem {
  return project({
    ".specify/memory/constitution.md":
      "# Engineering principles\nKeep account behavior explicit.\n",
    "specs/001-accounts/spec.md":
      "# Feature Specification: Accounts\n## Requirements\n### Functional Requirements\n- **FR-001**: Reject empty identifiers.\n- **SC-001**: Return an account within one request.\n",
    "specs/001-accounts/plan.md": "# Account implementation\nUse `src/accounts.ts`.\n",
    "specs/001-accounts/tasks.md":
      "# Tasks: Accounts\n- [x] T001 [P] [US1] Create src/accounts.ts\n- [ ] T002 [US1] Check `tests/accounts.test.ts`\n- [ ] T003 Create `src/not-created.ts`\n",
    "src/accounts.ts": "export function account(id: string) { return id ? id : undefined; }\n",
    "src/unmentioned.ts": "export const notPartOfThisFeature = true;\n",
    "tests/accounts.test.ts": "export const thisWasNotExecuted = true;\n",
  });
}

describe("native SDD connectors", () => {
  it("imports actual Spec Kit requirements, task/story state and literal code/test references without confirming behavior", async () => {
    const fs = specKit();
    const writes = vi.spyOn(fs, "writeFile");
    const result = await discoverSddArtifacts({ root: ROOT, fs });
    expect(result.frameworks).toEqual(["spec-kit"]);
    expect(result.features).toHaveLength(1);
    const feature = result.features[0]!;
    expect(feature.id).toBe("spec-kit:specs/001-accounts");
    expect(feature.requirements.map((r) => [r.id, r.kind, r.path, r.line])).toEqual([
      ["FR-001", "requirement", "specs/001-accounts/spec.md", 4],
      ["SC-001", "success_criterion", "specs/001-accounts/spec.md", 5],
    ]);
    expect(feature.tasks.map((t) => [t.id, t.checked, t.story])).toEqual([
      ["T001", true, "US1"],
      ["T002", false, "US1"],
      ["T003", false, undefined],
    ]);
    expect(feature.references).toContainEqual(
      expect.objectContaining({
        path: "src/accounts.ts",
        status: "resolved",
        sourcePath: "specs/001-accounts/tasks.md",
        line: 2,
      }),
    );
    expect(feature.references).toContainEqual(
      expect.objectContaining({ literal: "src/not-created.ts", path: null, status: "missing" }),
    );
    const draft = result.draft.features[0]!;
    expect(draft).toMatchObject({
      stage: "planned",
      review: "proposed",
      owners: [],
      dependsOn: [],
      code: { include: ["src/accounts.ts"] },
      tests: { include: ["tests/accounts.test.ts"] },
    });
    expect(draft.criteria.every((criterion) => criterion.tests.length === 0)).toBe(true);
    expect(draft.intent).toContainEqual({
      path: ".specify/memory/constitution.md",
      heading: "Engineering principles",
      role: "vision",
    });
    expect(result.sources.find((source) => source.path === "src/unmentioned.ts")).toBeUndefined();
    expect(parseProductManifest(JSON.stringify(result.draft)).issues).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("parses OpenSpec capabilities and active deltas separately and preserves removed requirements without importing them as acceptance", async () => {
    const fs = project({
      "openspec/specs/accounts/spec.md":
        "# Account behavior\n## Requirements\n### Requirement: Account lookup\nThe system SHALL return an account.\n#### Scenario: Existing account\n- GIVEN a known account\n",
      "openspec/changes/add-empty-check/proposal.md":
        "# Reject empty identifiers\nKeep invalid requests explicit.\n",
      "openspec/changes/add-empty-check/design.md":
        "# Validation design\nChange `src/accounts.ts`; verify [tests](../../../tests/accounts.test.ts).\n",
      "openspec/changes/add-empty-check/tasks.md":
        "# Tasks\n- [x] 1.1 Add the validation in `src/accounts.ts`\n- [ ] 1.2 Verify `tests/accounts.test.ts`\n",
      "openspec/changes/add-empty-check/specs/accounts/spec.md":
        "# Account delta\n## ADDED Requirements\n### Requirement: Empty identifiers\nReject empty input.\n#### Scenario: Empty input\n- WHEN the identifier is empty\n## REMOVED Requirements\n### Requirement: Implicit fallback\nRemove the old fallback.\n",
      "openspec/changes/archive/2026-01-01-old/tasks.md": "# Archived\n- [x] 1.1 Not active\n",
      "src/accounts.ts": "export const accounts = [];\n",
      "tests/accounts.test.ts": "export const notExecuted = true;\n",
    });
    const result = await discoverSddArtifacts({ root: ROOT, fs, framework: "openspec" });
    expect(result.features.map((feature) => feature.kind)).toEqual(["capability", "change"]);
    const change = result.features[1]!;
    expect(change.requirements.map((r) => [r.description, r.kind, r.change])).toEqual([
      ["Empty identifiers", "requirement", "added"],
      ["Empty input", "scenario", "added"],
      ["Implicit fallback", "requirement", "removed"],
    ]);
    expect(change.tasks.map((t) => [t.id, t.checked])).toEqual([
      ["1.1", true],
      ["1.2", false],
    ]);
    expect(result.draft.features[1]!.criteria.map((r) => r.description)).toEqual([
      "Empty identifiers: Reject empty input.",
    ]);
    expect(result.features[0]!.requirements[0]!.body).toContain(
      "The system SHALL return an account.",
    );
    expect(result.features[0]!.requirements[1]!.body).toContain("GIVEN a known account");
    expect(result.draft.features[1]!.code.include).toEqual(["src/accounts.ts"]);
    expect(result.draft.features[1]!.tests.include).toEqual(["tests/accounts.test.ts"]);
    expect(result.sources.some((source) => source.path.includes("archive/"))).toBe(false);
    expect(
      result.draft.features.every(
        (feature) => feature.stage === "planned" && feature.owners.length === 0,
      ),
    ).toBe(true);
    expect(parseProductManifest(JSON.stringify(result.draft)).issues).toEqual([]);
  });

  it("supports the current persisted Spec Kit feature_directory without running framework scripts", async () => {
    const fs = project({
      ".specify/feature.json": JSON.stringify({ feature_directory: "work/auth" }),
      "work/auth/spec.md":
        "# Authentication\n## Requirements\n- **FR-007**: Reject expired sessions.\n",
      ".specify/scripts/steal.sh": "touch /outside/never-run\n",
    });
    const read = vi.spyOn(fs, "readFile");
    const result = await discoverSddArtifacts({ root: ROOT, fs });
    expect(result.features.map((feature) => feature.directory)).toEqual(["work/auth"]);
    expect(read.mock.calls.every(([file]) => !file.endsWith(".sh"))).toBe(true);
  });

  it("preserves wrapped Spec Kit requirement text in the proposed criterion", async () => {
    const fs = specKit();
    fs.seedFile(
      `${ROOT}/specs/001-accounts/spec.md`,
      "# Accounts\n## Requirements\n- **FR-001**: System MUST reject identifiers\n  when the input is empty and retain the original error contract.\n- **SC-001**: One request is sufficient.\n",
    );
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.features[0]!.requirements[0]!.body).toContain(
      "when the input is empty and retain the original error contract.",
    );
    expect(report.draft.features[0]!.criteria[0]!.description).toBe(
      "System MUST reject identifiers\nwhen the input is empty and retain the original error contract.",
    );
    expect(report.features[0]!.requirements[1]!.body).toBe("One request is sufficient.");
  });

  it("reports invalid and escaping persisted feature state without reading the outside file", async () => {
    const fs = project({ ".specify/feature.json": '{"feature_directory":"../../outside"}' });
    fs.seedFile("/outside/spec.md", "# Secret\n");
    const read = vi.spyOn(fs, "readFile");
    const result = await discoverSddArtifacts({ root: ROOT, fs, framework: "spec-kit" });
    expect(result.status).toBe("incomplete");
    expect(result.issues.some((issue) => issue.code === "invalid_feature_directory")).toBe(true);
    expect(read.mock.calls.every(([file]) => file.startsWith(`${ROOT}/`))).toBe(true);
    fs.seedFile(`${ROOT}/.specify/feature.json`, "not json");
    expect(
      (await discoverSddArtifacts({ root: ROOT, fs })).issues.some(
        (issue) => issue.code === "invalid_feature_state",
      ),
    ).toBe(true);
  });

  it("rejects symlink framework roots and symlink referenced files", async () => {
    const fs = project({ "openspec/specs/a/spec.md": "# A\n### Requirement: A\n" });
    fs.seedSymlink(`${ROOT}/.specify`, "/outside");
    expect(
      (await discoverSddArtifacts({ root: ROOT, fs })).issues.some(
        (issue) => issue.code === "unsafe_framework_root",
      ),
    ).toBe(true);
    const kit = specKit();
    kit.seedSymlink(`${ROOT}/src/accounts.ts`, "/outside/secret.ts");
    const report = await discoverSddArtifacts({ root: ROOT, fs: kit });
    expect(report.draft.features[0]!.code.include).toEqual([]);
    expect(report.features[0]!.references.some((reference) => reference.status === "unsafe")).toBe(
      true,
    );
  });

  it("marks source changes during the connector run stale", async () => {
    const fs = specKit(),
      read = fs.readFile.bind(fs);
    let reads = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await read(file, options);
      if (file.endsWith("src/accounts.ts") && ++reads > 1)
        return new TextEncoder().encode("changed during discovery");
      return bytes;
    });
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("stale");
    expect(
      report.issues.some(
        (issue) => issue.code === "changed_source" && issue.path === "src/accounts.ts",
      ),
    ).toBe(true);
  });

  it("does not interpret fenced examples or HTML comments as live requirements and tasks", async () => {
    const fs = specKit();
    fs.seedFile(
      `${ROOT}/specs/001-accounts/spec.md`,
      "# Account contract\n```markdown\n- **FR-FAKE**: An example.\n```\n<!--\n- **FR-COMMENT**: Hidden.\n-->\n- **FR-REAL**: Keep the real requirement.\n",
    );
    fs.seedFile(
      `${ROOT}/specs/001-accounts/tasks.md`,
      "# Tasks\n```\n- [x] T111 Create `src/unmentioned.ts`\n```\n- [ ] T001 Update `src/accounts.ts`\n",
    );
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.features[0]!.requirements.map((r) => r.id)).toEqual(["FR-REAL"]);
    expect(report.features[0]!.tasks.map((r) => r.id)).toEqual(["T001"]);
    expect(report.draft.features[0]!.code.include).toEqual(["src/accounts.ts"]);
  });

  it("keeps nested shorter fences, invalid fence closers and every HTML comment out of live declarations", async () => {
    const fs = specKit();
    fs.seedFile(
      `${ROOT}/specs/001-accounts/spec.md`,
      [
        "# Account contract",
        "````markdown",
        "```",
        "- **FR-FENCE**: An example with `src/unmentioned.ts`.",
        "````not-a-closing-fence",
        "- **FR-INFO**: Still inside the four-character fence.",
        "`````   ",
        "~~~markdown",
        "`````",
        "- **FR-TILDE**: The other delimiter cannot close this fence.",
        "~~~",
        "<!-- first --> <!--",
        "- **FR-COMMENT**: Hidden with `src/unmentioned.ts`.",
        "--> <!-- another --> <!--",
        "- **FR-SECOND-COMMENT**: Also hidden.",
        "-->",
        "- **FR-REAL**: Keep the real requirement.",
      ].join("\n"),
    );
    fs.seedFile(
      `${ROOT}/specs/001-accounts/tasks.md`,
      [
        "# Tasks",
        "~~~~markdown",
        "~~~",
        "- [x] T111 Create `src/unmentioned.ts`",
        "~~~~ wrong closer",
        "- [x] T112 Create `src/unmentioned.ts`",
        "~~~~~",
        "<!-- first --> <!--",
        "- [x] T113 Create `src/unmentioned.ts`",
        "--> <!-- more --> <!--",
        "- [x] T114 Create `src/unmentioned.ts`",
        "-->",
        "<!-- first --> <!-- second --> - [ ] T001 Update `src/accounts.ts`",
      ].join("\n"),
    );
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.features[0]!.requirements.map((r) => r.id)).toEqual(["FR-REAL"]);
    expect(report.features[0]!.tasks.map((r) => r.id)).toEqual(["T001"]);
    expect(report.features[0]!.references.every((r) => r.literal !== "src/unmentioned.ts")).toBe(
      true,
    );
    expect(report.sources.some((source) => source.path === "src/unmentioned.ts")).toBe(false);
    expect(report.draft.features[0]!.code.include).toEqual(["src/accounts.ts"]);
  });

  it("keeps oversized headings as evidence but never substitutes a truncated manifest authority", async () => {
    const fs = specKit(),
      heading = "H".repeat(4097);
    fs.seedFile(`${ROOT}/.specify/memory/constitution.md`, `# ${heading}\n`);
    fs.seedFile(
      `${ROOT}/specs/001-accounts/spec.md`,
      `# ${heading}\n- **FR-REAL**: Preserve the actual authority.\n`,
    );
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("incomplete");
    expect(report.features[0]!.title).toBe(heading);
    expect(report.features[0]!.requirements[0]!.heading).toBe(heading);
    expect(report.draft.features).toEqual([]);
    expect(report.issues.some((issue) => issue.code === "draft_field_limit")).toBe(true);
    expect(parseProductManifest(JSON.stringify(report.draft)).issues).toEqual([]);
  });

  it("omits an oversized constitution heading and criterion text without inventing shorter declarations", async () => {
    const fs = specKit(),
      heading = "Constitution ".repeat(342),
      body = "R".repeat(4097);
    fs.seedFile(`${ROOT}/.specify/memory/constitution.md`, `# ${heading}\n`);
    fs.seedFile(
      `${ROOT}/specs/001-accounts/spec.md`,
      `# Accounts\n- **FR-LONG**: ${body}\n- **FR-REAL**: Preserve the real declaration.\n`,
    );
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("incomplete");
    expect(report.features[0]!.requirements[0]!.description).toBe(body);
    expect(report.draft.features[0]!.intent).toEqual([
      { path: "specs/001-accounts/spec.md", heading: "Accounts", role: "specification" },
    ]);
    expect(report.draft.features[0]!.criteria).toEqual([
      { id: "FR-REAL-2", description: "Preserve the real declaration.", tests: [] },
    ]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "draft_field_limit",
        path: ".specify/memory/constitution.md",
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "draft_criterion_limit",
        path: "specs/001-accounts/spec.md",
      }),
    );
    expect(parseProductManifest(JSON.stringify(report.draft)).issues).toEqual([]);
  });

  it("accepts exact manifest field boundaries with unique duplicate-declaration criterion IDs", async () => {
    const fs = specKit(),
      heading = "H".repeat(4096),
      code = `src/${"x".repeat(505)}.ts`,
      id = `FR-${"A".repeat(4091)}`;
    expect(code.length).toBe(512);
    expect(`${id}-1`).toHaveLength(4096);
    fs.seedFile(`${ROOT}/${code}`, "export const boundary = true;\n");
    fs.seedFile(
      `${ROOT}/specs/001-accounts/spec.md`,
      `# ${heading}\n- **${id}**: ${"R".repeat(4096)}\n- **FR-001**: First declaration.\n- **FR-001**: Second declaration.\n`,
    );
    fs.seedFile(`${ROOT}/specs/001-accounts/tasks.md`, `- [ ] T001 Update \`${code}\`\n`);
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("connected");
    expect(report.draft.features[0]!.title).toBe(heading);
    expect(report.draft.features[0]!.intent[0]!.heading).toBe(heading);
    expect(report.draft.features[0]!.code.include).toContain(code);
    expect(report.draft.features[0]!.criteria.map((criterion) => criterion.id)).toEqual([
      `${id}-1`,
      "FR-001-2",
      "FR-001-3",
    ]);
    expect(parseProductManifest(JSON.stringify(report.draft)).issues).toEqual([]);
  });

  it("omits oversized code/test selectors while retaining the exact resolved file evidence", async () => {
    const fs = specKit(),
      directory = ["nested".repeat(30), "deeper".repeat(30), "deepest".repeat(30)].join("/"),
      code = `${directory}/account.ts`,
      test = `${directory}/account.test.ts`;
    expect(code.length).toBeGreaterThan(512);
    fs.seedFile(`${ROOT}/${code}`, "export const account = true;\n");
    fs.seedFile(`${ROOT}/${test}`, "export const accountTest = true;\n");
    fs.seedFile(
      `${ROOT}/specs/001-accounts/tasks.md`,
      `# Tasks\n- [ ] T001 Update \`${code}\`\n- [ ] T002 Test \`${test}\`\n`,
    );
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("incomplete");
    for (const file of [code, test]) {
      expect(report.features[0]!.references).toContainEqual(
        expect.objectContaining({ literal: file, path: file, status: "resolved" }),
      );
      expect(report.sources.some((source) => source.path === file)).toBe(true);
    }
    expect(report.draft.features[0]!.code.include).toEqual(["src/accounts.ts"]);
    expect(report.draft.features[0]!.tests.include).toEqual([]);
    expect(report.issues.filter((issue) => issue.code === "draft_selection_limit")).toHaveLength(2);
    expect(parseProductManifest(JSON.stringify(report.draft)).issues).toEqual([]);
  });

  it("retains duplicate requirement evidence while generating unique valid criterion identifiers", async () => {
    const fs = specKit(),
      id = `FR-${"A".repeat(4096)}`;
    fs.seedFile(
      `${ROOT}/specs/001-accounts/spec.md`,
      `# Accounts\n- **FR-001**: First declaration.\n- **FR-001**: Second declaration.\n- **${id}**: Long identifier.\n`,
    );
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.features[0]!.requirements.map((requirement) => requirement.id)).toEqual([
      "FR-001",
      "FR-001",
      id,
    ]);
    expect(report.status).toBe("incomplete");
    expect(report.draft.features[0]!.criteria.map((criterion) => criterion.id)).toEqual([
      "FR-001-1",
      "FR-001-2",
    ]);
    expect(report.issues.some((issue) => issue.code === "draft_criterion_limit")).toBe(true);
    expect(parseProductManifest(JSON.stringify(report.draft)).issues).toEqual([]);
  });

  it("keeps ambiguous root-relative/document-relative file references unresolved", async () => {
    const fs = specKit();
    fs.seedFile(`${ROOT}/helper.ts`, "export const rootHelper = true;\n");
    fs.seedFile(`${ROOT}/specs/001-accounts/helper.ts`, "export const otherHelper = true;\n");
    fs.seedFile(`${ROOT}/specs/001-accounts/tasks.md`, "# Tasks\n- [ ] T001 Change `helper.ts`\n");
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.features[0]!.references).toContainEqual(
      expect.objectContaining({ literal: "helper.ts", status: "ambiguous", path: null }),
    );
    expect(report.draft.features[0]!.code.include).not.toContain("helper.ts");
    expect(report.issues.some((issue) => issue.code === "ambiguous_reference")).toBe(true);
  });

  it("keeps unsupported and oversized documents visible as incomplete evidence", async () => {
    const fs = specKit();
    fs.seedFile(`${ROOT}/specs/001-accounts/spec.md`, "a".repeat(SDD_LIMITS.bytesPerFile + 1));
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("incomplete");
    expect(report.issues.some((issue) => issue.code === "read_limit")).toBe(true);
    fs.seedFile(`${ROOT}/specs/001-accounts/spec.md`, new Uint8Array([255, 254]));
    expect(
      (await discoverSddArtifacts({ root: ROOT, fs })).issues.some(
        (issue) => issue.code === "unreadable_source",
      ),
    ).toBe(true);
  });

  it("reports frameworks with no supported requirements without inventing a clean result", async () => {
    const fs = project({
      ".specify/feature.json": '{"feature_directory":"features/a"}',
      "features/a/spec.md": "# Feature\nNo formal requirement yet.\n",
    });
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("incomplete");
    expect(report.draft.features[0]!.criteria).toEqual([]);
    expect(report.issues.some((issue) => issue.code === "missing_requirements")).toBe(true);
  });

  it("does not detect arbitrary specs directories as Spec Kit without its marker", async () => {
    const fs = project({ "specs/a/spec.md": "# Ordinary documentation\n" });
    const report = await discoverSddArtifacts({ root: ROOT, fs });
    expect(report.status).toBe("not_detected");
    expect(report.features).toEqual([]);
    expect(report.draft).toEqual({ schemaVersion: 1, owners: [], features: [] });
  });

  it("honors cancellation before filesystem access", async () => {
    const fs = specKit(),
      read = vi.spyOn(fs, "realPath"),
      signal = AbortSignal.abort();
    await expect(discoverSddArtifacts({ root: ROOT, fs, signal })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});
