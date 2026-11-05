/**
 * Darstellung des Stroms — lesbar im Terminal, maschinenlesbar mit
 * `--format json`.
 *
 * Beide Wege speisen sich aus DENSELBEN `WatchStreamEventV1`-Werten
 * (`events.ts`); die Textform laesst nie etwas weg, was die JSON-Form traegt,
 * ausser den Scope-Deltas jenseits von `--scopes`.
 *
 * FARBE nur, wenn stdout ein TTY ist (`options.ts` entscheidet das, nicht
 * dieses Modul). Eine Mitschrift per `--out` ist deshalb IMMER frei von
 * Steuerzeichen: eine Datei voller ANSI-Sequenzen ist keine Mitschrift,
 * sondern ein Screenshot.
 */
import { METRIC_KEYS, type MetricKey, type WatchStreamEventV1 } from "./events.js";

const RESET = "\u001B[0m";
const PALETTE = {
  abgebaut: "\u001B[32m", // gruen: Komplexitaet abgebaut
  aufgebaut: "\u001B[31m", // rot: Komplexitaet aufgebaut
  unveraendert: "\u001B[2m", // gedimmt
  path: "\u001B[1m",
  warn: "\u001B[33m",
  meta: "\u001B[2m",
} as const;

/** Feste Spaltenbreite, damit vier Metriken untereinander lesbar bleiben. */
const METRIC_LABEL_WIDTH = Math.max(...METRIC_KEYS.map((key) => key.length));
const DIRECTION_LABELS = {
  abgebaut: "reduced",
  aufgebaut: "increased",
  unveraendert: "unchanged",
} as const;

export interface RendererOptions {
  color: boolean;
}

/** Eine Zeile JSON je Ereignis (JSONL) — stabil sortierte Schluessel gibt `JSON.stringify` nicht her, die Feldreihenfolge folgt der Deklaration in `events.ts`. */
export function renderJson(event: WatchStreamEventV1): string {
  return JSON.stringify(event);
}

