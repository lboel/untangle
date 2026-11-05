/**
 * Bereitstellung eines Container-Dienstes aus dem Manifest (extensions.md §6.2).
 *
 * Der Ablauf ist bewusst kurz und ohne Werkzeugwissen:
 *
 *   Manifest  →  Compose-Datei rendern  →  up  →  Healthcheck des Manifests
 *
 * Die Compose-Datei entsteht bei jedem Lauf neu aus dem validierten Manifest.
 * Damit gilt der gepinnte Digest wirklich, die Ports binden wirklich an
 * Loopback und die Labels sind wirklich gesetzt — statt in einer mitgebrachten
 * YAML behauptet zu werden, die Untangle nicht geprueft hat.
 *
 * Auf die Gesundheit wartet Untangle SELBST, ueber den Healthcheck aus dem
 * Manifest, statt einen in den Container zu rendern. Ein Healthcheck im
 * Container muesste voraussetzen, welches Programm darin liegt, um eine URL
 * abzufragen — genau das Werkzeugwissen, das X9 aus dem Quelltext heraushaelt.
 */
import { dirname, join } from "node:path";

import type { ExtensionManifestV1, FileSystemPort } from "@untangle-code/domain";
import {
  renderComposeFile,
  type ContainerRuntimePort,
  type ContainerStateV1,
  type HttpRunnerPort,
  type ProcessLimitsV1,
} from "@untangle-code/extension-runtime";

/** Ort der gerenderten Datei: im Nutzer-Datenverzeichnis, nie im Projekt. */
export function composeFilePath(userDataDirectory: string, extensionId: string): string {
  return join(userDataDirectory, "extensions", extensionId, "compose.yaml");
}

/** Der erste Hostport des Manifests, mit optionaler Ueberschreibung. */
export function primaryHostPort(
  manifest: ExtensionManifestV1,
  overrides: Readonly<Record<string, number>> = {},
): number | undefined {
  const port = manifest.container?.ports[0];
  if (port === undefined) {
    return undefined;
  }
  return overrides[port.name] ?? port.hostPortDefault;
}

export interface ProvisionDeps {
  fs: FileSystemPort;
  container: ContainerRuntimePort;
  httpRunner: HttpRunnerPort;
  limits: ProcessLimitsV1;
  /** Wartepause zwischen zwei Gesundheitsproben; injiziert, damit Tests nicht schlafen. */
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ProvisionResultV1 {
  /** True, wenn der Dienst am Ende gesund erreichbar ist. */
  healthy: boolean;
  /** Was getan wurde — auch wenn nichts getan wurde (E4). */
  steps: string[];
  state: ContainerStateV1;
  detail: string;
}

/**
 * Startet den Dienst, falls noetig, und wartet auf seine Gesundheit.
 *
 * Ein bereits laufender, Untangle gehoerender Container wird NICHT neu
 * gestartet: der Lauf soll den Dienst benutzen, nicht bewirtschaften.
 */
export async function provisionContainer(
  deps: ProvisionDeps,
  input: {
    manifest: ExtensionManifestV1;
    userDataDirectory: string;
    hostPorts?: Readonly<Record<string, number>>;
    workspacePath?: string;
    signal?: AbortSignal;
  },
): Promise<ProvisionResultV1> {
  const steps: string[] = [];
  const manifest = input.manifest;
  const container = manifest.container;
  if (container === undefined) {
    const state: ContainerStateV1 = {
      exists: false,
      running: false,
      ownedByUntangle: false,
      detail: "the manifest declares no container block",
    };
    return { healthy: false, steps, state, detail: state.detail };
  }

  const runtime = await deps.container.available(
    input.signal === undefined ? {} : { signal: input.signal },
  );
  steps.push(runtime.detail);
  if (!runtime.available) {
    return {
      healthy: false,
      steps,
      state: {
        exists: false,
        running: false,
        ownedByUntangle: false,
        detail: runtime.detail,
      },
      detail: runtime.detail,
    };
  }

  const path = composeFilePath(input.userDataDirectory, manifest.id);
  const yaml = renderComposeFile({
    manifest,
    ...(input.hostPorts === undefined ? {} : { hostPorts: input.hostPorts }),
    ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
  });
  await deps.fs.mkdir(dirname(path), { recursive: true });
  await deps.fs.writeFile(path, new TextEncoder().encode(yaml));
  steps.push(`rendered ${path} from the manifest (image pinned to ${container.digest})`);

  let state = await deps.container.inspect(
    manifest,
    input.signal === undefined ? {} : { signal: input.signal },
  );
  if (state.exists && !state.ownedByUntangle) {
    steps.push(state.detail);
    return { healthy: false, steps, state, detail: state.detail };
  }
  if (state.running) {
    steps.push("the container was already running; Untangle did not restart it");
  } else {
    const up = await deps.container.up(
      { manifest, composeFilePath: path },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    steps.push(up.detail);
    if (!up.ok) {
      return { healthy: false, steps, state, detail: up.detail };
    }
    state = await deps.container.inspect(
      manifest,
      input.signal === undefined ? {} : { signal: input.signal },
    );
  }

  const health = await waitForHealth(deps, {
    manifest,
    ...(input.hostPorts === undefined ? {} : { hostPorts: input.hostPorts }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  steps.push(health.detail);
  return { healthy: health.healthy, steps, state, detail: health.detail };
}

/**
 * Fragt den Healthcheck des Manifests ab, bis er antwortet oder die erklaerten
 * Versuche erschoepft sind. Ein Dienst, der lange startet, ist kein Fehler —
 * ein Dienst, der nie antwortet, schon, und dann steht der Grund da.
 */
async function waitForHealth(
  deps: ProvisionDeps,
  input: {
    manifest: ExtensionManifestV1;
    hostPorts?: Readonly<Record<string, number>>;
    signal?: AbortSignal;
  },
): Promise<{ healthy: boolean; detail: string }> {
  const check = input.manifest.container?.healthcheck;
  if (check === undefined || check.kind !== "http" || check.httpPath === undefined) {
    return {
      healthy: true,
      detail:
        "the manifest declares no http healthcheck; Untangle treats the container as ready " +
        "without probing and says so rather than implying it checked",
    };
  }
  const port = primaryHostPort(input.manifest, input.hostPorts ?? {});
  if (port === undefined) {
    return { healthy: false, detail: "the manifest declares a healthcheck but no port" };
  }
  const url = `http://127.0.0.1:${String(port)}${check.httpPath}`;
  let lastDetail = "no probe was made";
  for (let attempt = 1; attempt <= check.retries; attempt += 1) {
    const response = await deps.httpRunner.request(
      { url, method: "GET" },
      { ...deps.limits, timeoutMs: check.timeoutMs },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (response.outcome === "completed" && (response.status ?? 500) < 400) {
      return {
        healthy: true,
        detail: `healthcheck ${url} answered ${String(response.status)} after ${String(attempt)} attempt(s)`,
      };
    }
    lastDetail = `attempt ${String(attempt)}: ${response.outcome}${
      response.status === undefined ? "" : ` (status ${String(response.status)})`
    }`;
    if (attempt < check.retries) {
      await deps.wait(check.intervalMs, input.signal);
    }
  }
  return {
    healthy: false,
    detail: `healthcheck ${url} did not answer within ${String(check.retries)} attempts — ${lastDetail}`,
  };
}
