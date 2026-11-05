/** Terminal-only orchestration; the noninteractive init library remains unchanged. */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { discoverSddArtifacts, type SddConnectionReportV1 } from "@untangle-code/core";

import type { CommandContext } from "../../cli/command.js";
import { EXIT, OperationalError, UsageError } from "../../cli/exit.js";
import { note } from "../../cli/io.js";
import { writeFeatureMap } from "../graph/feature-map.js";
import { writeSddConnection } from "../sdd.js";

import {
  applyIntegrationSetup,
  integrationCatalog,
  planIntegrationSetup,
  type IntegrationSelectionV1,
  type IntegrationSetupPlanV1,
} from "./integrations.js";
import { runInit, type InitDepsV1, type InitOptionsV1 } from "./run.js";
import type { InitResultV1 } from "./types.js";
import type { WizardTerminal } from "./wizard-terminal.js";

export interface InitWizardDepsV1 {
  terminal: WizardTerminal;
  initialize?: typeof runInit;
  planIntegrations?: typeof planIntegrationSetup;
  applyIntegrations?: typeof applyIntegrationSetup;
  writeMap?: typeof writeFeatureMap;
  openBrowser?: (filePath: string, signal: AbortSignal) => Promise<void>;
  discoverSdd?: typeof discoverSddArtifacts;
  writeSdd?: typeof writeSddConnection;
}

/** Open only a generated local file URL; no shell or project-supplied executable. */
export async function openSetupMap(filePath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const url = pathToFileURL(filePath).href;
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command!, args, { stdio: "ignore", signal });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Browser launcher timed out; open the saved HTML file directly."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Browser launcher exited with ${String(code)}.`));
    });
  });
}

async function optionalPath(
  terminal: WizardTerminal,
  label: string,
  current?: string,
): Promise<string | undefined> {
  return (
    (
      await terminal.input(`${label} (relative path; leave blank to use discovery)`, current)
    ).trim() || undefined
  );
}

async function collectSelections(terminal: WizardTerminal): Promise<IntegrationSelectionV1[]> {
  const selections: IntegrationSelectionV1[] = [];
  const offers = integrationCatalog();
  for (;;) {
    const sonarSelected = selections.some(
      (selection) => selection.id === "sonarqube-local" || selection.id === "sonarqube-existing",
    );
    const remaining = offers.filter(
      (offer) =>
        !selections.some((selection) => selection.id === offer.id) &&
        !(sonarSelected && (offer.id === "sonarqube-local" || offer.id === "sonarqube-existing")),
    );
    if (remaining.length === 0) return selections;
    const id = await terminal.choose("Add an analyzer or local search service?", [
      {
        value: "done",
        label:
          selections.length === 0
            ? "Continue without external tools"
            : "Continue with these selections",
      },
      ...remaining.map((offer) => ({
        value: offer.id,
        label: offer.label,
        detail: offer.description,
      })),
    ]);
    if (id === "done") return selections;
    const offer = offers.find((candidate) => candidate.id === id)!;
    terminal.message(`${offer.licenseSummary}\n${offer.documentation}`);
    const selection: IntegrationSelectionV1 = { id: offer.id };
    if (offer.id === "sonarqube-local" || offer.id === "sonarqube-existing") {
      if (offer.id === "sonarqube-existing")
        selection.endpoint = await terminal.input("SonarQube server URL", "http://127.0.0.1:9000");
      selection.projectKey = await terminal.input(
        "Sonar project key (blank: configure after server setup)",
      );
      selection.tokenEnvVar = await terminal.input(
        "Environment variable containing the Sonar token (name only)",
        "SONAR_TOKEN",
      );
    }
    if (offer.id === "custom") {
      selection.manifestPath = await terminal.input(
        "Reviewed extension manifest path or HTTPS URL",
      );
      const digest = await terminal.input(
        "Manifest sha256 digest (required for HTTPS; blank for local file)",
      );
      if (digest) selection.manifestDigest = digest;
      selection.allowProjectLocal =
        (await terminal.choose("Allow this explicitly selected project-local manifest?", [
          { value: "no", label: "No — preserve the existing project trust boundary" },
          {
            value: "yes",
            label: "Yes — I reviewed this manifest and trust its executable/endpoint",
          },
        ])) === "yes";
    }
    if (offer.requiresLicenseAcknowledgment) {
      selection.acknowledgeLicense =
        (await terminal.choose("Acknowledge the displayed license terms for this selected tool?", [
          { value: "no", label: "No — leave this tool unacknowledged" },
          { value: "yes", label: "Yes — I reviewed the applicable terms" },
        ])) === "yes";
    }
    selections.push(selection);
  }
}