/** Menschenlesbare Darstellung eines Ereignisses; mehrzeilig, ohne Zeilenumbruch am Ende. */
export function renderText(event: WatchStreamEventV1, options: RendererOptions): string {
  const paint = (text: string, key: keyof typeof PALETTE): string =>
    options.color ? `${PALETTE[key]}${text}${RESET}` : text;
  const stamp = clockOf(event.at);
  const lines: string[] = [];

  switch (event.kind) {
    case "started":
      lines.push(`${stamp}  untangle watch — complexity monitoring`);
      lines.push(`${indent()}Tree   ${event.root}`);
      lines.push(`${indent()}Repo   ${event.repoId}   Ref ${event.refId}`);
      lines.push(`${indent()}Lock   ${event.lockKey}`);
      break;

    case "baseline": {
      lines.push(`${stamp}  Baseline complete (${String(event.durationMs)} ms)`);
      lines.push(
        `${indent()}${String(event.filesAnalyzed)} file(s) measured, ` +
          `${String(event.scopeCount)} Scope(s); ` +
          `${String(event.filesUnanalyzed)} file(s) not analyzed (see above)`,
      );
      lines.push(
        paint(
          `${indent()}${String(event.filesExcludedByRules)} path(s) excluded by ignore rules ` +
            `(.gitignore, default exclusions), not analysis failures`,
          "meta",
        ),
      );
      for (const metric of METRIC_KEYS) {
        lines.push(
          `${indent()}${pad(metric)} ${formatNumber(event.totals[metric]).padStart(9)}` +
            `   ${paint(readingLabel(metric), "meta")}`,
        );
      }
      if (event.scopeIdCollisions > 0 || event.nodeKindFallbacks > 0) {
        lines.push(
          paint(
            `${indent()}Limitation: ${String(event.scopeIdCollisions)} ambiguous ` +
              `adapter scope ID(s) remapped, ${String(event.nodeKindFallbacks)} ` +
              `NodeKindFact(s) assigned through a fallback.`,
            "meta",
          ),
        );
      }
      break;
    }

    case "change": {
      const sign = { added: "+", modified: "~", deleted: "-" }[event.changeKind];
      lines.push(
        `${stamp}  ${sign} ${paint(event.path, "path")}   ` +
          `${paint(verdictLabel(event.verdict), event.verdict)}`,
      );
      for (const delta of event.metrics) {
        const before = delta.previous === null ? "—" : formatNumber(delta.previous);
        const after = delta.current === null ? "—" : formatNumber(delta.current);
        const change = `${formatSigned(delta.delta)}, ${DIRECTION_LABELS[delta.direction]}`;
        lines.push(
          `${indent()}${pad(delta.metric)} ${before.padStart(7)} -> ${after.padStart(7)}  ` +
            paint(`(${change})`, delta.direction),
        );
      }
      if (event.scopes.length > 0) {
        lines.push(`${indent()}Contribution locations (execution_unit scope):`);
        for (const scope of event.scopes) {
          const before = scope.previous === null ? "—" : formatNumber(scope.previous);
          const after = scope.current === null ? "—" : formatNumber(scope.current);
          lines.push(
            `${indent(4)}${scope.metric} ${before} -> ${after} ` +
              paint(
                `(${formatSigned(scope.delta)}, ${DIRECTION_LABELS[scope.direction]})`,
                scope.direction,
              ) +
              `  ${scope.label} [${scope.kind}] line ${String(scope.line)}`,
          );
        }
      }
      for (const note of event.notes) {
        lines.push(paint(`${indent()}Note: ${note}`, "meta"));
      }
      break;
    }

    case "unanalyzed": {
      const entry = event.entry;
      lines.push(
        `${stamp}  ${paint("!", "warn")} ${paint(entry.path ?? "(no path)", "path")} — ` +
          paint(`NOT ANALYZED (${entry.reason}, tier ${entry.stage})`, "warn"),
      );
      lines.push(`${indent()}${entry.detail}`);
      lines.push(
        paint(
          `${indent()}${entry.recoverable ? "A later attempt may succeed." : "Permanent: another attempt will not change the result."}`,
          "meta",
        ),
      );
      break;
    }

    case "status":
      lines.push(
        `${stamp}  State: ${event.status}` +
          (event.detail === null ? "" : ` — ${paint(event.detail, "warn")}`),
      );
      break;

    case "stopped": {
      const why = {
        signal: `Signal ${event.signal ?? "?"}`,
        limit: "--exit-after reached",
        baseline: "--baseline-only",
        error: "Error",
      }[event.reason];
      lines.push(`${stamp}  Stopped (${why}) after ${String(event.durationMs)} ms`);
      lines.push(
        `${indent()}${String(event.changesObserved)} change(s) processed, ` +
          `${String(event.filesUnanalyzed)} file(s) not analyzable`,
      );
      lines.push(`${indent()}Net change in this session:`);
      for (const metric of METRIC_KEYS) {
        const value = event.net[metric];
        lines.push(
          `${indent(4)}${pad(metric)} ${paint(formatSigned(value).padStart(9), directionKey(value))}`,
        );
      }
      lines.push(
        `${indent()}Total: ${paint(verdictLabel(event.netDirection), event.netDirection)}`,
      );
      lines.push(
        paint(
          `${indent()}Backlog: peak ${String(event.queue.maxDepthObserved)} item(s), ` +
            `${String(event.queue.maxBytesObserved)} bytes; ` +
            `${String(event.queue.overBudgetAdmissions)} budget exception(s)`,
          "meta",
        ),
      );
      lines.push(
        `${indent()}Ref lock ${event.lockReleased ? "released" : paint("NOT released", "warn")}`,
      );
      break;
    }
  }

  return lines.join("\n");
}

function directionKey(value: number): "abgebaut" | "aufgebaut" | "unveraendert" {
  if (value < 0) return "abgebaut";
  if (value > 0) return "aufgebaut";
  return "unveraendert";
}

function verdictLabel(direction: "abgebaut" | "aufgebaut" | "unveraendert"): string {
  switch (direction) {
    case "abgebaut":
      return "Complexity reduced";
    case "aufgebaut":
      return "Complexity increased";
    default:
      return "Complexity unchanged";
  }
}

function readingLabel(metric: MetricKey): string {
  return metric === "semantic"
    ? "file_chunks scope (estimated tokens across all chunks)"
    : "execution_unit scope (each execution unit exactly once)";
}

function pad(metric: string): string {
  return metric.padEnd(METRIC_LABEL_WIDTH, " ");
}

function indent(width = 10): string {
  return " ".repeat(width);
}

/** Ganze Zahlen ohne Nachkomma, gebrochene mit zwei Stellen. */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Immer mit Vorzeichen — `0` bleibt `0`, damit "keine Wirkung" auch so aussieht. */
export function formatSigned(value: number): string {
  if (value === 0) return "0";
  const text = formatNumber(Math.abs(value));
  return value > 0 ? `+${text}` : `-${text}`;
}

/**
 * `HH:MM:SS` aus einem ISO-Zeitstempel. Zeitangaben sind PROTOKOLLAUSGABE,
 * nie Ergebnisdaten — die Metriken selbst kennen keine Uhrzeit.
 */
function clockOf(iso: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match === null ? iso.padEnd(8, " ") : (match[1] as string);
}
