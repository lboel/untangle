/**
 * Der einzige Ort, an dem Untangle ein fremdes Programm startet
 * (extensions.md X4, §6.4, §10.2).
 *
 * `spawn` ohne `shell` und mit Argumentarray: es gibt keinen Kommandostring,
 * in den sich etwas hineininterpretieren liesse. Zeitbudget und
 * Ausgabegroessenbudget werden hier durchgesetzt, nicht im Aufrufer — sonst
 * koennte ein Werkzeug den Indexer aushungern.
 *
 * Der Runner WIRFT NICHT. Auch ein nicht vorhandenes Programm liefert ein
 * Ergebnis mit `outcome: "spawn_failed"` und Begruendung: eine fehlende
 * Extension ist nie ein Fehler des Kerns (X2), und ein verschluckter
 * Fehlschlag waere ein Defekt (E4).
 */
import { spawn } from "node:child_process";

import type { Clock } from "@untangle-code/domain";

import type {
  ProcessInvocationV1,
  ProcessLimitsV1,
  ProcessResultV1,
  ProcessRunnerPort,
} from "./types.js";
import { DEFAULT_KILL_GRACE_MS } from "./types.js";

/** Sammelt einen Stream bis zu einer Byte-Obergrenze. */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private collected = 0;
  private total = 0;

  public constructor(private readonly maxBytes: number) {}

  public push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.collected >= this.maxBytes) {
      return;
    }
    const remaining = this.maxBytes - this.collected;
    const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.chunks.push(slice);
    this.collected += slice.length;
  }

  public get truncated(): boolean {
    return this.total > this.collected;
  }

  public get totalBytes(): number {
    return this.total;
  }

  public text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Startet externe Programme ueber `node:child_process`.
 *
 * `clock` liefert die Laufzeitmessung — `Date.now()` ist in dieser Codebasis
 * verboten, weil es Ergebnisse nicht reproduzierbar macht.
 */
export function createNodeProcessRunner(clock: Clock): ProcessRunnerPort {
  return {
    run(
      invocation: ProcessInvocationV1,
      limits: ProcessLimitsV1,
      options: { signal?: AbortSignal } = {},
    ): Promise<ProcessResultV1> {
      const startedAt = clock.nowEpochMs();
      const stdout = new BoundedBuffer(limits.maxOutputBytes);
      const stderr = new BoundedBuffer(limits.maxOutputBytes);

      return new Promise<ProcessResultV1>((resolve) => {
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        let pendingOutcome: ProcessResultV1["outcome"] | undefined;
        let pendingDetail: string | undefined;

        const child = spawn(invocation.command, [...invocation.args], {
          // NIEMALS `shell: true` — siehe Modulkopf und extensions.md X4.
          shell: false,
          ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
          ...(invocation.env === undefined ? {} : { env: { ...invocation.env } }),
          stdio: ["pipe", "pipe", "pipe"],
        });

        const finish = (
          outcome: ProcessResultV1["outcome"],
          exitCode: number | null,
          signal: string | null,
          failureDetail?: string,
        ): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutTimer);
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
          }
          options.signal?.removeEventListener("abort", onAbort);
          resolve({
            outcome,
            exitCode,
            signal,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutBytes: stdout.totalBytes,
            stderrBytes: stderr.totalBytes,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            wallTimeMs: clock.nowEpochMs() - startedAt,
            ...(failureDetail === undefined ? {} : { failureDetail }),
          });
        };

        /** Beendet den Prozess: erst freundlich, nach der Frist hart. */
        const terminate = (outcome: ProcessResultV1["outcome"], detail: string): void => {
          pendingOutcome = outcome;
          pendingDetail = detail;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, limits.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
          killTimer.unref?.();
        };

        function onAbort(): void {
          terminate("cancelled", "the run was cancelled through its AbortSignal");
        }

        const timeoutTimer = setTimeout(() => {
          terminate(
            "timeout",
            `time budget of ${String(limits.timeoutMs)} ms exceeded; the process was terminated`,
          );
        }, limits.timeoutMs);
        timeoutTimer.unref?.();

        if (options.signal !== undefined) {
          if (options.signal.aborted) {
            child.kill("SIGKILL");
            finish("cancelled", null, "SIGKILL", "the run was already cancelled before it started");
            return;
          }
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
          if (stdout.truncated && pendingOutcome === undefined) {
            terminate(
              "output_limit_exceeded",
              `output exceeded the limit of ${String(limits.maxOutputBytes)} bytes on stdout`,
            );
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
        });

        child.on("error", (error: Error) => {
          // Haeufigster Fall: das Programm existiert nicht (ENOENT). Das ist
          // eine fehlende Extension, kein Absturz (X2).
          finish("spawn_failed", null, null, error.message);
        });

        child.on("close", (code, signal) => {
          finish(pendingOutcome ?? "completed", code, signal, pendingDetail);
        });

        if (invocation.stdin !== undefined) {
          child.stdin?.end(invocation.stdin);
        } else {
          child.stdin?.end();
        }
      });
    },
  };
}
