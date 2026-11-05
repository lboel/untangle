#!/usr/bin/env node
/**
 * Der ausfuehrbare Einstiegspunkt des Waechters.
 *
 * Er liegt bewusst INNERHALB von `src/commands/watch/`: das Kommando bringt
 * seine eigene Verdrahtung mit (Uhr, Zufall, Signale, Standardausgabe) und
 * haengt an keiner Datei ausserhalb dieses Verzeichnisses. Damit ist der
 * Waechter fuer sich allein baubar und vorfuehrbar, waehrend der uebrige
 * CLI-Rahmen (WP-124) noch entsteht.
 *
 * Zwei Aufrufwege, beide gleichwertig:
 *   node dist/index.js watch [OPTIONEN]              (ueber den CLI-Rahmen)
 *   node dist/commands/watch/cli.js [OPTIONEN]       (direkt)
 */
import { hostname } from "node:os";

import { parseWatchArgs, WATCH_USAGE } from "./options.js";
import { runWatch } from "./run.js";
import { CryptoRandom, SystemClock } from "./runtime.js";

/**
 * Fuehrt `untangle watch` aus und liefert den Exit-Code.
 *
 * 0 = sauber beendet, 1 = Betriebsfehler, 2 = Aufruffehler.
 */
export async function runWatchCli(argv: readonly string[]): Promise<number> {
  // The opt-in index mode needs the full composition root. A URL import keeps
  // build:watch's original complexity-only dependency graph independent.
  if (
    argv.some((arg) =>
      ["--index", "--no-index", "--repo", "--ref", "--embedder"].includes(arg.split("=")[0] ?? ""),
    )
  ) {
    const runtime = (await import(new URL("../../index.js", import.meta.url).href)) as {
      run(args: readonly string[], options: { signal: AbortSignal }): Promise<number>;
    };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      return await runtime.run(["watch", ...argv], { signal: controller.signal });
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
  const parsed = parseWatchArgs(argv, {
    cwd: process.cwd(),
    isTty: process.stdout.isTTY === true,
    noColorEnv: process.env["NO_COLOR"],
  });
  if (!parsed.ok) {
    process.stderr.write(`untangle watch: ${parsed.message}\n\n${WATCH_USAGE}\n`);
    return 2;
  }
  if (parsed.options.help) {
    process.stdout.write(`${WATCH_USAGE}\n`);
    return 0;
  }

  return runWatch(parsed.options, {
    clock: new SystemClock(),
    random: new CryptoRandom(),
    stdout: (chunk) => {
      process.stdout.write(chunk);
    },
    stderr: (chunk) => {
      process.stderr.write(chunk);
    },
    host: hostname(),
    /**
     * SIGINT/SIGTERM. Die Abmeldung wird zurueckgegeben, damit `runWatch`
     * den Griff loesen kann, sobald der Abbau laeuft: ein ZWEITES Strg-C
     * soll dann wieder die Vorgabewirkung haben und hart beenden, statt in
     * einem Waechter zu haengen, der gerade aufraeumt.
     */
    installSignalHandler: (handler) => {
      const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
      const listeners = signals.map((signal) => {
        const listener = (): void => {
          handler(signal);
        };
        process.on(signal, listener);
        return { signal, listener };
      });
      return () => {
        for (const { signal, listener } of listeners) process.off(signal, listener);
      };
    },
  });
}

const isDirectInvocation =
  process.argv[1] !== undefined && process.argv[1].endsWith("commands/watch/cli.js");

if (isDirectInvocation) {
  runWatchCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `untangle watch: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
