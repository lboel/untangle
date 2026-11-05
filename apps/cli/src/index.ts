#!/usr/bin/env node
/**
 * `untangle` — der Einstiegspunkt (WP-124).
 *
 * Dieses Modul tut vier Dinge und sonst nichts:
 *   1. es waehlt den Unterbefehl,
 *   2. es zerlegt die Argumente gegen dessen Spezifikation,
 *   3. es reicht ein Abbruchsignal durch (SIGINT/SIGTERM),
 *   4. es uebersetzt Fehler in Exit-Codes und Meldungen auf stderr.
 *
 * NUTZDATEN GEHEN NACH STDOUT, ALLES ANDERE NACH STDERR — auch die
 * Hilfetexte zu Fehlern. Das ist die Regel, die `untangle query
 * --format=jsonl | jq` benutzbar haelt.
 */

import { compareCodepoints } from "@untangle-code/domain";

import { parseArgs } from "./cli/args.js";
import { renderCommandHelp, wrap, type Command, type CommandContext } from "./cli/command.js";
import { CliError, EXIT, UsageError } from "./cli/exit.js";
import { line, note, processIo, type Io } from "./cli/io.js";
import { CLI_VERSION } from "./cli/version.js";
import { complexityCommand } from "./commands/complexity.js";
import { doctorCommand } from "./commands/doctor.js";
import { extensionsCommand } from "./commands/extensions.js";
// WP-229: `graph` und `flow` sind GEBAUT und kommen deshalb nicht mehr aus
// `unavailable.ts` — sie lesen den Graphen zurueck, den `untangle index`
// ablegt. Siehe `commands/graph/index.ts` und `commands/flow/index.ts`.
import { flowCommand } from "./commands/flow/index.js";
import { graphCommand } from "./commands/graph/index.js";
// WP-218: die VOLLSTAENDIGE init-Implementierung liegt unter
// `commands/init/`. Bis WP-218 zeigte dieser Import auf einen gleichnamigen
// Stub `commands/init.ts` daneben — gebaut, getestet, aber nie verdrahtet.
// `command-wiring.test.ts` laesst diesen Fehler nicht wiederkehren.
import { indexCommand } from "./commands/index/index.js";
import { initCommand } from "./commands/init/index.js";
import { mcpCommand } from "./commands/mcp.js";
import { productCommand } from "./commands/product.js";
import { queryCommand } from "./commands/query.js";
import { scanCommand } from "./commands/scan.js";
// WP-128: `watch` ist gebaut und wird deshalb NICHT mehr aus
// `unavailable.ts` bezogen. Siehe `commands/watch-command.ts`.
import { watchCommand } from "./commands/watch-command.js";
import { isEntryPoint } from "./entry-point.js";

/** Version des Binaers. Bewusst hier und nicht aus package.json gelesen: der
 * gebaute `dist/` liegt eine Ebene tiefer als das Manifest, und ein Lesefehler
 * beim Start waere ein absurder Grund, an `--version` zu scheitern. */
export { CLI_VERSION } from "./cli/version.js";

/**
 * Die Reihenfolge ist die des Nutzerwegs, nicht das Alphabet: einrichten,
 * indizieren, suchen, messen, verstehen, beobachten, diagnostizieren,
 * erweitern.
 */
export const COMMANDS: readonly Command[] = [
  initCommand,
  indexCommand,
  queryCommand,
  complexityCommand,
  productCommand,
  scanCommand,
  graphCommand,
  flowCommand,
  mcpCommand,
  watchCommand,
  doctorCommand,
  extensionsCommand,
];

const BY_NAME = new Map(COMMANDS.map((command) => [command.spec.name, command]));

