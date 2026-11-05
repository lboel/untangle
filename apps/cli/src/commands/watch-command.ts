/**
 * `watch` als Unterbefehl des CLI-Rahmens (WP-124) — die Naht zwischen dem
 * Befehlsvertrag aus `src/cli/command.ts` und dem Komplexitaetswaechter aus
 * `src/commands/watch/` (WP-128).
 *
 * WARUM DIESE DATEI HIER LIEGT UND NICHT IN `commands/watch/`: der Waechter
 * ist bewusst frei von Abhaengigkeiten auf den Rahmen — er baut und laeuft
 * fuer sich allein (`tsconfig.watch.json`, `dist/commands/watch/cli.js`).
 * Die Abhaengigkeit zeigt deshalb in genau eine Richtung: dieser Adapter
 * kennt beide Seiten, der Waechter kennt den Rahmen nicht.
 *
 * WAS DIESE DATEI ERSETZT: `commands/unavailable.ts` fuehrte `watch` bisher
 * als noch nicht gebaute Faehigkeit. Das stimmt nicht mehr; einen fertigen
 * Befehl weiter als unverfuegbar auszuweisen waere dieselbe Unwahrheit wie
 * eine vorgetaeuschte Faehigkeit, nur in die andere Richtung.
 */
import { hostname } from "node:os";
import path from "node:path";

import { enumFlag, integerFlag, stringFlag, type FlagSpecs, type ParsedArgs } from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { EXIT, UsageError } from "../cli/exit.js";

import { runIndexWatch } from "./index-watch.js";
import { parseWatchArgs } from "./watch/options.js";
import { runWatch } from "./watch/run.js";
import { CryptoRandom, SystemClock } from "./watch/runtime.js";

const FLAGS: FlagSpecs = {
  index: {
    kind: "boolean",
    describe: "Keep the search index current: check freshness and update changes serially",
    defaultLabel: "off; otherwise complexity stream",
  },
  repo: {
    kind: "string",
    placeholder: "ID",
    describe: "--index: configured repository; required when several are configured",
  },
  ref: {
    kind: "string",
    placeholder: "NAME",
    describe: "--index: checked-out ref; otherwise the current branch",
  },
  embedder: {
    kind: "string",
    placeholder: "auto|offline",
    describe:
      "--index: current index profile, otherwise service; offline explicitly uses local vectors",
    defaultLabel: "auto",
  },
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Tree to watch",
    defaultLabel: "current directory",
  },
  "repo-id": {
    kind: "string",
    placeholder: "ID",
    describe: "Repository identity for the ref lock",
    defaultLabel: "directory name",
  },
  "ref-id": {
    kind: "string",
    placeholder: "ID",
    describe: "Ref identity for the ref lock",
    defaultLabel: "<repo-id>:working-tree",
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Stream output format; json writes one JSON line per event",
    defaultLabel: "text",
  },
  out: {
    kind: "string",
    placeholder: "FILE",
    describe: "Also save the stream, always without control characters",
  },
  color: {
    kind: "boolean",
    describe: "Terminal colors (--no-color disables them)",
    defaultLabel: "enabled when stdout is a terminal",
  },
  debounce: {
    kind: "number",
    placeholder: "MS",
    describe: "Debounce quiet period",
    defaultLabel: "200",
  },
  reconcile: {
    kind: "number",
    placeholder: "MS",
    describe: "Reconciliation interval; --index: freshness-check interval",
    defaultLabel: "30000",
  },
  "max-file-bytes": {
    kind: "number",
    placeholder: "N",
    describe: "Maximum file size; larger files enter the ledger with a reason",
    defaultLabel: "5242880",
  },
  scopes: {
    kind: "number",
    placeholder: "N",
    describe: "Maximum contribution locations reported per change",
    defaultLabel: "5",
  },
  "exit-after": {
    kind: "number",
    placeholder: "N",
    describe: "Stop cleanly after N changes; --index: after N updates",
    defaultLabel: "on signal only",
  },
  "baseline-only": {
    kind: "boolean",
    describe: "Baseline only; --index: check freshness once and update if needed",
    defaultLabel: "off",
  },
};

