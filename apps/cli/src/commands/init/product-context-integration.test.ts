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
import { sha256Hex, type FileWriteOptions } from "@untangle-code/domain";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs } from "../../cli/args.js";
import { renderCommandHelp } from "../../cli/command.js";
import { BufferIo } from "../../cli/io.js";

import { createInitCommand, initOptionsFrom } from "./command.js";
import { buildConfigDraft } from "./config-draft.js";
import { formatTextReport } from "./report.js";
import { CONFIG_FILE_NAME, TEMP_SUFFIX, runInit } from "./run.js";
import type { HttpProbePort } from "./types.js";

const VISION_PATH = "planning/intent.md";
const SPEC_PATH = "planning/contract.md";
const VISION = "# Local product vision\n\nDO_NOT_EMIT_RAW_VISION_BODY\n";
const SPEC = "# Local specification\n\nDO_NOT_EMIT_RAW_SPEC_BODY\n";

describe("init product context integration", () => {
  let temporary: string;
  let project: string;
  let cwd: string;

  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), "untangle-init-product-"));
    project = path.join(temporary, "project");
    cwd = path.join(temporary, "caller");
    mkdirSync(path.join(project, "planning"), { recursive: true });
    mkdirSync(cwd);
    project = realpathSync(project);
    cwd = realpathSync(cwd);
    writeFileSync(path.join(project, "main.ts"), "export const localProduct = true;\n");
  });

  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
  });

  function seedExplicitDocuments(visionPath = VISION_PATH, specPath = SPEC_PATH): void {
    writeFileSync(path.join(project, visionPath), VISION);
    writeFileSync(path.join(project, specPath), SPEC);
  }

  function options() {
    return {
      root: project,
      force: false,
      dryRun: false,
      offline: true,
      visionPath: VISION_PATH,
      specPath: SPEC_PATH,
    };
  }

  function expectedArtifact(role: string, relativePath: string) {
    return {
      name: `product-${role}-${sha256Hex(relativePath).slice(0, 12)}`,
      path: `./${relativePath}`,
      type: "markdown",
    };
  }

  it("parses vision/spec flags without resolving them against the caller directory", () => {
    const command = createInitCommand();
    const parsed = parseArgs(
      [project, `--vision=${VISION_PATH}`, "--spec", SPEC_PATH, "--offline"],
      command.spec.flags,
    );
    expect(initOptionsFrom(parsed, cwd)).toEqual(options());
    expect(() => parseArgs(["--vision"], command.spec.flags)).toThrow();
    const help = renderCommandHelp(command.spec);
    expect(help).toContain("--vision=<PATH>");
    expect(help).toContain("--spec=<PATH>");
    expect(help).toContain("local document inspection");
    expect(help).toContain("small POST");
    expect(help).not.toContain("ausschliesslich GET");
  });

  it("runs the actual JSON command against explicit custom documents in the target project", async () => {
    seedExplicitDocuments();
    // A different caller directory contains no matching documents. Resolving
    // the flags against cwd would therefore produce missing/unreadable sources.
    const command = createInitCommand();
    const io = new BufferIo();
    const beforeFiles = readdirSync(project);
    const parsed = parseArgs(
      [
        project,
        `--vision=${VISION_PATH}`,
        `--spec=${SPEC_PATH}`,
        "--offline",
        "--dry-run",
        "--format=json",
      ],
      command.spec.flags,
    );
    const exitCode = await command.run(
      { io, cwd, env: {}, signal: new AbortController().signal },
      parsed,
    );
    const json = JSON.parse(io.outText) as Awaited<ReturnType<typeof runInit>>;

    expect(exitCode).toBe(0);
    expect(json.outcome).toBe("would-create");
    expect(json.findings.root).toBe(project);
    expect(json.findings.productContext?.status).toBe("ready_for_review");
    expect(
      json.findings.productContext?.sources
        .filter((source) => source.selected)
        .map((source) => ({
          role: source.role,
          path: source.path,
          contentHash: source.contentHash,
          status: source.status,
        })),
    ).toEqual([
      { role: "vision", path: VISION_PATH, contentHash: sha256Hex(VISION), status: "readable" },
      { role: "specification", path: SPEC_PATH, contentHash: sha256Hex(SPEC), status: "readable" },
    ]);
    expect(json.findings.productContext?.reviewDraft.features).toEqual([]);
    expect(json.findings.productContext?.reviewDraft.ownership).toEqual([]);
    expect(json.findings.productContext?.alignment.status).toBe("unverified");
    expect(io.outText).not.toContain("DO_NOT_EMIT_RAW_");
    expect(io.errText).toBe("");
    expect(readdirSync(project)).toEqual(beforeFiles);
    expect(existsSync(path.join(project, CONFIG_FILE_NAME))).toBe(false);
    expect(existsSync(path.join(project, `${CONFIG_FILE_NAME}${TEMP_SUFFIX}`))).toBe(false);
    expect(readFileSync(path.join(project, VISION_PATH), "utf8")).toBe(VISION);
  });

  it("renders valid contextArtifacts TOML with path-stable names and escaped document paths", async () => {
    const quotedVision = 'planning/intent "future".md';
    const spacedSpec = "planning/contract for users.md";
    seedExplicitDocuments(quotedVision, spacedSpec);
    const result = await runInit(
      { ...options(), visionPath: quotedVision, specPath: spacedSpec },
      { env: {} },
    );
    const draft = buildConfigDraft(result.findings);
    const expected = [
      expectedArtifact("vision", quotedVision),
      expectedArtifact("specification", spacedSpec),
    ];
    expect(result.outcome).toBe("created");
    expect(result.configErrors).toEqual([]);
    expect(draft.layer.contextArtifacts).toEqual(
      expected.map((artifact) => expect.objectContaining(artifact)),
    );
    expect(result.rendered.match(/\[\[contextArtifacts\]\]/gu) ?? []).toHaveLength(2);
    expect(result.rendered).toContain(sha256Hex(VISION));
    expect(result.rendered).toContain(sha256Hex(SPEC));
    expect(result.rendered).toContain("Semantic conformance unverified");
    expect(result.rendered).toContain("Open question:");
    expect(result.rendered).not.toContain("DO_NOT_EMIT_RAW_");

    const loaded = loadConfig({
      cwd: project,
      env: { XDG_CONFIG_HOME: path.join(temporary, "user-config") },
      platform: "linux",
    });
    expect(loaded.errors).toEqual([]);
    expect(loaded.sources.tomlConfigPath).toBe(result.configPath);
    expect(loaded.effectiveConfig.contextArtifacts).toEqual(
      expected.map((artifact) =>
        expect.objectContaining({
          ...artifact,
          path: path.join(project, artifact.path),
          description: expect.stringContaining("Provisional"),
        }),
      ),
    );
    expect(readdirSync(project).sort()).toEqual(["main.ts", "planning", CONFIG_FILE_NAME].sort());
  });

  it("keeps unchanged documents idempotent and requires force when a selected document hash changes", async () => {
    seedExplicitDocuments();
    const first = await runInit(options(), { env: {} });
    const second = await runInit(options(), { env: {} });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("unchanged");
    expect(second.rendered).toBe(first.rendered);

    const changedVision = `${VISION}\nAn additional product goal.\n`;
    writeFileSync(path.join(project, VISION_PATH), changedVision);
    const differing = await runInit(options(), { env: {} });
    expect(differing.outcome).toBe("differs");
    expect(differing.exitCode).toBe(1);
    expect(differing.rendered).toContain(sha256Hex(changedVision));
    expect(readFileSync(first.configPath, "utf8")).toBe(first.rendered);
    expect(buildConfigDraft(differing.findings).layer.contextArtifacts).toEqual(
      buildConfigDraft(first.findings).layer.contextArtifacts,
    );

    const forced = await runInit({ ...options(), force: true }, { env: {} });
    expect(forced.outcome).toBe("overwritten");
    expect(readFileSync(forced.configPath, "utf8")).toBe(forced.rendered);
    expect((await runInit(options(), { env: {} })).outcome).toBe("unchanged");
    expect(readFileSync(path.join(project, VISION_PATH), "utf8")).toBe(changedVision);
  });

  it("does not replace an existing configuration during dry-run, even with force", async () => {
    seedExplicitDocuments();
    const existing = '# owned by the project\nprojectId = "handwritten"\n';
    writeFileSync(path.join(project, CONFIG_FILE_NAME), existing);
    const dry = await runInit({ ...options(), force: true, dryRun: true }, { env: {} });
    expect(dry.outcome).toBe("would-overwrite");
    expect(dry.exitCode).toBe(0);
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(readFileSync(dry.configPath, "utf8")).toBe(existing);
    expect(existsSync(`${dry.configPath}${TEMP_SUFFIX}`)).toBe(false);
  });

  it("reports missing product context while preserving exactly one infrastructure next step in actual text output", async () => {
    const command = createInitCommand();
    const io = new BufferIo();
    const parsed = parseArgs([project, "--offline", "--dry-run"], command.spec.flags);
    const exitCode = await command.run(
      { io, cwd, env: {}, signal: new AbortController().signal },
      parsed,
    );
    expect(exitCode).toBe(0);
    expect(io.outText).toBe(`${path.join(project, CONFIG_FILE_NAME)}\n`);
    expect(io.errText).toContain("Produktkontext");
    expect(io.errText).toContain("Missing product sources: vision, specification");
    expect(io.errText).toContain("Semantic conformance unverified");
    expect(io.errText.match(/Next step:/gu) ?? []).toHaveLength(1);
    expect(io.errText).toContain("ollama serve");
    expect(existsSync(path.join(project, CONFIG_FILE_NAME))).toBe(false);
  });

  it("does not configure ambiguous filename candidates as confirmed product sources", async () => {
    writeFileSync(path.join(project, "vision.md"), VISION);
    writeFileSync(path.join(project, "planning", "vision.md"), `${VISION}\nAlternative vision.\n`);
    writeFileSync(path.join(project, "spec.md"), SPEC);
    const result = await runInit(
      { root: project, force: false, dryRun: true, offline: true },
      { env: {} },
    );
    expect(result.findings.productContext?.ambiguousRoles).toContain("vision");
    expect(
      result.findings.productContext?.sources
        .filter((source) => source.role === "vision")
        .every((source) => !source.selected),
    ).toBe(true);
    expect(buildConfigDraft(result.findings).layer.contextArtifacts).toEqual([
      expect.objectContaining(expectedArtifact("specification", "spec.md")),
    ]);
    expect(result.rendered).toContain("Ambiguous source selection: vision");
    expect(formatTextReport(result).filter((line) => line.includes("Next step:"))).toHaveLength(1);
  });

  it("excludes an empty selected specification from the configuration and keeps its finding visible", async () => {
    seedExplicitDocuments();
    writeFileSync(path.join(project, SPEC_PATH), "");
    const result = await runInit({ ...options(), dryRun: true }, { env: {} });
    expect(
      result.findings.productContext?.sources.find((source) => source.role === "specification")
        ?.status,
    ).toBe("empty");
    expect(buildConfigDraft(result.findings).layer.contextArtifacts).toEqual([
      expect.objectContaining(expectedArtifact("vision", VISION_PATH)),
    ]);
    expect(result.rendered).toContain('specification: "planning/contract.md" — empty');
    expect(result.rendered).toContain("features and ownership unconfirmed");
  });

  it("preserves an abort from a service probe without creating configuration or temporary output", async () => {
    seedExplicitDocuments();
    const beforeFiles = readdirSync(project);
    const controller = new AbortController();
    const reason = new Error("abort from service probe");
    let probeCalls = 0;
    const http: HttpProbePort = {
      getJson(): Promise<null> {
        probeCalls += 1;
        controller.abort(reason);
        // An unavailable service is normally a finding, so the mutation
        // barrier must notice cancellation even when the probe returns.
        return Promise.resolve(null);
      },
      probeEmbedding() {
        return Promise.resolve({ ok: false as const, timedOut: false, detail: "not reached" });
      },
    };

    await expect(
      runInit({ ...options(), offline: false }, { env: {}, http, signal: controller.signal }),
    ).rejects.toBe(reason);

    expect(probeCalls).toBeGreaterThan(0);
    expect(readdirSync(project)).toEqual(beforeFiles);
    expect(existsSync(path.join(project, CONFIG_FILE_NAME))).toBe(false);
    expect(existsSync(path.join(project, `${CONFIG_FILE_NAME}${TEMP_SUFFIX}`))).toBe(false);
    expect(readFileSync(path.join(project, VISION_PATH), "utf8")).toBe(VISION);
    expect(readFileSync(path.join(project, SPEC_PATH), "utf8")).toBe(SPEC);
  });

  it("cleans a completed temporary write after abort while preserving the existing configuration and reason", async () => {
    seedExplicitDocuments();
    const configPath = path.join(project, CONFIG_FILE_NAME);
    const temporaryPath = `${configPath}${TEMP_SUFFIX}`;
    const existing = '# owned by the project\nprojectId = "handwritten"\n';
    writeFileSync(configPath, existing);
    const beforeFiles = readdirSync(project);
    const controller = new AbortController();
    const reason = new Error("abort after temporary write");
    let writtenTemporary: string | undefined;

    class AbortingFileSystem extends NodeFileSystem {
      public override async writeFile(
        filePath: string,
        data: Uint8Array,
        callOptions?: FileWriteOptions,
      ): Promise<void> {
        await super.writeFile(filePath, data, callOptions);
        if (filePath === temporaryPath) {
          writtenTemporary = readFileSync(temporaryPath, "utf8");
          controller.abort(reason);
        }
      }
    }

    await expect(
      runInit(
        { ...options(), force: true },
        { env: {}, fs: new AbortingFileSystem(), signal: controller.signal },
      ),
    ).rejects.toBe(reason);

    expect(writtenTemporary).toContain("[[contextArtifacts]]");
    expect(writtenTemporary).toContain(sha256Hex(VISION));
    expect(readFileSync(configPath, "utf8")).toBe(existing);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(readdirSync(project)).toEqual(beforeFiles);
    expect(readFileSync(path.join(project, VISION_PATH), "utf8")).toBe(VISION);
    expect(readFileSync(path.join(project, SPEC_PATH), "utf8")).toBe(SPEC);
  });
});
