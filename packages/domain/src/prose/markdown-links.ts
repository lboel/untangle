/**
 * Verweise eines Markdown-Dokuments (vision.md §1c: „Querverweisdichte",
 * WP-217).
 *
 * Wie {@link outlineMarkdown} steht die Funktion hier und nicht im Adapter,
 * weil sie ZWEI Verbraucher hat, die nicht voneinander abhaengen duerfen:
 * den Prosa-`LanguageAdapter` (`extractImports` — ein relativer Dateiverweis
 * IST eine Kante im Dateigraphen) und die Prosa-Metriken (Verweisdichte,
 * Anteil toter Verweise). Zwei Implementierungen wuerden zwei verschiedene
 * Zahlen fuer dasselbe Dokument liefern.
 *
 * Erfasst werden Inline-Verweise `[text](ziel)` und Referenzdefinitionen
 * `[label]: ziel`. Eingezaeunte Codebloecke zaehlen nicht — ein Beispiel in
 * einem Codeblock ist kein Verweis des Dokuments. Bilder `![alt](ziel)`
 * zaehlen mit; sie sind derselbe Aufloesungsfall.
 */

/** Verweisart. Nur `relative_file` ist ueberhaupt aufloesbar. */
export const PROSE_LINK_KINDS = ["relative_file", "absolute_url", "anchor", "other"] as const;

export type ProseLinkKind = (typeof PROSE_LINK_KINDS)[number];

/** Ein Verweis, wie er im Dokument steht. */
export interface MarkdownLinkV1 {
  /** Zielangabe wie geschrieben, z. B. "./spec.md#7-1". */
  target: string;
  /** Anzeigetext bzw. Referenzlabel. */
  text: string;
  /** 1-basierte Zeile, in der der Verweis steht. */
  line: number;
  kind: ProseLinkKind;
}

const FENCE = /^(`{3,}|~{3,})/;
// [text](ziel) und ![alt](ziel); Ziel ohne Leerzeichen, optionaler Titel.
const INLINE_LINK = /!?\[([^\]]*)\]\(\s*<?([^)<>\s]*)>?(?:\s+"[^"]*")?\s*\)/g;
// [label]: ziel  — Referenzdefinition am Zeilenanfang.
const REFERENCE_DEFINITION = /^\s{0,3}\[([^\]]+)\]:\s*<?(\S+)>?/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Klassifiziert eine Zielangabe. Reine Zeichenkettenarbeit, kein Dateizugriff. */
export function classifyLinkTarget(target: string): ProseLinkKind {
  const trimmed = target.trim();
  if (trimmed === "") return "other";
  if (trimmed.startsWith("#")) return "anchor";
  if (trimmed.startsWith("//") || URL_SCHEME.test(trimmed)) return "absolute_url";
  if (trimmed.startsWith("{") || trimmed.includes("${")) return "other"; // Platzhalter aus Vorlagen
  return "relative_file";
}

/**
 * Der Dateiteil eines relativen Verweises: ohne `#anker` und ohne `?abfrage`.
 * Leer, wenn der Verweis nur auf einen Anker im selben Dokument zeigt.
 */
export function linkFilePath(target: string): string {
  const trimmed = target.trim();
  const withoutAnchor = trimmed.split("#")[0] ?? "";
  return (withoutAnchor.split("?")[0] ?? "").trim();
}

/** Alle Verweise des Dokuments, in Quelltextreihenfolge. */
export function findMarkdownLinks(lines: readonly string[]): MarkdownLinkV1[] {
  const links: MarkdownLinkV1[] = [];
  let fence: string | null = null;
  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trim();
    const fenceMatch = FENCE.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker.charAt(0);
      else if (trimmed.startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const definition = REFERENCE_DEFINITION.exec(rawLine);
    if (definition !== null) {
      const target = definition[2]!;
      links.push({
        target,
        text: definition[1]!,
        line: index + 1,
        kind: classifyLinkTarget(target),
      });
      continue;
    }

    INLINE_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_LINK.exec(rawLine)) !== null) {
      const target = match[2] ?? "";
      links.push({
        target,
        text: match[1] ?? "",
        line: index + 1,
        kind: classifyLinkTarget(target),
      });
    }
  }
  return links;
}

/**
 * Inhaltszeilen: nicht leer und ausserhalb eingezaeunter Codebloecke. Der
 * Nenner jeder Dichte — ein Dokument, das zur Haelfte aus Codebeispielen
 * besteht, soll deswegen keine kuenstlich niedrige Verweisdichte bekommen.
 */
export function countContentLines(lines: readonly string[]): number {
  let count = 0;
  let fence: string | null = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const fenceMatch = FENCE.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker.charAt(0);
      else if (trimmed.startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (trimmed.length > 0) count += 1;
  }
  return count;
}

/**
 * Zeilen ausserhalb von Codebloecken, normalisiert fuer den
 * Wiederholungsvergleich: Leerraum zusammengefasst, kleingeschrieben.
 * Leerzeilen und Codebloecke fallen heraus — eine wiederholte Leerzeile ist
 * keine Wiederholung, und wiederholter Beispielcode ist Beispielcode.
 *
 * Kleinschreibung ueber `toLowerCase()` ohne Gebietsschema: die Ausgabe wird
 * nur mit sich selbst verglichen, nie sortiert (kein `localeCompare`).
 */
export function normalizedContentLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const fenceMatch = FENCE.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker.charAt(0);
      else if (trimmed.startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (trimmed.length === 0) continue;
    out.push(trimmed.replace(/\s+/g, " ").toLowerCase());
  }
  return out;
}
