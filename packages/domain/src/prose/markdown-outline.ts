/**
 * Ueberschriftenbewusste Gliederung eines Markdown-Dokuments (vision.md §1c,
 * spec.md §19.2, WP-110).
 *
 * WARUM DIESE FUNKTION HIER STEHT UND NICHT IM ADAPTER: sie hat DREI
 * Verbraucher, die nicht voneinander abhaengen duerfen —
 *
 *   1. `@untangle-code/context-artifacts` (Markdown-/ADR-Artefakte),
 *   2. `@untangle-code/parser-registry` (der Prosa-`LanguageAdapter`, der
 *      gewoehnliche `.md`-Dateien fuer den AST-Chunker sichtbar macht),
 *   3. `@untangle-code/complexity` (die Prosa-Metriken).
 *
 * Vor WP-110 lag sie nur in (1). Ergebnis: eine konfigurierte Artefaktdatei
 * bekam Abschnitte mit Breadcrumb, dieselbe Datei ohne Konfiguration
 * willkuerliche Zeilenfenster. Eine ZWEITE Gliederung zu schreiben haette
 * genau diese Divergenz zementiert; deshalb wandert die vorhandene hierher.
 *
 * Sie ist rein und deterministisch: keine I/O, keine Uhr, keine
 * Gebietsschema-Vergleiche. Domain darf das (siehe `identity.ts`,
 * `canonical-json.ts`) — was Domain nicht darf, ist ein Adapter zu sein.
 */

/** Eine ATX-Ueberschrift (`#` … `######`) ausserhalb eines Codeblocks. */
export interface MarkdownHeadingV1 {
  /** 1-basierte Zeile der Ueberschrift. */
  line: number;
  /** 1 … 6. */
  level: number;
  /** Ueberschriftentext ohne `#` und ohne schliessende `#`. */
  title: string;
}

/**
 * Ein Abschnitt: von einer Ueberschrift bis unmittelbar VOR die naechste
 * Ueberschrift BELIEBIGER Ebene (flache Partition, kein Ueberlapp — siehe
 * `context-artifacts/src/adapters/markdown.ts`). Der Vorspann vor der ersten
 * Ueberschrift ist ein Abschnitt mit `level: 0`.
 */
export interface MarkdownSectionV1 {
  /** 1-basiert, inklusiv. */
  startLine: number;
  /** 1-basiert, inklusiv. */
  endLine: number;
  /** Ueberschriftenebene; 0 fuer den Vorspann. */
  level: number;
  /** Ueberschriftentext; leer beim Vorspann. */
  title: string;
  /**
   * Ueberschriftenpfad von der Wurzel bis hierher, mit `" › "` verbunden.
   * Leer beim Vorspann. Der Breadcrumb wird NIE in den Inhalt gespleisst —
   * er ist Metadatum, der Inhalt bleibt der unveraenderte Rohausschnitt.
   */
  breadcrumb: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE = /^(`{3,}|~{3,})/;

/** Breadcrumb-Trennzeichen; bewusst EIN Ort, damit alle Verbraucher identisch trennen. */
export const BREADCRUMB_SEPARATOR = " › ";

/** Alle ATX-Ueberschriften; Zeilen innerhalb eingezaeunter Codebloecke zaehlen nicht. */
export function findMarkdownHeadings(lines: readonly string[]): MarkdownHeadingV1[] {
  const headings: MarkdownHeadingV1[] = [];
  let fence: string | null = null;
  for (const [index, rawLine] of lines.entries()) {
    const fenceMatch = FENCE.exec(rawLine.trim());
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) {
        fence = marker.charAt(0); // Zaunzeichen merken ("`" oder "~")
      } else if (rawLine.trim().startsWith(fence.repeat(3))) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const match = HEADING.exec(rawLine);
    if (match) {
      headings.push({ line: index + 1, level: match[1]!.length, title: match[2]!.trim() });
    }
  }
  return headings;
}

/** Ueberschriftenpfad zur Ueberschrift an Position `position`. */
export function buildBreadcrumb(headings: readonly MarkdownHeadingV1[], position: number): string {
  const current = headings[position]!;
  const trail: string[] = [current.title];
  let level = current.level;
  for (let i = position - 1; i >= 0 && level > 1; i -= 1) {
    const heading = headings[i]!;
    if (heading.level < level) {
      trail.unshift(heading.title);
      level = heading.level;
    }
  }
  return trail.join(BREADCRUMB_SEPARATOR);
}

/** True, wenn im 1-basierten inklusiven Zeilenbereich irgendetwas ausser Leerraum steht. */
export function hasContent(lines: readonly string[], startLine: number, endLine: number): boolean {
  for (let i = startLine; i <= endLine; i += 1) {
    if ((lines[i - 1] ?? "").trim().length > 0) return true;
  }
  return false;
}

/**
 * Gliedert ein Dokument in Abschnitte.
 *
 * `lines` sind die physischen Zeilen OHNE Zeilenende (wie `splitLines` sie
 * liefert). Ein leerer Vorspann wird weggelassen — ein Dokument, das mit
 * `# Titel` beginnt, hat keinen Vorspannabschnitt.
 */
export function outlineMarkdown(lines: readonly string[]): MarkdownSectionV1[] {
  const headings = findMarkdownHeadings(lines);
  const sections: MarkdownSectionV1[] = [];
  const totalLines = Math.max(lines.length, 1);

  if (headings.length === 0 || headings[0]!.line > 1) {
    const endLine = headings.length > 0 ? headings[0]!.line - 1 : totalLines;
    if (hasContent(lines, 1, endLine)) {
      sections.push({ startLine: 1, endLine, level: 0, title: "", breadcrumb: "" });
    }
  }

  for (const [position, heading] of headings.entries()) {
    const next = headings[position + 1];
    sections.push({
      startLine: heading.line,
      endLine: next !== undefined ? next.line - 1 : totalLines,
      level: heading.level,
      title: heading.title,
      breadcrumb: buildBreadcrumb(headings, position),
    });
  }
  return sections;
}
