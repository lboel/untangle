import { describe, expect, it, vi } from "vitest";

import { discoverSddArtifacts } from "@untangle-code/core";

import { parseArgs } from "../../cli/args.js";
import type { CommandContext } from "../../cli/command.js";
import { EXIT } from "../../cli/exit.js";
import { BufferIo } from "../../cli/io.js";
import type { FeatureMapWriteResultV1 } from "../graph/feature-map.js";

import { createInitCommand } from "./command.js";
import type { IntegrationSetupReportV1 } from "./integrations.js";
import { runInit, type InitDepsV1 } from "./run.js";
import { ROOT, demoDeps, seedDemoProject, silentProbe, tagsPayload } from "./test-support.js";
import type { HttpProbePort } from "./types.js";
import type { WizardChoice, WizardTerminal } from "./wizard-terminal.js";
import { runInitWizard, type InitWizardDepsV1 } from "./wizard.js";

function context(): CommandContext & { io: BufferIo } {
  return { cwd: ROOT, io: new BufferIo(), env: {}, signal: new AbortController().signal };
}

/** Answers must be options actually offered by the production flow. */
function scriptedTerminal(answers: string[], inputs: string[] = [], interactive = true) {
  const questions: string[] = [];
  const messages: string[] = [];
  const remaining = [...answers];
  const entered = [...inputs];
  const terminal: WizardTerminal = {
    interactive,
    choose: async <T extends string>(
      question: string,
      choices: readonly WizardChoice<T>[],
    ): Promise<T> => {
      questions.push(question);
      const answer = remaining.shift();
      expect(answer, `Missing scripted answer for ${question}`).toBeDefined();
      expect(
        choices.some((choice) => choice.value === answer),
        `Option ${String(answer)} was not offered for ${question}`,
      ).toBe(true);
      return answer as T;
    },
    input: vi.fn(async (question: string): Promise<string> => {
      questions.push(question);
      const answer = entered.shift();
      expect(answer, `Missing scripted input for ${question}`).toBeDefined();
      return answer!;
    }),
    message: vi.fn((text: string) => {
      messages.push(text);
    }),
  };
  return { terminal, questions, messages, remaining, entered };
}

function setupReport(items: IntegrationSetupReportV1["items"] = []): IntegrationSetupReportV1 {
  return {
    schemaVersion: 1,
    root: ROOT,
    executeRequested: false,
    offline: false,
    items,
    reportPath: `${ROOT}/.untangle/setup/receipt.json`,
  };
}

function watchWrites(fs: ReturnType<typeof seedDemoProject>) {
  return [
    vi.spyOn(fs, "writeFile"),
    vi.spyOn(fs, "rename"),
    vi.spyOn(fs, "mkdir"),
    vi.spyOn(fs, "remove"),
  ];
}

const OPTIONS = { root: ROOT, force: false, dryRun: false, offline: false };

function seedSpecKit(fs: ReturnType<typeof seedDemoProject>) {
  fs.seedFile(
    `${ROOT}/.specify/memory/constitution.md`,
    "# Engineering principles\nKeep account behavior explicit.\n",
  );
  fs.seedFile(
    `${ROOT}/specs/001-accounts/spec.md`,
    "# Feature Specification: Account lookup\n\n## Functional Requirements\n\n- **FR-001**: Find the account by its identifier.\n",
  );
  fs.seedFile(
    `${ROOT}/specs/001-accounts/tasks.md`,
    "# Tasks\n\n- [x] T001 Implement account lookup in `packages/web/src/app.ts`\n",
  );
}

function harness(answers: string[], inputs: string[] = [], http: HttpProbePort = silentProbe()) {
  const fs = seedDemoProject();
  const ctx = context();
  const script = scriptedTerminal(answers, inputs);
  const apply = vi
    .fn<NonNullable<InitWizardDepsV1["applyIntegrations"]>>()
    .mockResolvedValue(setupReport());
  const writeMap = vi.fn<NonNullable<InitWizardDepsV1["writeMap"]>>();
  const openBrowser = vi.fn<NonNullable<InitWizardDepsV1["openBrowser"]>>().mockResolvedValue();
  const initialize = vi.fn(async (options: Parameters<typeof runInit>[0], deps?: InitDepsV1) =>
    runInit(options, deps),
  );
  const initDeps = demoDeps(fs, http);
  const deps = {
    terminal: script.terminal,
    applyIntegrations: apply,
    writeMap,
    openBrowser,
    initialize,
  };
  return { fs, ctx, script, apply, writeMap, openBrowser, initialize, initDeps, deps };
}