/**
 * Setzt die zerlegten Flags in die kanonische Aufrufform des Waechters
 * zurueck und laesst dessen EIGENEN Parser darueber laufen.
 *
 * Das sieht nach einem Umweg aus und ist genau deshalb richtig: Vorgaben,
 * Wertebereiche und Fehlermeldungen des Waechters stehen damit an EINER
 * Stelle (`watch/options.ts`) und koennen zwischen dem Rahmenaufruf
 * (`untangle watch`) und dem Direktaufruf (`dist/commands/watch/cli.js`)
 * nicht auseinanderlaufen. Eine zweite, hier nachgebaute Vorgabenliste waere
 * die klassische Stelle, an der ein Werkzeug je nach Aufrufweg etwas anderes
 * tut.
 */
function toWatchArgv(args: ParsedArgs): string[] {
  const argv: string[] = [];
  const push = (name: string, value: unknown): void => {
    if (value === undefined) return;
    argv.push(`--${name}`, String(value));
  };
  push("root", args.flags["root"]);
  push("repo-id", args.flags["repo-id"]);
  push("ref-id", args.flags["ref-id"]);
  push("format", args.flags["format"]);
  push("out", args.flags["out"]);
  push("debounce", args.flags["debounce"]);
  push("reconcile", args.flags["reconcile"]);
  push("max-file-bytes", args.flags["max-file-bytes"]);
  push("scopes", args.flags["scopes"]);
  push("exit-after", args.flags["exit-after"]);
  if (args.flags["color"] === false) argv.push("--no-color");
  if (args.flags["baseline-only"] === true) argv.push("--baseline-only");
  return argv;
}

