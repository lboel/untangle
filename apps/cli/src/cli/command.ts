/**
 * Der Vertrag eines Unterbefehls und die Hilfe-Ausgabe.
 *
 * Die Hilfe wird AUS DER SPEZIFIKATION erzeugt, nicht danebengeschrieben.
 * Eine handgepflegte Hilfe ist die erste Stelle, an der ein Werkzeug luegt:
 * die Option verschwindet, der Text bleibt. Hier kann das nicht passieren —
 * dieselbe `FlagSpecs`, die der Parser akzeptiert, erzeugt den Text.
 */

import { compareCodepoints } from "@untangle-code/domain";

import type { FlagSpecs, ParsedArgs } from "./args.js";
import type { Io } from "./io.js";

export interface CommandContext {
  readonly io: Io;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Wird bei SIGINT/SIGTERM ausgeloest; jeder Port bekommt ihn gereicht. */
  readonly signal: AbortSignal;
}

export interface CommandSpec {
  readonly name: string;
  /**
   * Das Modul, das die FAEHIGKEIT dieses Befehls enthaelt — als Spezifikator
   * relativ zu `apps/cli/src`, genau so geschrieben, wie ihn ein Import
   * traegt (z. B. `commands/init/index.js`).
   *
   * Warum eine Zeichenkette und nicht „das ergibt sich doch aus dem Import":
   * WEIL ES SICH NICHT ERGAB. Bis WP-218 lagen zwei Module namens `init`
   * nebeneinander — `commands/init.ts`, ein Stub ohne Erkennung, und
   * `commands/init/index.ts`, die fertige, getestete Implementierung. Der
   * Einstiegspunkt importierte den Stub. Alles uebersetzte, alle Tests
   * liefen gruen, und das ausgelieferte Binaer tat etwas anderes als das,
   * was gebaut worden war. Ein Import allein KANN diesen Fehler nicht
   * melden, weil beide Pfade gueltig sind.
   *
   * Mit diesem Feld ist die Zuordnung eine BEHAUPTUNG, die sich pruefen
   * laesst: `command-wiring.test.ts` laedt das genannte Modul und verlangt,
   * dass der registrierte Befehl DASSELBE OBJEKT ist, das dieses Modul
   * ausliefert — und dass kein zweites Modul im Baum einen Befehl anbietet,
   * der nirgends registriert ist.
   */
  readonly implementedBy: string;
  /** Eine Zeile fuer die Uebersicht in `untangle --help`. */
  readonly summary: string;
  /** Aufrufform, z. B. `untangle query <text> [optionen]`. */
  readonly usage: string;
  /** Absaetze, die den Befehl EHRLICH beschreiben — auch seine Grenzen. */
  readonly details?: readonly string[];
  readonly flags: FlagSpecs;
  readonly examples?: readonly string[];
  /** Welche Exit-Codes dieser Befehl belegt, jeweils mit Bedeutung. */
  readonly exitCodes?: readonly (readonly [number, string])[];
  /**
   * True, wenn der Befehl angelegt, seine Faehigkeit aber noch nicht gebaut
   * ist (siehe `commands/unavailable.ts`).
   *
   * Das Merkmal steht hier und nicht in einer Liste im Einstiegspunkt, weil
   * eine solche Liste driftet: als `watch` gebaut wurde, blieb sie stehen und
   * behauptete weiter, es fehle. Ein Befehl traegt seinen Stand selbst.
   */
  readonly notYetBuilt?: boolean;
}

export interface Command {
  readonly spec: CommandSpec;
  run(ctx: CommandContext, args: ParsedArgs): Promise<number>;
}

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Die Optionszeile einer Option, z. B. `-n, --limit=N`. */
function flagLabel(name: string, spec: FlagSpecs[string]): string {
  const short = spec.alias === undefined ? "    " : `-${spec.alias}, `;
  const value =
    spec.kind === "boolean" || spec.kind === "boolean-or-number"
      ? ""
      : `=<${spec.placeholder ?? "value"}>`;
  return `${short}--${name}${value}`;
}

/** Rendert `--help` eines Unterbefehls. Deterministisch: Optionen codepoint-sortiert. */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [];
  lines.push(`untangle ${spec.name} — ${spec.summary}`, "");
  lines.push("USAGE", `  ${spec.usage}`, "");

  if (spec.details !== undefined && spec.details.length > 0) {
    lines.push("DESCRIPTION");
    for (const paragraph of spec.details) {
      for (const wrapped of wrap(paragraph, 76)) lines.push(`  ${wrapped}`);
      lines.push("");
    }
  }

  const names = Object.keys(spec.flags).sort(compareCodepoints);
  if (names.length > 0) {
    lines.push("OPTIONS");
    const labels = names.map((name) => flagLabel(name, spec.flags[name] as FlagSpecs[string]));
    const width = Math.max(...labels.map((l) => l.length));
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      const flag = spec.flags[name] as FlagSpecs[string];
      const suffix = flag.defaultLabel === undefined ? "" : ` (default: ${flag.defaultLabel})`;
      lines.push(`  ${padEnd(labels[i] as string, width)}  ${flag.describe}${suffix}`);
    }
    lines.push("");
  }

  if (spec.examples !== undefined && spec.examples.length > 0) {
    lines.push("EXAMPLES");
    for (const example of spec.examples) lines.push(`  ${example}`);
    lines.push("");
  }

  if (spec.exitCodes !== undefined && spec.exitCodes.length > 0) {
    lines.push("EXIT-CODES");
    for (const [code, meaning] of spec.exitCodes) lines.push(`  ${String(code)}  ${meaning}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Weicher Zeilenumbruch auf `width` Zeichen; bricht nie mitten im Wort. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/u).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length === 0 ? [""] : lines;
}
