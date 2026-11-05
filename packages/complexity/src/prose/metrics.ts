/**
 * Prosa-Metriken (vision.md §1c/§1d, WP-217).
 *
 * WARUM ES DIESE DATEI GIBT
 *
 * Alles andere in diesem Paket rechnet ueber `ComplexityFacts`: Scopes,
 * Entscheidungspunkte, Verschachtelung, Operatoren. Ein Markdown-Dokument
 * hat davon NICHTS — nicht wenig, sondern nichts. Der Prosa-Adapter liefert
 * deshalb leere Facts, und Prosa wird hier ueber ihre EIGENEN Groessen
 * gemessen: Struktur- und Verweislast.
 *
 * Die Trennung ist strukturell, nicht per Konvention: jeder Rueckgabewert
 * ist ein {@link ProseNumberV1}, also ein Objekt. Ein Prosa-Messwert kann
 * dadurch an keiner Stelle stehen, an der `computeCognitive` oder
 * `aggregate` eine Zahl erwarten — der Uebersetzer lehnt es ab, und
 * `assertUntangleMetricNumber` lehnt es zur Laufzeit ab. Vorbild ist
 * `ExternalNumberV1` (domain `types/extensions.ts`), das externe Befunde
 * genauso von Untangle-Metriken fernhaelt.
 *
 * DIE FUENF MASSE, UND WARUM GENAU DIESE
 *
 * Jedes Mass muss ohne Modellannahme lesbar sein — sonst ist es eine
 * erfundene Zahl mit Nachkommastellen. Was hier steht, laesst sich am
 * Dokument nachzaehlen:
 *
 * 1. `sectionDepth`      — tiefste benutzte Ueberschriftenebene.
 * 2. `maxSectionLines`   — laengster Abschnitt in Zeilen.
 * 3. `linkDensity`       — Verweise je 100 Inhaltszeilen.
 * 4. `unresolvedLinkRatio` — Anteil toter relativer Dateiverweise, oder
 *                          `null`, wenn niemand aufgeloest hat.
 * 5. `repetitionRatio`   — Anteil woertlich wiederholter Inhaltszeilen.
 *
 * Dazu der abgeleitete Ordnungsschluessel `structureLoad`: die Summe der
 * Ueberschriftenebenen aller Abschnitte. Bewusst keine gewichtete Mischung
 * ungleicher Groessen — das waere der eine „Quality Score", den vision.md
 * §7.6 ablehnt —, sondern eine abzaehlbare Groesse: die Gesamtzahl der
 * Gliederungsstufen, die das Dokument aufspannt. Ein Dokument mit 40
 * Abschnitten auf Ebene 3 traegt mehr Gliederung als eines mit 40
 * Abschnitten auf Ebene 1, und beide mehr als eines mit vier.
 *
 * DER AUFLOESER
 *
 * `unresolvedLinkRatio` ist der einzige Wert, der etwas ausserhalb des
 * Dokuments braucht. Ohne `resolveLink` bleibt er `null` — ein
 * Zustandsvermerk, kein Messwert von 0. vision.md §1d ist an genau dieser
 * Stelle deutlich: „niemand hat gesucht" darf nie wie ein Befund ueber den
 * Inhalt aussehen. Deshalb ist der Aufloeser ein Parameter und keine
 * Dateizugriffsfunktion in diesem Paket: `@untangle-code/complexity` bleibt
 * frei von I/O.
 */
import type {
  ProseLinkV1,
  ProseMetricsV1,
  ProseNumberV1,
  ProseSectionMetricV1,
} from "@untangle-code/domain";
import {
  PROSE_METRICS_VERSION,
  classifyLinkTarget,
  countContentLines,
  findMarkdownLinks,
  linkFilePath,
  makeProseNumber,
  normalizedContentLines,
  outlineMarkdown,
} from "@untangle-code/domain";

/**
 * Beantwortet, ob das Ziel eines relativen Dateiverweises existiert.
 * `documentPath` ist der Pfad des VERWEISENDEN Dokuments, damit der
 * Aufloeser relativ dazu suchen kann.
 */
export type ProseLinkResolver = (documentPath: string, targetFilePath: string) => boolean;

export interface ProseMetricsOptions {
  /**
   * Ohne Aufloeser bleibt `unresolvedLinkRatio` `null`. Das ist Absicht:
   * ein ungeprueftes 0 waere die Behauptung, alle Verweise seien heil.
   */
  resolveLink?: ProseLinkResolver;
}

