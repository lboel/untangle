/**
 * Ein kleiner, abhaengigkeitsfreier Argumentparser.
 *
 * WARUM KEINE BIBLIOTHEK: Die Oberflaeche ist der Ort, an dem E4 am
 * leichtesten verletzt wird — die meisten Parser ignorieren eine unbekannte
 * Option stillschweigend oder schieben sie in die Positionsargumente. Dann
 * tippt ein Nutzer `--explaine` und bekommt eine Ausgabe ohne Zerlegung, ohne
 * je zu erfahren, dass seine Option nie ankam. Dieser Parser LEHNT jede
 * unbekannte Option ab.
 *
 * Unterstuetzt: `--name`, `--name=wert`, `--name wert`, `-k` (Kurzform),
 * `--no-name` (Boolesche Negation), `--` (alles danach ist Positionsargument).
 */

import { UsageError } from "./exit.js";

export type FlagKind = "boolean" | "string" | "number" | "list" | "boolean-or-number";

export interface FlagSpec {
  readonly kind: FlagKind;
  /** Einbuchstabige Kurzform ohne Bindestrich, z. B. "n". */
  readonly alias?: string;
  /** Was hinter der Option steht, z. B. "N" oder "MUSTER". */
  readonly placeholder?: string;
  /** Eine Zeile Hilfetext. */
  readonly describe: string;
  /** Nur zur Anzeige in `--help`. */
  readonly defaultLabel?: string;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

export type FlagValue = boolean | string | number | readonly string[];

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
}

function isNegatedBoolean(token: string): boolean {
  return token.startsWith("--no-");
}

/**
 * Zerlegt `argv` gegen `specs`. Wirft {@link UsageError} bei allem, was nicht
 * eindeutig ist — unbekannte Option, fehlender Wert, keine Zahl.
 */
export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const byAlias = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias !== undefined) byAlias.set(spec.alias, name);
  }

  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  let sawTerminator = false;

  const resolve = (token: string): { name: string; spec: FlagSpec } => {
    const bare = token.startsWith("--") ? token.slice(2) : token.slice(1);
    const name = token.startsWith("--") ? bare : (byAlias.get(bare) ?? bare);
    const spec = specs[name];
    if (spec === undefined) {
      throw new UsageError(
        `Unknown option "${token}".`,
        "See `--help` for this command's supported options.",
      );
    }
    return { name, spec };
  };

  const assign = (name: string, spec: FlagSpec, raw: string): void => {
    if (spec.kind === "number" || spec.kind === "boolean-or-number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new UsageError(
          `Option "--${name}" requires a number; received "${raw}".`,
          `Example: --${name}=10`,
        );
      }
      flags[name] = value;
      return;
    }
    if (spec.kind === "list") {
      const previous = flags[name];
      const list = Array.isArray(previous) ? [...(previous as readonly string[])] : [];
      list.push(raw);
      flags[name] = list;
      return;
    }
    flags[name] = raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (sawTerminator) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      sawTerminator = true;
      continue;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    // --name=wert
    const equals = token.indexOf("=");
    if (token.startsWith("--") && equals > 2) {
      const head = token.slice(0, equals);
      const raw = token.slice(equals + 1);
      const { name, spec } = resolve(head);
      if (spec.kind === "boolean") {
        if (raw !== "true" && raw !== "false") {
          throw new UsageError(
            `Option "--${name}" is a switch accepting only "true" or "false"; received "${raw}".`,
            `Use --${name} or --no-${name}.`,
          );
        }
        flags[name] = raw === "true";
        continue;
      }
      if (spec.kind === "boolean-or-number" && (raw === "true" || raw === "false")) {
        flags[name] = raw === "true";
        continue;
      }
      assign(name, spec, raw);
      continue;
    }

    // --no-name
    if (isNegatedBoolean(token)) {
      const name = token.slice(5);
      const spec = specs[name];
      if (spec === undefined || (spec.kind !== "boolean" && spec.kind !== "boolean-or-number")) {
        throw new UsageError(
          `Unknown switch "${token}".`,
          "See `--help` for this command's supported options.",
        );
      }
      flags[name] = false;
      continue;
    }

    const { name, spec } = resolve(token);
    if (spec.kind === "boolean") {
      flags[name] = true;
      continue;
    }
    if (spec.kind === "boolean-or-number") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "" && Number.isFinite(Number(next))) {
        i++;
        assign(name, spec, next);
      } else {
        flags[name] = true;
      }
      continue;
    }
    const next = argv[i + 1];
    if (
      next === undefined ||
      (next.startsWith("-") && next !== "-" && Number.isNaN(Number(next)))
    ) {
      throw new UsageError(
        `Option "--${name}" requires a value.`,
        `Use --${name}=<${spec.placeholder ?? "value"}> or --${name} <${spec.placeholder ?? "value"}>.`,
      );
    }
    i++;
    assign(name, spec, next);
  }

  return { positionals, flags };
}

/* --- Typisierte Leser. Sie erfinden nichts: fehlt ein Wert, kommt der Default. */

export function boolFlag(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags[name];
  return typeof value === "boolean" ? value : fallback;
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags[name];
  return typeof value === "number" ? value : undefined;
}

export function listFlag(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  return Array.isArray(value) ? [...(value as readonly string[])] : [];
}

/**
 * Liest eine Option, deren Wert aus einer festen Menge stammen MUSS.
 * Ein Tippfehler wird abgelehnt statt auf den Default zurueckzufallen.
 */
export function enumFlag<T extends string>(
  args: ParsedArgs,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = stringFlag(args, name);
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(
    `Option "--${name}" does not support value "${value}" is not supported.`,
    `Choose one of: ${allowed.join(", ")}.`,
  );
}

/** Eine ganze, nicht-negative Zahl — oder eine klare Absage. */
export function integerFlag(args: ParsedArgs, name: string, fallback: number): number {
  const value = numberFlag(args, name);
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(
      `Option "--${name}" requires an integer >= 0; received "${String(value)}".`,
      `Example: --${name}=5`,
    );
  }
  return value;
}
