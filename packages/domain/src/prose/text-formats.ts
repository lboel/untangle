/**
 * Welche Textformate Untangle mit Unterstuetzungsstufe `text` fuehrt — und
 * welche es aus einem BENANNTEN, nicht aus einem falschen Grund auslaesst
 * (vision.md §1c, spec.md §7.1/§7.2, E4).
 *
 * DIE ENTSCHEIDUNG, UM DIE ES HIER GEHT
 *
 * `text` ist nach vision.md §1c KEIN abgeschwaechtes `deep`, sondern die
 * vollstaendige Leistung fuer Inhalte ohne Graphen. Daraus folgt eine
 * Dreiteilung, und jede Klasse hat eine andere BEHANDLUNG:
 *
 * - `prose` — Markdown, ADRs, RFCs, Runbooks, freier Text. Verfasste
 *   natuerliche Sprache mit einer Gliederung. Sie bekommt
 *   ueberschriftenbewusste Abschnitte (WP-110) und PROSA-Metriken
 *   (Strukturlast, Verweislast), niemals Code-Metriken.
 * - `structured_data` — JSON, YAML, TOML, XML. Verfasst und sinnvoll
 *   durchsuchbar (eine `package.json`, eine CI-Definition, ein Manifest
 *   beantworten echte Fragen), aber ohne Prosa und ohne Ausfuehrungspfade.
 *   Sie bekommt sichere Textchunks und Suche — und fuer eine
 *   KOMPLEXITAETSauswertung den Grund `no_metric_defined`: das Format ist
 *   verstanden, es ist nur keine Metrik dafuer definiert. Das ist etwas
 *   anderes als "unsupported_language" und muss auch anders heissen.
 * - `generated` — Lockdateien und andere maschinell erzeugte Artefakte.
 *   Hier steht keine verfasste Aussage. Eine `pnpm-lock.yaml` semantisch zu
 *   durchsuchen liefert Rauschen und kostet Einbettungen; sie wird
 *   ausgelassen, aber mit dem Grund `generated_content` statt mit einer
 *   Sprachbehauptung.
 *
 * Reine Pfadklassifikation: kein Dateizugriff, kein Inhalt, deterministisch.
 */

/** Die drei Textklassen; geschlossen, damit sie zaehlbar bleiben. */
export const TEXT_FORMAT_KINDS = ["prose", "structured_data", "generated"] as const;

export type TextFormatKind = (typeof TEXT_FORMAT_KINDS)[number];

/**
 * Maschinell erzeugte Dateien, erkannt am vollstaendigen Dateinamen. Die
 * Liste ist bewusst NAMENSBASIERT und nicht heuristisch: eine Heuristik, die
 * gelegentlich eine handgeschriebene Datei fuer generiert haelt, verliert
 * genau den Inhalt, den §1c schuetzen will.
 */
const GENERATED_FILE_NAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "gemfile.lock",
  "go.sum",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

/** Endungen, hinter denen verfasste natuerliche Sprache steht. */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([".markdown", ".md", ".mdx", ".rst", ".txt"]);

/** Endungen strukturierter, verfasster Daten. */
const STRUCTURED_DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json",
  ".jsonc",
  ".jsonl",
  ".toml",
  ".xml",
  ".yaml",
  ".yml",
]);

function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return (lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)).toLowerCase();
}

/** Endung einschliesslich Punkt, kleingeschrieben; `null` fuer Dateien ohne Endung. */
export function textFormatExtensionOf(path: string): string | null {
  const fileName = fileNameOf(path);
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return null; // keine Endung, oder Punktdatei wie ".gitignore"
  return fileName.slice(lastDot);
}

/**
 * Klassifiziert einen Pfad; `null`, wenn es kein von Untangle als `text`
 * gefuehrtes Format ist (dann entscheidet die parser-registry ueber `deep`
 * oder `structural`, oder es bleibt wirklich unbekannt).
 *
 * `generated` schlaegt `structured_data`: eine `pnpm-lock.yaml` ist YAML,
 * aber niemand hat sie verfasst.
 */
export function classifyTextFormat(path: string): TextFormatKind | null {
  if (GENERATED_FILE_NAMES.has(fileNameOf(path))) return "generated";
  const extension = textFormatExtensionOf(path);
  if (extension === null) return null;
  if (extension === ".lock") return "generated";
  if (PROSE_EXTENSIONS.has(extension)) return "prose";
  if (STRUCTURED_DATA_EXTENSIONS.has(extension)) return "structured_data";
  return null;
}

/** Alle Endungen einer Klasse, aufsteigend nach Codepunkten — fuer Adapterregistrierungen. */
export function textFormatExtensions(kind: TextFormatKind): string[] {
  const source =
    kind === "prose"
      ? PROSE_EXTENSIONS
      : kind === "structured_data"
        ? STRUCTURED_DATA_EXTENSIONS
        : new Set<string>([".lock"]);
  return [...source].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
