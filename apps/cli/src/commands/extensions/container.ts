/**
 * Die Container-Grenze, bedient ueber ein Compose-fähiges Kommandozeilen-
 * werkzeug des Nutzers.
 *
 * Untangle liefert keine Container-Runtime mit. Es ruft die auf, die auf dem
 * Rechner steht — ueber dieselbe Prozessgrenze wie jedes andere fremde Programm
 * (X4). Welches Kommando das ist, sagt `UNTANGLE_CONTAINER_CLI`; die Vorgabe
 * ist das gebraeuchlichste.
 *
 * Zwei Dinge tragen hier die Sicherheit:
 *
 * 1. **Die Besitzprobe.** Auf einer Entwicklermaschine laufen fremde Container.
 *    `down` und `logs` greifen deshalb nie nach dem Namen allein, sondern
 *    verlangen BEIDE Labels aus §8.2. Findet sich ein Container des erwarteten
 *    Namens ohne sie, wird nichts angefasst und der Grund gemeldet — nicht
 *    „schon gut, ist ja unserer".
 *
 * 2. **Die Compose-Datei kommt von uns.** Sie wird bei jedem Lauf aus dem
 *    validierten Manifest gerendert (siehe `renderComposeFile`), damit der
 *    gepinnte Digest, die Loopback-Bindung und die Labels tatsaechlich gelten
 *    und nicht nur in einer mitgebrachten YAML behauptet werden.
 */
import type { ExtensionManifestV1 } from "@untangle-code/domain";
import {
  composeProjectName,
  EXTENSION_LABEL,
  MANAGED_LABEL,
  type ContainerActionResultV1,
  type ContainerDownInputV1,
  type ContainerLogsResultV1,
  type ContainerRuntimeAvailabilityV1,
  type ContainerRuntimePort,
  type ContainerStateV1,
  type ContainerUpInputV1,
} from "@untangle-code/extension-runtime";
import type { ProcessLimitsV1, ProcessRunnerPort } from "@untangle-code/extension-runtime";

/** Vorgabe des Kommandos; ueberschreibbar mit `UNTANGLE_CONTAINER_CLI`. */
export const DEFAULT_CONTAINER_CLI = "docker";

/** Name des Containers einer Extension — bewusst vorhersagbar, nie geraten. */
export function containerNameFor(extensionId: string): string {
  return `untangle-ext-${extensionId}`;
}

const INSPECT_FORMAT =
  `{{index .Config.Labels "${MANAGED_LABEL}"}}\t` +
  `{{index .Config.Labels "${EXTENSION_LABEL}"}}\t` +
  `{{.State.Running}}\t{{.Config.Image}}`;

export interface ContainerCliOptions {
  processRunner: ProcessRunnerPort;
  limits: ProcessLimitsV1;
  /** Kommando der Container-Runtime; kommt aus der Umgebung, nicht aus dem Quelltext. */
  command?: string;
  env?: Readonly<Record<string, string>>;
}

export function createContainerCli(options: ContainerCliOptions): ContainerRuntimePort {
  const command = options.command ?? DEFAULT_CONTAINER_CLI;

  const run = async (
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; detail: string }> => {
    const result = await options.processRunner.run(
      {
        command,
        args: [...args],
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      options.limits,
      signal === undefined ? {} : { signal },
    );
    const ok = result.outcome === "completed" && (result.exitCode ?? 1) === 0;
    return {
      ok,
      stdout: result.stdout,
      stderr: result.stderr,
      detail: ok
        ? `${command} ${args[0] ?? ""} succeeded`
        : `${command} ${args.join(" ")} failed (${result.outcome}, exit ${String(result.exitCode)})` +
          `${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().slice(0, 300)}`}`,
    };
  };

  return {
    async available(opts = {}): Promise<ContainerRuntimeAvailabilityV1> {
      const result = await run(["version", "--format", "{{.Server.Version}}"], opts.signal);
      if (!result.ok) {
        return {
          available: false,
          detail:
            `no container runtime answered: ${result.detail}. Untangle neither ships nor starts ` +
            `one; set UNTANGLE_CONTAINER_CLI if the command is named differently.`,
        };
      }
      const version = result.stdout.trim();
      return {
        available: true,
        detail: `container runtime ${version} answered on "${command}"`,
        ...(version === "" ? {} : { version }),
      };
    },

    async inspect(manifest: ExtensionManifestV1, opts = {}): Promise<ContainerStateV1> {
      const name = containerNameFor(manifest.id);
      const result = await run(["inspect", name, "--format", INSPECT_FORMAT], opts.signal);
      if (!result.ok) {
        return {
          exists: false,
          running: false,
          ownedByUntangle: false,
          detail: `no container named "${name}" exists`,
        };
      }
      const [managed, extensionId, running, image] = result.stdout.trim().split("\t");
      const owned = managed === "true" && extensionId === manifest.id;
      if (!owned) {
        // Der Name allein beweist nichts. Ohne beide Labels ist der Container
        // fremd, und fremde Container fasst Untangle nicht an (spec.md §3.2).
        return {
          exists: true,
          running: running === "true",
          ownedByUntangle: false,
          detail:
            `a container named "${name}" exists but does not carry ${MANAGED_LABEL}=true and ` +
            `${EXTENSION_LABEL}=${manifest.id}; Untangle does not touch containers it did not create`,
        };
      }
      const digest = /@(sha256:[0-9a-f]{64})$/.exec(image ?? "")?.[1];
      return {
        exists: true,
        running: running === "true",
        ownedByUntangle: true,
        ...(digest === undefined ? {} : { imageDigest: digest }),
        detail: `container "${name}" is ${running === "true" ? "running" : "stopped"}`,
      };
    },

    async up(input: ContainerUpInputV1, opts = {}): Promise<ContainerActionResultV1> {
      const state = await this.inspect(input.manifest, opts);
      if (state.exists && !state.ownedByUntangle) {
        return { ok: false, detail: state.detail };
      }
      const result = await run(
        [
          "compose",
          "--project-name",
          composeProjectName(input.manifest.id),
          "--file",
          input.composeFilePath,
          "up",
          "--detach",
        ],
        opts.signal,
      );
      return { ok: result.ok, detail: result.detail };
    },

    async down(input: ContainerDownInputV1, opts = {}): Promise<ContainerActionResultV1> {
      const state = await this.inspect(input.manifest, opts);
      if (state.exists && !state.ownedByUntangle) {
        return { ok: false, detail: state.detail };
      }
      const result = await run(
        [
          "compose",
          "--project-name",
          composeProjectName(input.manifest.id),
          "--file",
          input.composeFilePath,
          "down",
          ...(input.removeVolumes ? ["--volumes"] : []),
        ],
        opts.signal,
      );
      return { ok: result.ok, detail: result.detail };
    },

    async logs(
      input: { manifest: ExtensionManifestV1; composeFilePath: string; tail: number },
      opts = {},
    ): Promise<ContainerLogsResultV1> {
      const state = await this.inspect(input.manifest, opts);
      if (state.exists && !state.ownedByUntangle) {
        return { ok: false, text: "", detail: state.detail };
      }
      if (!state.exists) {
        return { ok: false, text: "", detail: state.detail };
      }
      const result = await run(
        [
          "compose",
          "--project-name",
          composeProjectName(input.manifest.id),
          "--file",
          input.composeFilePath,
          "logs",
          "--no-color",
          "--tail",
          String(input.tail),
        ],
        opts.signal,
      );
      return { ok: result.ok, text: result.stdout, detail: result.detail };
    },
  };
}