function showPlan(
  terminal: WizardTerminal,
  plan: IntegrationSetupPlanV1,
  result: InitResultV1,
  map: boolean,
): void {
  terminal.message(
    `\nSetup review\nProject: ${result.findings.root}\nConfiguration: ${result.configPath}\nConfiguration action: ${result.outcome}\nFeature/code map: ${map ? "create locally under .untangle/feature-map" : "skip"}`,
  );
  for (const item of plan.items) {
    terminal.message(`\n${item.label}`);
    for (const file of item.files) terminal.message(`Write/preserve: ${file.relativePath}`);
    for (const download of item.downloads)
      terminal.message(`Download only if executed: ${download.url}\nSHA256: ${download.sha256}`);
    for (const command of item.commands)
      terminal.message(
        `Action only if executed: ${[command.command, ...command.args].map((part) => JSON.stringify(part)).join(" ")}\n${command.purpose}`,
      );
    for (const blocker of item.blockers) terminal.message(`Needs attention: ${blocker}`);
  }
  terminal.message(
    "No tests will run. Feature ownership remains declared; missing evidence remains visible.",
  );
}

export async function runInitWizard(
  ctx: CommandContext,
  initialOptions: InitOptionsV1,
  initDeps: InitDepsV1,
  deps: InitWizardDepsV1,
): Promise<{ result: InitResultV1 | null; exitCode: number }> {
  const terminal = deps.terminal;
  if (!terminal.interactive)
    throw new UsageError(
      "Interactive setup needs a terminal on stdin and stderr.",
      "Use `untangle init --no-interactive` for pipes or agents.",
    );
  const mode = await terminal.choose("How do you want to start?", [
    {
      value: "quick",
      label: "Quick setup — local code, feature map and optional tools",
      detail:
        "Start without a spec or external services; add declared feature boundaries when ready.",
    },
    {
      value: "spec",
      label: "Spec-driven setup — select intent and feature declarations",
      detail:
        "Link existing vision/specification documents and an explicitly declared feature map.",
    },
  ]);
  let options = { ...initialOptions };
  if (mode === "spec") {
    const visionPath = await optionalPath(terminal, "Vision document", options.visionPath);
    const specPath = await optionalPath(terminal, "Specification document", options.specPath);
    const featureManifestPath = await optionalPath(
      terminal,
      "Feature manifest",
      options.featureManifestPath,
    );
    delete options.visionPath;
    delete options.specPath;
    delete options.featureManifestPath;
    options = {
      ...options,
      ...(visionPath ? { visionPath } : {}),
      ...(specPath ? { specPath } : {}),
      ...(featureManifestPath ? { featureManifestPath } : {}),
    };
  }
  let sdd: SddConnectionReportV1 | undefined;
  if (mode === "spec" && options.featureManifestPath === undefined) {
    const discover = deps.discoverSdd ?? discoverSddArtifacts;
    const discoveryOptions = {
      root: options.root,
      signal: ctx.signal,
      ...(initDeps.fs === undefined ? {} : { fs: initDeps.fs }),
    };
    const detected = await discover({ ...discoveryOptions, framework: "auto" });
    ctx.signal.throwIfAborted();
    if (detected.frameworks.length > 0) {
      const framework = await terminal.choose("Connect detected spec-driven artifacts?", [
        { value: "none", label: "Keep manual context; do not create a connector draft" },
        ...detected.frameworks.map((id) => ({
          value: id,
          label:
            id === "spec-kit"
              ? "Spec Kit — inspect specs, plans and tasks"
              : "OpenSpec — inspect capabilities and changes",
        })),
        ...(detected.frameworks.length > 1
          ? [
              {
                value: "auto",
                label: "Connect both frameworks with separate proposed feature identities",
              },
            ]
          : []),
      ]);
      if (framework !== "none") {
        sdd =
          framework === "auto"
            ? detected
            : await discover({
                ...discoveryOptions,
                framework: framework as "spec-kit" | "openspec",
              });
        ctx.signal.throwIfAborted();
        terminal.message(
          `SDD preview: ${sdd.status}; ${String(sdd.features.length)} proposed features. After confirmation, save a source-bound draft under .untangle/sdd/. No framework commands or tests will run. Implementation and ownership remain unconfirmed.`,
        );
        for (const issue of sdd.issues)
          terminal.message(`${issue.code}: ${issue.path}: ${issue.message}`);
        if (sdd.status === "stale")
          throw new OperationalError(
            "SDD sources changed during preview; restart setup before applying any actions.",
          );
      }
    }
  }
  terminal.message("Inspecting local sources and declared context; nothing has been written.");
  const initialize = deps.initialize ?? runInit;
  const preview = await initialize({ ...options, dryRun: true }, initDeps);
  ctx.signal.throwIfAborted();
  if (preview.configErrors.length > 0) {
    for (const error of preview.configErrors) terminal.message(error);
    return { result: preview, exitCode: EXIT.operational };
  }
  terminal.message(
    `Project: ${preview.findings.projectId}\nLanguages: ${preview.findings.languages.entries.map((entry) => entry.languageId).join(", ") || "none recognized"}\nProduct context: ${preview.findings.productContext?.status ?? "not assessed"}\nFeature evidence: ${preview.findings.featureAlignment?.status ?? "not assessed"}`,
  );
  if (preview.outcome === "would-overwrite" && !options.force) {
    terminal.message(`Existing configuration differs: ${preview.configPath}`);
    for (const change of preview.changes)
      terminal.message(`${change.kind === "added" ? "+" : "-"} ${change.line}`);
    const replace = await terminal.choose("Keep or replace the existing configuration?", [
      { value: "keep", label: "Keep existing configuration and stop without writes" },
      { value: "replace", label: "Replace it with the displayed detection result" },
    ]);
    if (replace === "keep") return { result: null, exitCode: EXIT.ok };
    options = { ...options, force: true };
  }
  const selections = await collectSelections(terminal);
  const map =
    (await terminal.choose("Create a local feature/code map?", [
      {
        value: "yes",
        label: "Yes — interactive 3D local HTML and JSON evidence",
        detail:
          "Declared features, code/tests, ownership and gaps; no index or cloud service needed.",
      },
      { value: "no", label: "Skip the map for now" },
    ])) === "yes";
  const openMap =
    map &&
    (await terminal.choose("Open the feature/code map after setup?", [
      { value: "no", label: "Save the map; I will open it when ready" },
      { value: "yes", label: "Open the generated local map in my browser" },
    ])) === "yes";
  const plan = (deps.planIntegrations ?? planIntegrationSetup)({
    root: preview.findings.root,
    selections,
    offline: options.offline,
  });
  showPlan(terminal, plan, preview, map);
  if (sdd !== undefined)
    terminal.message(
      `SDD review draft: ${sdd.frameworks.join(", ")} → .untangle/sdd/ (${String(sdd.features.length)} proposed features). Existing feature declarations are preserved. The selected draft will be used for this setup's feature report and map.`,
    );
  const actions =
    plan.items.length > 0 && !options.offline
      ? [
          { value: "prepare", label: "Prepare config and recipes only; download/start nothing" },
          { value: "execute", label: "Apply config and execute the displayed tool setup" },
          { value: "cancel", label: "Cancel without writes" },
        ]
      : [
          { value: "prepare", label: "Apply this local setup" },
          { value: "cancel", label: "Cancel without writes" },
        ];
  const action = await terminal.choose("Apply this setup?", actions);
  if (action === "cancel") return { result: null, exitCode: EXIT.cancelled };
  ctx.signal.throwIfAborted();
  // Children run only after prompt cleanup restored the original terminal mode.
  const integrations = await (deps.applyIntegrations ?? applyIntegrationSetup)(plan, {
    execute: action === "execute",
    signal: ctx.signal,
    env: ctx.env,
  });
  note(ctx.io, `Setup evidence: ${integrations.reportPath}`);
  for (const item of integrations.items) {
    note(ctx.io, `${item.id}: ${item.status}`);
    for (const next of item.nextSteps) note(ctx.io, next);
  }
  if (integrations.items.some((item) => item.status === "failed"))
    throw new OperationalError(
      "A selected tool setup failed; configuration was not changed.",
      `Inspect ${integrations.reportPath} before retrying; completed files and services were preserved.`,
    );
  if (sdd !== undefined) {
    const connected = await (deps.writeSdd ?? writeSddConnection)(sdd, { signal: ctx.signal });
    ctx.signal.throwIfAborted();
    if (connected.manifestPath !== null) {
      options = { ...options, featureManifestPath: connected.manifestPath };
      note(ctx.io, `SDD review manifest: ${connected.manifestPath}`);
      note(ctx.io, `SDD source evidence: ${connected.reportPath!}`);
    } else
      note(ctx.io, "No SDD feature draft was saved; inspect the connector's missing evidence.");
  }
  const localSearchInstalled = integrations.items.some(
    (item) => item.id === "local-search" && item.status === "installed",
  );
  const configuredDeps = localSearchInstalled
    ? {
        ...initDeps,
        env: {
          ...ctx.env,
          UNTANGLE_QDRANT_URL: "http://127.0.0.1:16333",
          UNTANGLE_OLLAMA_URL: "http://127.0.0.1:11435",
        },
      }
    : initDeps;
  const result = await initialize({ ...options, dryRun: false }, configuredDeps);
  if (result.exitCode !== EXIT.ok) return { result, exitCode: result.exitCode };
  if (map) {
    terminal.message("Building the local feature/code map from current sources.");
    const artifact = await (deps.writeMap ?? writeFeatureMap)({
      root: preview.findings.root,
      ...(options.featureManifestPath ? { manifestPath: options.featureManifestPath } : {}),
      signal: ctx.signal,
    });
    note(ctx.io, `Feature/code map: ${artifact.htmlPath}`);
    note(ctx.io, `Map evidence: ${artifact.jsonPath}`);
    note(ctx.io, `Feature evidence: ${artifact.summary.status}; no semantic conformance inferred.`);
    if (openMap) {
      try {
        await (deps.openBrowser ?? openSetupMap)(artifact.htmlPath, ctx.signal);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        note(
          ctx.io,
          `Map saved; browser could not be opened: ${error instanceof Error ? error.message : String(error)}. Open the HTML path above directly.`,
        );
      }
    }
  }
  ctx.signal.throwIfAborted();
  return { result, exitCode: EXIT.ok };
}