function mapArtifact(): FeatureMapWriteResultV1 {
  // The renderer is verified separately; this fixture exercises only wizard delivery/open failure.
  return {
    schemaVersion: 1,
    kind: "feature_map_artifact",
    htmlPath: `${ROOT}/.untangle/feature-map/snapshot.html`,
    jsonPath: `${ROOT}/.untangle/feature-map/snapshot.json`,
    sha256: { html: "a".repeat(64), json: "b".repeat(64) },
    summary: {
      status: "needs_manifest",
      features: 0,
      shownNodes: 0,
      totalNodes: 0,
      shownEdges: 0,
      totalEdges: 0,
      truncated: false,
      mappedCodeFiles: 0,
      unmappedCodeFiles: 0,
      inventoryFiles: 0,
    },
    graph: {
      schemaVersion: 1,
      sourceTreeDigest: "c".repeat(64),
      nodes: [],
      edges: [],
      summary: {
        status: "needs_manifest",
        features: 0,
        shownNodes: 0,
        totalNodes: 0,
        shownEdges: 0,
        totalEdges: 0,
        truncated: false,
        mappedCodeFiles: 0,
        unmappedCodeFiles: 0,
        inventoryFiles: 0,
      },
      limits: { maxNodes: 500, maxEdges: 2000 },
      limitations: [],
      issues: [],
      dependencyCycles: [],
    },
    report: {
      schemaVersion: 1,
      root: ROOT,
      status: "needs_manifest",
      manifest: { path: "untangle.features.json", status: "missing" },
      sourceTreeDigest: "c".repeat(64),
      inventory: { files: 0, truncated: false, excluded: 0 },
      semanticConformance: "not_independently_proven",
      ownershipAuthority: "manifest_declarations",
      features: [],
      coverage: {
        measuredCodeFiles: 0,
        mappedCodeFiles: 0,
        unmappedCodeFiles: [],
        unmappedCodeFileCount: 0,
        sharedFiles: [],
        mappedCodeUnion: null,
      },
      dependencyCycles: [],
      issues: [],
      limitations: [],
      draft: { schemaVersion: 1, owners: [], features: [] },
    },
  };
}

