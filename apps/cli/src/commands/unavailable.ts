/**
 * DER BAUPLAN fuer Befehle, deren Faehigkeit es NOCH NICHT GIBT.
 *
 * STAND: DIESE DATEI FUEHRT DERZEIT KEINEN BEFEHL MEHR. `watch` ist mit
 * WP-128 hier ausgezogen, `graph` und `flow` mit WP-229 — beide lesen den
 * Graphen jetzt wirklich zurueck (`commands/graph/`, `commands/flow/`).
 * Geblieben ist {@link createUnavailableCommand}: der Bauplan fuer den
 * naechsten Befehl, der angelegt, aber noch nicht gebaut ist. Er wird
 * absichtlich NICHT geloescht — die Alternative zu einem ehrlichen
 * Platzhalter ist erfahrungsgemaess kein fertiger Befehl, sondern ein
 * stiller.
 *
 * Sie stehen in der Oberflaeche, weil ihre Abwesenheit sonst unsichtbar waere
 * — ein Nutzer wuesste nicht, ob `untangle index` fehlt, falsch geschrieben
 * ist oder heimlich nichts tut. BUILD_PLAN E4 verlangt genau das Gegenteil:
 * jedes Ueberspringen bekommt einen Grund.
 *
 * Deshalb tut jeder dieser Befehle drei Dinge und nichts sonst:
 *   1. er sagt, WAS fehlt — pruefbar, mit Paket- und Typnamen;
 *   2. er sagt, was HEUTE schon geht, wenn es etwas gibt;
 *   3. er nennt GENAU EINEN naechsten Schritt.
 * Und er endet mit Exit-Code 3, nie mit 0 und nie mit 1.
 */

import type { FlagSpecs } from "../cli/args.js";
import type { Command, CommandContext, CommandSpec } from "../cli/command.js";
import { wrap } from "../cli/command.js";
import { EXIT, UnavailableError } from "../cli/exit.js";
import { note } from "../cli/io.js";

const COMMON_FLAGS: FlagSpecs = {
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Project directory; configuration is discovered from here.",
    defaultLabel: "current directory",
  },
};

interface UnavailableDefinition {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  /** Was fehlt — die pruefbare Aussage, nicht „nicht implementiert". */
  readonly missing: readonly string[];
  /** Was heute schon geht; leer, wenn es nichts gibt. */
  readonly worksToday?: readonly string[];
  /** GENAU EIN naechster Schritt. */
  readonly nextStep: string;
  readonly extraFlags?: FlagSpecs;
}

export function createUnavailableCommand(definition: UnavailableDefinition): Command {
  const spec: CommandSpec = {
    name: definition.name,
    // Alle drei Platzhalter kommen aus DIESEM Modul. Das ist die Kehrseite
    // von `implementedBy`: ein Befehl, der hierher zeigt, gibt zu, dass
    // seine Faehigkeit noch fehlt (`notYetBuilt`) — und ein Befehl, der
    // NICHT hierher zeigt, behauptet das Gegenteil und wird daran gemessen.
    implementedBy: "commands/unavailable.js",
    summary: `${definition.summary}; not available yet`,
    usage: definition.usage,
    details: [
      `This command is registered, but its capability is not implemented. It performs no action and exits with code ${String(EXIT.unavailable)}; it neither reports success nor invents an operational error.`,
      ...definition.missing,
      ...(definition.worksToday ?? []),
    ],
    flags: { ...COMMON_FLAGS, ...(definition.extraFlags ?? {}) },
    exitCodes: [[EXIT.unavailable, "This capability is not implemented."]],
    notYetBuilt: true,
  };

  return {
    spec,
    run(ctx: CommandContext): Promise<number> {
      note(ctx.io, `untangle ${definition.name}: not available yet.`);
      note(ctx.io, "");
      for (const paragraph of definition.missing) {
        for (const wrapped of wrap(paragraph, 76)) note(ctx.io, `  ${wrapped}`);
        note(ctx.io, "");
      }
      for (const paragraph of definition.worksToday ?? []) {
        for (const wrapped of wrap(paragraph, 76)) note(ctx.io, `  ${wrapped}`);
        note(ctx.io, "");
      }
      throw new UnavailableError(
        `The capability behind "untangle ${definition.name}" is not implemented.`,
        definition.nextStep,
      );
    },
  };
}