/** Physische Zeilen ohne Zeilenende; ein abschliessendes `\r` faellt weg. */
function splitLines(content: string): string[] {
  return content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Rundet auf eine Nachkommastelle. Verhaeltniswerte werden gespeichert und
 * verglichen; ohne feste Rundung waeren zwei Laeufe ueber dieselbe Datei
 * durch Gleitkommarauschen nicht bitgleich.
 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Prosa-Metriken eines Dokuments.
 *
 * `path` ist der "/"-normalisierte, repo-relative Pfad; er wird nur
 * durchgereicht (an den Aufloeser und in das Ergebnis), nie geoeffnet.
 */
export function computeProseMetrics(
  path: string,
  content: string,
  options: ProseMetricsOptions = {},
): ProseMetricsV1 {
  const lines = splitLines(content);
  const outline = outlineMarkdown(lines);

  const sections: ProseSectionMetricV1[] = outline.map((section) => ({
    breadcrumb: section.breadcrumb,
    level: section.level,
    startLine: section.startLine,
    endLine: section.endLine,
    lines: Math.max(0, section.endLine - section.startLine + 1),
  }));

  const contentLines = countContentLines(lines);
  const rawLinks = findMarkdownLinks(lines);

  const resolver = options.resolveLink;
  const links: ProseLinkV1[] = rawLinks.map((link) => {
    const kind = classifyLinkTarget(link.target);
    let resolved: boolean | null = null;
    if (kind === "relative_file" && resolver !== undefined) {
      const target = linkFilePath(link.target);
      // Ein Verweis, der nur auf einen Anker im selben Dokument zeigt, hat
      // keinen Dateiteil; er ist nicht "tot", er ist keine Dateikante.
      resolved = target === "" ? true : resolver(path, target);
    }
    return { target: link.target, text: link.text, line: link.line, kind, resolved };
  });

  const resolvable = links.filter((link) => link.resolved !== null);
  const unresolved = resolvable.filter((link) => link.resolved === false);

  const normalized = normalizedContentLines(lines);
  const seen = new Set<string>();
  let repeated = 0;
  for (const line of normalized) {
    if (seen.has(line)) repeated += 1;
    else seen.add(line);
  }

  const depth = sections.reduce((max, section) => Math.max(max, section.level), 0);
  const maxLines = sections.reduce((max, section) => Math.max(max, section.lines), 0);
  const structureLoad = sections.reduce((sum, section) => sum + section.level, 0);

  return {
    schemaVersion: 1,
    metricsVersion: PROSE_METRICS_VERSION,
    path,
    sectionDepth: makeProseNumber(depth, "levels"),
    maxSectionLines: makeProseNumber(maxLines, "lines"),
    linkDensity: makeProseNumber(
      contentLines === 0 ? 0 : round((links.length / contentLines) * 100, 1),
      "per_100_lines",
    ),
    unresolvedLinkRatio:
      resolvable.length === 0
        ? null
        : makeProseNumber(round(unresolved.length / resolvable.length, 4), "ratio"),
    repetitionRatio: makeProseNumber(
      normalized.length === 0 ? 0 : round(repeated / normalized.length, 4),
      "ratio",
    ),
    structureLoad: makeProseNumber(structureLoad, "count"),
    sectionCount: makeProseNumber(sections.length, "count"),
    contentLines: makeProseNumber(contentLines, "count"),
    sections,
    links,
  };
}

/**
 * Ordnet zwei Dokumente nach Strukturlast, absteigend, mit vollstaendig
 * deterministischem Gleichstandsbruch (nie `localeCompare`).
 *
 * `compare` liefert eine Ordnung, keine Bewertung: das Dokument mit der
 * hoechsten Strukturlast ist nicht „das schlechteste", sondern das mit der
 * meisten Gliederung — die Deutung gehoert dem Leser, die Zahl dem Werkzeug.
 */
export function compareProseByStructureLoad(a: ProseMetricsV1, b: ProseMetricsV1): number {
  const byLoad = valueOf(b.structureLoad) - valueOf(a.structureLoad);
  if (byLoad !== 0) return byLoad;
  const byDepth = valueOf(b.sectionDepth) - valueOf(a.sectionDepth);
  if (byDepth !== 0) return byDepth;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Der Rohwert eines Prosa-Messwerts fuer die SORTIERUNG innerhalb dieser
 * Familie. Bewusst paketlokal und nicht exportiert: eine allgemein
 * verfuegbare `number`-Entpackung waere genau das Loch, das
 * {@link ProseNumberV1} zumauert.
 */
function valueOf(value: ProseNumberV1): number {
  return value.value;
}