describe("guided init orchestration", () => {
  it("previews detected Spec Kit without writing when the final setup is cancelled", async () => {
    const h = harness(["spec", "spec-kit", "done", "no", "cancel"], ["", "", ""]);
    seedSpecKit(h.fs);
    const writes = watchWrites(h.fs);
    const writeSdd = vi.fn<NonNullable<InitWizardDepsV1["writeSdd"]>>();
    const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, { ...h.deps, writeSdd });
    expect(result).toEqual({ result: null, exitCode: EXIT.cancelled });
    expect(h.script.messages.join("\n")).toContain("SDD preview: connected; 1 proposed features");
    expect(h.script.messages.join("\n")).toContain("No framework commands or tests will run");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(writeSdd).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.writeMap).not.toHaveBeenCalled();
    expect(h.script.remaining).toEqual([]);
  });

  it("uses the explicitly confirmed SDD draft for final init and the map without confirming implementation", async () => {
    const h = harness(["spec", "spec-kit", "done", "yes", "no", "prepare"], ["", "", ""]);
    seedSpecKit(h.fs);
    const manifestPath = `${ROOT}/.untangle/sdd/fixture/untangle.features.json`;
    const writeSdd = vi
      .fn<NonNullable<InitWizardDepsV1["writeSdd"]>>()
      .mockImplementation(async (report) => {
        await h.fs.mkdir(`${ROOT}/.untangle/sdd/fixture`, { recursive: true });
        await h.fs.writeFile(manifestPath, new TextEncoder().encode(JSON.stringify(report.draft)));
        return {
          schemaVersion: 1,
          kind: "sdd_connection_artifact",
          report,
          manifestPath,
          reportPath: `${ROOT}/.untangle/sdd/fixture/report.json`,
          sha256: { report: "a".repeat(64), manifest: "b".repeat(64) },
        };
      });
    h.writeMap.mockResolvedValue(mapArtifact());
    const result = await runInitWizard(h.ctx, { ...OPTIONS, offline: true }, h.initDeps, {
      ...h.deps,
      writeSdd,
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(writeSdd).toHaveBeenCalledOnce();
    expect(h.apply.mock.invocationCallOrder[0]).toBeLessThan(writeSdd.mock.invocationCallOrder[0]!);
    expect(h.initialize.mock.calls[0]![0].dryRun).toBe(true);
    expect(h.initialize.mock.calls[0]![0].featureManifestPath).toBeUndefined();
    expect(h.initialize.mock.calls[1]![0]).toMatchObject({
      dryRun: false,
      featureManifestPath: manifestPath,
    });
    expect(h.writeMap).toHaveBeenCalledWith({ root: ROOT, manifestPath, signal: h.ctx.signal });
    expect(result.result?.findings.featureAlignment?.manifest.status).toBe("loaded");
    expect(result.result?.findings.featureAlignment?.features[0]).toMatchObject({
      stage: "planned",
      review: "proposed",
      testEvidence: { status: "not_run" },
    });
    expect(writeSdd.mock.calls[0]![0].draft.owners).toEqual([]);
    expect(h.script.remaining).toEqual([]);
  });

  it("rejects stale SDD previews before configuration, analyzer or connector actions", async () => {
    const h = harness(["spec", "spec-kit"], ["", "", ""]);
    seedSpecKit(h.fs);
    const writes = watchWrites(h.fs);
    const writeSdd = vi.fn<NonNullable<InitWizardDepsV1["writeSdd"]>>();
    const discoverSdd = vi
      .fn<NonNullable<InitWizardDepsV1["discoverSdd"]>>()
      .mockImplementation(async (options) => ({
        ...(await discoverSddArtifacts(options)),
        status: "stale",
      }));
    await expect(
      runInitWizard(h.ctx, OPTIONS, h.initDeps, { ...h.deps, writeSdd, discoverSdd }),
    ).rejects.toThrow("SDD sources changed during preview");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    expect(writeSdd).not.toHaveBeenCalled();
    expect(h.initialize).not.toHaveBeenCalled();
  });

  it("cancels at final review without any filesystem write or integration/map/browser action", async () => {
    const h = harness(["quick", "done", "yes", "yes", "cancel"]);
    const writes = watchWrites(h.fs);
    const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps);
    expect(result).toEqual({ result: null, exitCode: EXIT.cancelled });
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(h.initialize).toHaveBeenCalledOnce();
    expect(h.initialize.mock.calls[0]![0].dryRun).toBe(true);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.writeMap).not.toHaveBeenCalled();
    expect(h.openBrowser).not.toHaveBeenCalled();
    expect(h.script.remaining).toEqual([]);
    expect(await h.fs.stat(`${ROOT}/untangle.toml`)).toBeNull();
  });

  it("passes selected spec paths into the real preview and final initializer and map", async () => {
    const h = harness(
      ["spec", "done", "yes", "no", "prepare"],
      ["docs/vision.md", "docs/spec.md", ".untangle/features.json"],
    );
    h.fs.seedFile(`${ROOT}/docs/vision.md`, "# Intent\nLocal declared intent.\n");
    h.fs.seedFile(`${ROOT}/docs/spec.md`, "# Contract\nLocal declared contract.\n");
    h.fs.seedFile(
      `${ROOT}/.untangle/features.json`,
      JSON.stringify({ schemaVersion: 1, owners: [], features: [] }),
    );
    h.writeMap.mockResolvedValue(mapArtifact());
    const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.result?.outcome).toBe("created");
    expect(
      h.initialize.mock.calls.map(([options]) => ({
        dryRun: options.dryRun,
        visionPath: options.visionPath,
        specPath: options.specPath,
        featureManifestPath: options.featureManifestPath,
      })),
    ).toEqual([
      {
        dryRun: true,
        visionPath: "docs/vision.md",
        specPath: "docs/spec.md",
        featureManifestPath: ".untangle/features.json",
      },
      {
        dryRun: false,
        visionPath: "docs/vision.md",
        specPath: "docs/spec.md",
        featureManifestPath: ".untangle/features.json",
      },
    ]);
    expect(
      result.result?.findings.productContext?.sources.find((source) => source.role === "vision")
        ?.path,
    ).toBe("docs/vision.md");
    expect(
      result.result?.findings.productContext?.sources.find(
        (source) => source.role === "specification",
      )?.path,
    ).toBe("docs/spec.md");
    expect(h.writeMap).toHaveBeenCalledWith({
      root: ROOT,
      manifestPath: ".untangle/features.json",
      signal: h.ctx.signal,
    });
    expect(h.openBrowser).not.toHaveBeenCalled();
    expect(h.script.entered).toEqual([]);
  });

  it("keeps stdout to the configuration path while routing setup and detection reports to diagnostics", async () => {
    const h = harness(["quick", "done", "no", "prepare"]);
    const command = createInitCommand({ ...h.initDeps, wizard: h.deps });
    const exit = await command.run(h.ctx, parseArgs(["--interactive"], command.spec.flags));
    expect(exit).toBe(0);
    expect(h.ctx.io.outText).toBe(`${ROOT}/untangle.toml\n`);
    expect(h.ctx.io.errText).toContain("Setup evidence:");
    expect(h.ctx.io.errText).toContain("python ");
    expect(await h.fs.readTextFile(`${ROOT}/untangle.toml`)).toContain("[embeddings]");
    expect(h.script.messages.join("\n")).toContain("nothing has been written");
    expect(h.script.remaining).toEqual([]);
  });

  it("clears explicitly supplied context paths when the user requests discovery with blank answers", async () => {
    const h = harness(["spec", "done", "yes", "no", "prepare"], ["", "", ""]);
    h.fs.seedFile(`${ROOT}/vision.md`, "# Vision\nKeep code easy to find.\n");
    h.fs.seedFile(`${ROOT}/spec.md`, "# Contract\nReport missing evidence honestly.\n");
    h.fs.seedFile(
      `${ROOT}/untangle.features.json`,
      JSON.stringify({ schemaVersion: 1, owners: [], features: [] }),
    );
    h.writeMap.mockResolvedValue(mapArtifact());
    const initial = {
      ...OPTIONS,
      visionPath: "old/vision.md",
      specPath: "old/spec.md",
      featureManifestPath: "old/features.json",
    };
    const result = await runInitWizard(h.ctx, initial, h.initDeps, h.deps);
    expect(result.exitCode).toBe(0);
    expect(h.initialize).toHaveBeenCalledTimes(2);
    for (const [options] of h.initialize.mock.calls) {
      expect(options.visionPath).toBeUndefined();
      expect(options.specPath).toBeUndefined();
      expect(options.featureManifestPath).toBeUndefined();
    }
    expect(
      result.result?.findings.productContext?.sources.find((source) => source.role === "vision")
        ?.path,
    ).toBe("vision.md");
    expect(
      result.result?.findings.productContext?.sources.find(
        (source) => source.role === "specification",
      )?.path,
    ).toBe("spec.md");
    expect(h.writeMap).toHaveBeenCalledWith({ root: ROOT, signal: h.ctx.signal });
    expect(initial).toMatchObject({
      visionPath: "old/vision.md",
      specPath: "old/spec.md",
      featureManifestPath: "old/features.json",
    });
    expect(h.script.entered).toEqual([]);
  });

  it.each(["prepare", "execute"] as const)(
    "keeps tool selection %s distinct from its displayed installation plan",
    async (action) => {
      const h = harness(
        ["quick", "sonarqube-existing", "yes", "done", "no", action],
        ["https://sonar.example.invalid", "demo-project", "DEMO_SONAR_TOKEN"],
      );
      const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps);
      expect(result.exitCode).toBe(0);
      expect(h.apply).toHaveBeenCalledOnce();
      const [plan, applyOptions] = h.apply.mock.calls[0]!;
      expect(plan.selections).toEqual([
        {
          id: "sonarqube-existing",
          endpoint: "https://sonar.example.invalid",
          projectKey: "demo-project",
          tokenEnvVar: "DEMO_SONAR_TOKEN",
          acknowledgeLicense: true,
        },
      ]);
      expect(applyOptions?.execute).toBe(action === "execute");
      expect(h.script.messages.join("\n")).toContain("Setup review");
      expect(h.script.messages.join("\n")).toContain("No tests will run");
      expect(h.writeMap).not.toHaveBeenCalled();
      expect(h.script.remaining).toEqual([]);
    },
  );

  it.each(["sonarqube-local", "sonarqube-existing"] as const)(
    "offers only one Sonar mode after selecting %s and completes preparation",
    async (id) => {
      const inputs =
        id === "sonarqube-existing"
          ? ["https://sonar.example.invalid", "demo-project", "DEMO_SONAR_TOKEN"]
          : ["demo-project", "DEMO_SONAR_TOKEN"];
      const h = harness(["quick", id, "yes", "done", "no", "prepare"], inputs);
      const choose = vi.spyOn(h.script.terminal, "choose");
      const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps);
      const menus = choose.mock.calls.filter(
        ([question]) => question === "Add an analyzer or local search service?",
      );
      expect(menus).toHaveLength(2);
      expect(menus[0]![1].map((choice) => choice.value)).toEqual(
        expect.arrayContaining(["sonarqube-local", "sonarqube-existing"]),
      );
      const remaining = menus[1]![1].map((choice) => choice.value);
      expect(remaining).not.toContain("sonarqube-local");
      expect(remaining).not.toContain("sonarqube-existing");
      expect(remaining).toEqual(expect.arrayContaining(["local-search", "sentrux", "custom"]));
      expect(h.apply).toHaveBeenCalledOnce();
      expect(h.apply.mock.calls[0]![0].selections).toEqual([expect.objectContaining({ id })]);
      expect(h.apply.mock.calls[0]![1]?.execute).toBe(false);
      expect(result.result?.outcome).toBe("created");
      expect(result.exitCode).toBe(0);
      expect(h.script.remaining).toEqual([]);
      expect(h.script.entered).toEqual([]);
    },
  );

  it("routes successful local-search installation to the managed service endpoints during actual final probes", async () => {
    let installed = false;
    const requested: string[] = [];
    const http: HttpProbePort = {
      getJson: async (url) => {
        requested.push(url);
        if (!installed) return null;
        if (url === "http://127.0.0.1:11435/api/version") return { version: "0.5.4" };
        if (url === "http://127.0.0.1:11435/api/tags") return tagsPayload();
        if (url === "http://127.0.0.1:16333/") return { version: "1.12.1" };
        return null;
      },
      probeEmbedding: vi.fn(async () => ({ ok: true as const, dimensions: 1024 })),
    };
    const h = harness(["quick", "local-search", "done", "no", "execute"], [], http);
    h.apply.mockImplementation(async () => {
      installed = true;
      return setupReport([
        {
          id: "local-search",
          status: "installed",
          detail: "Installed owned services",
          files: [],
          executed: [],
          nextSteps: [],
        },
      ]);
    });
    const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.result?.findings.ollama.url).toBe("http://127.0.0.1:11435");
    expect(result.result?.findings.qdrant.url).toBe("http://127.0.0.1:16333");
    expect(requested).toContain("http://127.0.0.1:11435/api/tags");
    expect(h.initialize.mock.calls[1]![1]?.env).toMatchObject({
      UNTANGLE_QDRANT_URL: "http://127.0.0.1:16333",
      UNTANGLE_OLLAMA_URL: "http://127.0.0.1:11435",
    });
    expect(await h.fs.readTextFile(`${ROOT}/untangle.toml`)).toContain(
      'url = "http://127.0.0.1:11435"',
    );
    expect(http.probeEmbedding).toHaveBeenCalledOnce();
  });

  it("does not rewrite config when a selected setup action fails", async () => {
    const h = harness(["quick", "local-search", "done", "no", "execute"]);
    const writes = watchWrites(h.fs);
    h.apply.mockResolvedValue(
      setupReport([
        {
          id: "local-search",
          status: "failed",
          detail: "Docker exited 1",
          files: [],
          executed: [],
          nextSteps: [],
        },
      ]),
    );
    await expect(runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps)).rejects.toThrow(
      "configuration was not changed",
    );
    expect(h.initialize).toHaveBeenCalledOnce();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(h.writeMap).not.toHaveBeenCalled();
    expect(await h.fs.stat(`${ROOT}/untangle.toml`)).toBeNull();
  });

  it("preserves a generated map and successful config when the optional browser launcher fails", async () => {
    const h = harness(["quick", "done", "yes", "yes", "prepare"]);
    h.writeMap.mockResolvedValue(mapArtifact());
    h.openBrowser.mockRejectedValue(new Error("No desktop browser"));
    const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.result?.outcome).toBe("created");
    expect(h.writeMap).toHaveBeenCalledOnce();
    expect(h.openBrowser).toHaveBeenCalledWith(mapArtifact().htmlPath, h.ctx.signal);
    expect(h.ctx.io.errText).toContain(
      "Map saved; browser could not be opened: No desktop browser",
    );
    expect(h.ctx.io.errText).toContain(mapArtifact().htmlPath);
    expect(h.ctx.io.errText).toContain("needs_manifest; no semantic conformance inferred");
    expect(await h.fs.stat(`${ROOT}/untangle.toml`)).not.toBeNull();
  });

  it("allows keeping an existing differing config before any integration or map action", async () => {
    const h = harness(["quick", "keep"]);
    h.fs.seedFile(`${ROOT}/untangle.toml`, "# maintained by its owner\n");
    const writes = watchWrites(h.fs);
    const result = await runInitWizard(h.ctx, OPTIONS, h.initDeps, h.deps);
    expect(result).toEqual({ result: null, exitCode: 0 });
    expect(await h.fs.readTextFile(`${ROOT}/untangle.toml`)).toBe("# maintained by its owner\n");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.writeMap).not.toHaveBeenCalled();
    expect(h.script.remaining).toEqual([]);
  });

  it("cannot offer execution in explicitly offline interactive setup", async () => {
    const h = harness(["quick", "local-search", "done", "no", "prepare"]);
    const result = await runInitWizard(h.ctx, { ...OPTIONS, offline: true }, h.initDeps, h.deps);
    expect(result.exitCode).toBe(0);
    expect(h.apply.mock.calls[0]![0].offline).toBe(true);
    expect(h.apply.mock.calls[0]![1]?.execute).toBe(false);
    expect(result.result?.findings.ollama.outcome).toBe("unreachable");
  });
});