export const watchCommand: Command = {
  spec: {
    name: "watch",
    implementedBy: "commands/watch-command.js",
    summary: "Complexity monitoring: metric deltas for every change",
    usage: "untangle watch [--index] [--root=<PATH>] [--format=json] [--out=<FILE>]",
    details: [
      "--index selects search-index mode: at startup and each --reconcile interval, " +
        "source hashes and the index contract are checked. Stale, incompatible or missing indexes are " +
        "updated serially. --repo is required with multiple repositories; a ref that is not checked out " +
        "is never updated. --format=json emits index status as JSONL; index reports go to stderr.",
      "Watches a tree and reports each metric's delta for every change, " +
        "structural, semantic, cyclomatic, cognitive, including direction: did the " +
        'change reduce or increase complexity? "cognitive 34 -> 21 ' +
        '(-13, reduced)" describes the change rather than only a raw number.',
      "The three scope metrics aggregate by metrics_scope_id without " +
        "double-counting, using execution_unit scope (spec.md §16.10). The " +
        "semantic load sums the file's chunks and therefore uses " +
        "file_chunks scope. Each number identifies its measurement scope.",
      "A file that could not be analyzed appears in the same stream, " +
        "with a reason and details. Silently omitted files could make " +
        "a partial result appear complete; " +
        "silence does not prove that nothing changed.",
      "Reduced means complexity decreased. It does not prove that " +
        "the change improved the code; vision.md §1b requires " +
        "an unchanged symbol interface, unchanged tests and unchanged " +
        "dependency edges, which this command does not measure.",
      "SIGINT/SIGTERM stops cleanly: watcher stopped, stream closed, " +
        "the ref lock released. The final event reports whether the lock was " +
        "actually released, based on an inspection.",
    ],
    flags: FLAGS,
    examples: [
      "untangle watch",
      "untangle watch --format=json --out=complexity.jsonl",
      "untangle watch --root=packages/search --scopes=3",
      "untangle watch --baseline-only",
      "untangle watch --index --reconcile=30000",
      "untangle watch --index --repo=backend --embedder=offline --format=json",
    ],
    exitCodes: [
      [EXIT.ok, "Stopped cleanly."],
      [EXIT.operational, "Operational error; for example, another run holds the ref lock."],
      [EXIT.usage, "Invalid arguments."],
      [EXIT.environment, "--index: indexing or environment is not ready."],
      [EXIT.cancelled, "--index: cancelled cleanly by a signal."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    if (args.positionals.length > 0) {
      throw new UsageError(
        `"untangle watch" does not accept positional arguments; received "${args.positionals[0] ?? ""}".`,
        "Specify the watched tree with --root.",
      );
    }

    if (args.flags["index"] === true) {
      for (const name of ["repo-id", "ref-id", "debounce", "max-file-bytes", "scopes", "color"]) {
        if (args.flags[name] !== undefined)
          throw new UsageError(
            `--${name} applies to the complexity watcher, not --index.`,
            "Use --repo/--ref to select the index and --reconcile for the check interval.",
          );
      }
      const intervalMs = integerFlag(args, "reconcile", 30_000);
      const maxRefreshes =
        args.flags["exit-after"] === undefined ? null : integerFlag(args, "exit-after", 1);
      if (intervalMs === 0 || intervalMs > 2_147_483_647 || maxRefreshes === 0) {
        throw new UsageError(
          "--reconcile and --exit-after must be positive integers; --reconcile is limited to 2147483647 ms.",
          "Example: untangle watch --index --reconcile=30000.",
        );
      }
      const repo = stringFlag(args, "repo");
      const ref = stringFlag(args, "ref");
      const out = stringFlag(args, "out");
      return runIndexWatch(ctx, {
        root: path.resolve(ctx.cwd, stringFlag(args, "root") ?? "."),
        ...(repo === undefined ? {} : { repo }),
        ...(ref === undefined ? {} : { ref }),
        embedder: enumFlag(args, "embedder", ["auto", "offline"] as const, "auto"),
        intervalMs,
        format: enumFlag(args, "format", ["text", "json"] as const, "text"),
        outPath: out === undefined ? null : path.resolve(ctx.cwd, out),
        once: args.flags["baseline-only"] === true,
        maxRefreshes,
      });
    }
    if (["repo", "ref", "embedder"].some((name) => args.flags[name] !== undefined)) {
      throw new UsageError(
        "--repo, --ref and --embedder require --index.",
        "The complexity watcher uses --repo-id and --ref-id.",
      );
    }

    const parsed = parseWatchArgs(toWatchArgv(args), {
      cwd: ctx.cwd,
      isTty: process.stdout.isTTY === true,
      noColorEnv: ctx.env["NO_COLOR"],
    });
    if (!parsed.ok) {
      throw new UsageError(parsed.message, 'See "untangle watch --help" for supported options.');
    }

    const exitCode = await runWatch(parsed.options, {
      clock: new SystemClock(),
      random: new CryptoRandom(),
      stdout: (chunk) => {
        ctx.io.out(chunk);
      },
      stderr: (chunk) => {
        ctx.io.err(chunk);
      },
      host: hostname(),
      /**
       * Der Rahmen faengt SIGINT/SIGTERM bereits ab und bricht `ctx.signal`
       * ab; der Waechter haengt sich deshalb an DIESES Signal statt einen
       * zweiten Griff auf denselben Prozess zu legen. Die zurueckgegebene
       * Abmeldung loest den Zuhoerer, sobald der Abbau laeuft.
       */
      installSignalHandler: (handler) => {
        if (ctx.signal.aborted) {
          handler("SIGINT");
          return () => undefined;
        }
        const onAbort = (): void => {
          handler("SIGINT");
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        return () => {
          ctx.signal.removeEventListener("abort", onAbort);
        };
      },
    });

    return exitCode === 0 ? EXIT.ok : EXIT.operational;
  },
};