function renderRootHelp(): string {
  const lines: string[] = [];
  lines.push("untangle — local code intelligence: search, complexity and graphs.", "");
  lines.push("USAGE", "  untangle <command> [options]", "  untangle <command> --help", "");
  lines.push("COMMANDS");
  const width = Math.max(...COMMANDS.map((command) => command.spec.name.length));
  for (const command of COMMANDS) {
    const name = command.spec.name.padEnd(width);
    lines.push(`  ${name}  ${command.spec.summary}`);
  }
  lines.push("");
  lines.push("GLOBAL OPTIONS");
  lines.push("  -h, --help     Show this help or help for a command.");
  lines.push("  -V, --version  Print the version.");
  lines.push("");
  lines.push("EXIT-CODES");
  lines.push("  0  Success.");
  lines.push("  1  Operational error.");
  lines.push("  2  Invalid arguments.");
  lines.push("  3  Capability not yet implemented.");
  lines.push("  4  Environment not ready (Ollama/Qdrant/index).");
  lines.push("  5  Quality gate failed.");
  lines.push("  130 Cancelled.");
  lines.push("");
  const pending = COMMANDS.filter((command) => command.spec.notYetBuilt === true).map(
    (command) => command.spec.name,
  );
  if (pending.length > 0) {
    lines.push("IMPLEMENTATION STATUS");
    for (const wrapped of wrap(
      `The commands ${pending.join(", ")} are registered, but their capabilities are not yet ` +
        "implemented. They report this explicitly and exit with code 3. " +
        "Use `untangle <command> --help` to inspect the missing capability.",
      76,
    )) {
      lines.push(`  ${wrapped}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Nennt den aehnlichsten Befehl, wenn sich jemand vertippt hat. */
function suggest(name: string): string | undefined {
  const candidates = [...BY_NAME.keys()]
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter((entry) => entry.distance <= 3)
    .sort((a, b) => a.distance - b.distance || compareCodepoints(a.candidate, b.candidate));
  return candidates[0]?.candidate;
}

function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) (rows[i] as number[])[0] = i;
  for (let j = 0; j <= b.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      (rows[i] as number[])[j] = Math.min(
        ((rows[i - 1] as number[])[j] as number) + 1,
        ((rows[i] as number[])[j - 1] as number) + 1,
        ((rows[i - 1] as number[])[j - 1] as number) + cost,
      );
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

export interface RunOptions {
  readonly io?: Io;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

/**
 * Der ganze Ablauf als Funktion — testbar, ohne einen Prozess zu starten.
 * `main()` unten ist nur die duenne Huelle darum.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  const ctx: CommandContext = {
    io,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    signal: options.signal ?? new AbortController().signal,
  };

  const first = argv[0];

  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    io.out(renderRootHelp());
    return EXIT.ok;
  }
  if (first === "--version" || first === "-V") {
    line(io, CLI_VERSION);
    return EXIT.ok;
  }
  if (first.startsWith("-")) {
    return fail(
      io,
      new UsageError(
        `Expected a command, received the option "${first}".`,
        "Run `untangle --help`; the global options are --help and --version.",
      ),
    );
  }

  const command = BY_NAME.get(first);
  if (command === undefined) {
    const hint = suggest(first);
    return fail(
      io,
      new UsageError(
        `Unknown command "${first}".`,
        hint === undefined
          ? "Run `untangle --help` to list all commands."
          : `Did you mean \`untangle ${hint}\`? \`untangle --help\` lists all commands.`,
      ),
    );
  }

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(renderCommandHelp(command.spec));
    return EXIT.ok;
  }

  try {
    const args = parseArgs(rest, command.spec.flags);
    return await command.run(ctx, args);
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * Ein Fehler wird zu genau drei Zeilen auf stderr: was war, was zu tun ist,
 * und — nur wenn es eine Ursache gibt — woran es lag.
 */
function fail(io: Io, error: unknown): number {
  if (error instanceof CliError) {
    note(io, `Error: ${error.message}`);
    if (error.nextStep !== undefined) {
      note(io, `Next step: ${error.nextStep}`);
    }
    return error.exitCode;
  }
  if (error instanceof Error && error.name === "AbortError") {
    note(io, "Cancelled.");
    return EXIT.cancelled;
  }
  note(io, `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  if (
    error instanceof Error &&
    error.stack !== undefined &&
    process.env["UNTANGLE_DEBUG"] === "1"
  ) {
    note(io, error.stack);
  }
  note(io, "Next step: set UNTANGLE_DEBUG=1 and repeat the command to include the stack trace.");
  return EXIT.operational;
}

/**
 * Wartet, bis alles Geschriebene wirklich draussen ist.
 *
 * Noetig, weil {@link main} den Prozess ausdruecklich beendet (siehe dort) —
 * ohne dieses Leeren koennte die letzte Zeile einer Pipe verloren gehen.
 */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.write("", () => {
      resolve();
    });
  });
}

/**
 * Die Prozesshuelle. Nur sie kennt `process`.
 *
 * SIE BEENDET DEN PROZESS AUSDRUECKLICH — und das ist eine Entscheidung, kein
 * Versehen. Ein Adapter darf im Hintergrund noch an einer Anfrage haengen:
 * der Embedding-Adapter etwa wiederholt einen Zeitueberlauf mit Backoff und
 * haelt damit die Ereignisschleife ueber Minuten am Leben, obwohl `doctor`
 * sein Urteil laengst gefaellt und ausgegeben hat (gemessen: Bericht nach
 * 15 s, Prozessende erst nach ueber 3 min). Ein Diagnosewerkzeug, das nach
 * dem Bericht noch minutenlang steht, ist kaputt.
 *
 * Also: Ergebnis ausgeben, Stroeme leeren, beenden. Verschwiegen wird dabei
 * nichts — der abgebrochene Test steht als FEHLSCHLAG im Bericht, nicht als
 * bestanden.
 */
async function main(): Promise<void> {
  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const code = await run(process.argv.slice(2), { signal: controller.signal });

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  await flush(process.stdout);
  await flush(process.stderr);
  process.exit(code);
}

// Nur ausfuehren, wenn dieses Modul das Programm IST — nicht, wenn ein Test es
// importiert. Der Vergleich loest Symlinks auf: `npm install --global` legt das
// Binaer als SYMLINK im globalen bin-Verzeichnis an, und ohne Aufloesung haelte
// sich das global installierte `untangle` faelschlich fuer importiert und taete
// schweigend nichts (siehe entry-point.ts).
if (isEntryPoint(import.meta.url, process.argv[1])) {
  await main();
}