describe("init interactive routing", () => {
  it.each([
    ["--interactive", "--format=json"],
    ["--interactive", "--dry-run"],
  ])("rejects %s with %s before prompts or writes", async (...argv) => {
    const h = harness([]);
    const writes = watchWrites(h.fs);
    const command = createInitCommand({ ...h.initDeps, wizard: h.deps });
    await expect(command.run(h.ctx, parseArgs(argv, command.spec.flags))).rejects.toThrow(
      "cannot be combined",
    );
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(h.script.questions).toEqual([]);
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("rejects explicitly interactive non-TTY setup before source or external actions", async () => {
    const h = harness([]);
    const writes = watchWrites(h.fs);
    const noTTY = scriptedTerminal([], [], false);
    const command = createInitCommand({
      ...h.initDeps,
      wizard: { ...h.deps, terminal: noTTY.terminal },
    });
    await expect(
      command.run(h.ctx, parseArgs(["--interactive"], command.spec.flags)),
    ).rejects.toThrow("requires a terminal");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(noTTY.questions).toEqual([]);
    expect(h.initialize).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("keeps noninteractive existing configuration bytes and emits differences without prompting", async () => {
    const h = harness([]);
    h.fs.seedFile(`${ROOT}/untangle.toml`, "# preserve custom config\n");
    const writes = watchWrites(h.fs);
    const command = createInitCommand({ ...h.initDeps, wizard: h.deps });
    expect(await command.run(h.ctx, parseArgs(["--no-interactive"], command.spec.flags))).toBe(1);
    expect(await h.fs.readTextFile(`${ROOT}/untangle.toml`)).toBe("# preserve custom config\n");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(h.script.questions).toEqual([]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.ctx.io.outText).toBe(`${ROOT}/untangle.toml\n`);
  });

  it("retains the machine-readable config-only path without implicitly starting the wizard", async () => {
    const h = harness([]);
    const command = createInitCommand({ ...h.initDeps, wizard: h.deps });
    expect(await command.run(h.ctx, parseArgs(["--format=json"], command.spec.flags))).toBe(0);
    expect(JSON.parse(h.ctx.io.outText)).toMatchObject({ outcome: "created", exitCode: 0 });
    expect(h.script.questions).toEqual([]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.writeMap).not.toHaveBeenCalled();
  });
});
