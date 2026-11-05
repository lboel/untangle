/**
 * Plausibilitätsprüfung von Fragmentgrenzen (WP-118, BUILD_PLAN §12 E4).
 *
 * `coverage.ts` beantwortet die Frage „**fehlt** etwas?" — es rechnet
 * Byte-Abdeckung und meldet jeden Bereich, der in keinem Chunk landet.
 * Diese Frage ist blind gegenüber dem zweiten Fehlerbild: es fehlt nichts,
 * aber es ist **falsch geschnitten**. Der Auslöser war die SQL-Zerlegung
 * (`adapters/sql.ts`), die `INSERT INTO t VALUES ('it\'s a test; nested
 * clause', 2);` in zwei syntaktisch kaputte Fragmente zerriss — bei
 * lückenloser Byte-Abdeckung, ohne leere oder überlappende Ranges, also bei
 * **null** Ledger-Einträgen. Der Verlust ist real (kein Fragment ist ein
 * gültiges Statement, die Einbettung beider ist Müll), nur eben unsichtbar.
 *
 * Dieses Modul liefert das fehlende Signal, format-agnostisch und ohne
 * Grammatik: ein korrekt geschnittenes Fragment einer klammer- und
 * zeichenketten-strukturierten Sprache ist in sich **ausbalanciert**. Bleibt
 * eine Zeichenkette, ein Blockkommentar, ein Heredoc oder eine Klammer am
 * Fragmentende offen, dann verlief die Schnittkante mitten durch ein
 * Konstrukt — unabhängig davon, welcher Adapter geschnitten hat und warum.
 *
 * Bewusste Asymmetrie zum jeweiligen Zerleger: dieser Prüfer darf
 * **misstrauischer** sein als der Zerleger. Ein Fehlalarm kostet eine
 * Warnzeile, ein verschwiegener Fehlschnitt kostet einen unbrauchbaren
 * Chunk (E4). Deshalb kennt er z. B. Dollar-Quoting auch dort, wo ein
 * Dialekt es nicht erwarten ließe.
 *
 * Was er NICHT ist: ein Parser. Er kennt keine Schlüsselwörter, keine
 * Ausdrücke, keine Typen. Ein Fragment, das balanciert und trotzdem
 * bedeutungslos ist (`FROM orders WHERE`), passiert ihn unbeanstandet. Das
 * ist die dokumentierte Grenze — er schließt die Lücke „mitten durch ein
 * Konstrukt geschnitten", nicht „semantisch unvollständig".
 */

/** Eine Zeichenketten-/Bezeichner-Anführungskonvention (`'…'`, `"…"`, `` `…` ``). */
export interface QuoteRule {
  /** Öffnende Zeichenfolge, meist ein einzelnes Zeichen. */
  readonly open: string;
  /** Schließende Zeichenfolge; bei symmetrischen Anführungszeichen gleich `open`. */
  readonly close: string;
  /** Ob ein `\` innerhalb des Literals das folgende Zeichen maskiert (dialektabhängig, siehe `adapters/sql.ts`). */
  readonly backslashEscapes: boolean;
  /** Ob ein verdoppeltes Schlusszeichen (`''`) im Literal ein maskiertes Anführungszeichen ist. */
  readonly doubledEscapes: boolean;
  /** Ob das Literal einen Zeilenumbruch enthalten darf. Ist es das nicht, ist ein Zeilenende im Literal selbst schon ein Befund. */
  readonly spansLines: boolean;
}

/** Ein Klammerpaar, dessen Verschachtelung aufgehen muss. */
export interface BracketRule {
  readonly open: string;
  readonly close: string;
}

/** Ein Blockkommentar-Paar (`/*` … `*\/`). */
export interface BlockCommentRule {
  readonly open: string;
  readonly close: string;
}

/**
 * Heredoc-Konvention. Bisher nur `"hcl"`: `<<TAG` bzw. `<<-TAG`, beendet
 * durch eine Zeile, deren getrimmter Inhalt genau `TAG` ist. Der Inhalt
 * eines Heredocs ist Rohtext — Klammern und Anführungszeichen darin zählen
 * nicht, sonst meldet jedes eingebettete Shell-Skript einen Fehlalarm.
 */
export type HeredocStyle = "hcl";

export interface DelimiterScanOptions {
  readonly quotes: readonly QuoteRule[];
  readonly brackets: readonly BracketRule[];
  /** Zeilenkommentar-Präfixe (`"--"`, `"//"`, `"#"`), in Prüfreihenfolge. */
  readonly lineComments: readonly string[];
  readonly blockComment?: BlockCommentRule;
  /**
   * `$tag$ … $tag$`-Literale erkennen. Ein Öffner zählt nur, wenn davor
   * kein Bezeichnerzeichen steht — sonst würde ein Bezeichner mit zwei
   * `$` (`my$col$x`) fälschlich ein Literal öffnen.
   */
  readonly dollarQuotedStrings?: boolean;
  readonly heredocs?: HeredocStyle;
}

export type DelimiterImbalanceKind =
  | "unterminated_string"
  | "unterminated_block_comment"
  | "unterminated_heredoc"
  | "unclosed_bracket"
  | "unmatched_closing_bracket";

export interface DelimiterImbalance {
  readonly kind: DelimiterImbalanceKind;
  /** Das beteiligte Trennzeichen, wörtlich (`"'"`, `"("`, `"<<EOF"`). */
  readonly delimiter: string;
  /** 0-basierter Offset in der geprüften Zeichenkette (UTF-16-Einheiten), an dem das Konstrukt geöffnet wurde. */
  readonly offset: number;
  /** 1-basierte Zeile INNERHALB des geprüften Fragments (nicht des Dokuments). */
  readonly line: number;
}

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_]/;
const IDENTIFIER_START = /[A-Za-z_]/;
const HEREDOC_OPEN = /<<-?([A-Za-z_][A-Za-z0-9_]*)/y;

/** Höchstzahl gemeldeter Befunde je Fragment — ein durchgehend kaputtes Fragment soll den Ledger nicht fluten. */
const MAX_IMBALANCES = 8;

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * `$tag$`-Öffner an Position `i`, oder `undefined`. Der Tag darf leer sein
 * (`$$`); ein vorangehendes Bezeichnerzeichen verhindert die Erkennung.
 */
function matchDollarQuote(text: string, i: number): string | undefined {
  if (text[i] !== "$") return undefined;
  const before = i > 0 ? text[i - 1]! : "";
  if (before !== "" && (IDENTIFIER_CHARACTER.test(before) || before === "$")) return undefined;
  let j = i + 1;
  if (j < text.length && IDENTIFIER_START.test(text[j]!)) {
    j += 1;
    while (j < text.length && IDENTIFIER_CHARACTER.test(text[j]!)) j += 1;
  }
  if (text[j] !== "$") return undefined;
  return text.slice(i, j + 1);
}

interface QuoteScanResult {
  /** Position nach dem Literal (bzw. am Zeilenumbruch/Textende, wenn es offen blieb). */
  readonly next: number;
  readonly terminated: boolean;
}

/** Überliest ein Literal ab dem Öffner an `start`. */
function scanQuoted(text: string, start: number, rule: QuoteRule): QuoteScanResult {
  let i = start + rule.open.length;
  while (i < text.length) {
    if (!rule.spansLines && text[i] === "\n") return { next: i, terminated: false };
    if (rule.backslashEscapes && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(rule.close, i)) {
      if (rule.doubledEscapes && text.startsWith(rule.close, i + rule.close.length)) {
        i += rule.close.length * 2;
        continue;
      }
      return { next: i + rule.close.length, terminated: true };
    }
    i += 1;
  }
  return { next: text.length, terminated: false };
}

/** Überliest ein `$tag$`-Literal ab dem Öffner an `start`. */
function scanDollarQuoted(text: string, start: number, tag: string): QuoteScanResult {
  const close = text.indexOf(tag, start + tag.length);
  if (close === -1) return { next: text.length, terminated: false };
  return { next: close + tag.length, terminated: true };
}

/** Überliest ein Heredoc ab dem `<<TAG`-Öffner an `start`. */
function scanHeredoc(text: string, start: number, opener: string, tag: string): QuoteScanResult {
  let lineStart = text.indexOf("\n", start + opener.length);
  if (lineStart === -1) return { next: text.length, terminated: false };
  lineStart += 1;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (text.slice(lineStart, lineEnd).trim() === tag) return { next: lineEnd, terminated: true };
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return { next: text.length, terminated: false };
}

/**
 * Findet jede Stelle, an der `text` mitten durch ein Konstrukt geschnitten
 * ist. Ergebnis ist deterministisch nach Offset sortiert (numerisch, kein
 * `localeCompare`) und auf {@link MAX_IMBALANCES} Einträge begrenzt.
 */
export function findDelimiterImbalances(
  text: string,
  options: DelimiterScanOptions,
): DelimiterImbalance[] {
  const found: { kind: DelimiterImbalanceKind; delimiter: string; offset: number }[] = [];
  const openBrackets: { delimiter: string; close: string; offset: number }[] = [];
  const { blockComment } = options;

  let i = 0;
  while (i < text.length) {
    if (blockComment !== undefined && text.startsWith(blockComment.open, i)) {
      const close = text.indexOf(blockComment.close, i + blockComment.open.length);
      if (close === -1) {
        found.push({ kind: "unterminated_block_comment", delimiter: blockComment.open, offset: i });
        i = text.length;
        break;
      }
      i = close + blockComment.close.length;
      continue;
    }

    const lineComment = options.lineComments.find((prefix) => text.startsWith(prefix, i));
    if (lineComment !== undefined) {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline + 1;
      continue;
    }

    if (options.heredocs === "hcl" && text.startsWith("<<", i)) {
      HEREDOC_OPEN.lastIndex = i;
      const match = HEREDOC_OPEN.exec(text);
      if (match !== null) {
        const result = scanHeredoc(text, i, match[0], match[1]!);
        if (!result.terminated)
          found.push({ kind: "unterminated_heredoc", delimiter: match[0], offset: i });
        i = result.next;
        continue;
      }
    }

    if (options.dollarQuotedStrings === true) {
      const tag = matchDollarQuote(text, i);
      if (tag !== undefined) {
        const result = scanDollarQuoted(text, i, tag);
        if (!result.terminated)
          found.push({ kind: "unterminated_string", delimiter: tag, offset: i });
        i = result.next;
        continue;
      }
    }

    const quote = options.quotes.find((rule) => text.startsWith(rule.open, i));
    if (quote !== undefined) {
      const result = scanQuoted(text, i, quote);
      if (!result.terminated)
        found.push({ kind: "unterminated_string", delimiter: quote.open, offset: i });
      i = Math.max(result.next, i + 1);
      continue;
    }

    const opening = options.brackets.find((rule) => text.startsWith(rule.open, i));
    if (opening !== undefined) {
      openBrackets.push({ delimiter: opening.open, close: opening.close, offset: i });
      i += opening.open.length;
      continue;
    }

    const closing = options.brackets.find((rule) => text.startsWith(rule.close, i));
    if (closing !== undefined) {
      const top = openBrackets.at(-1);
      if (top !== undefined && top.close === closing.close) {
        openBrackets.pop();
      } else {
        // Ein Schlusszeichen ohne passenden Öffner IM FRAGMENT: die
        // Schnittkante lag hinter dem zugehörigen Öffner.
        found.push({ kind: "unmatched_closing_bracket", delimiter: closing.close, offset: i });
      }
      i += closing.close.length;
      continue;
    }

    i += 1;
  }

  for (const open of openBrackets) {
    found.push({ kind: "unclosed_bracket", delimiter: open.delimiter, offset: open.offset });
  }

  return found
    .sort((a, b) => a.offset - b.offset)
    .slice(0, MAX_IMBALANCES)
    .map((entry) => ({ ...entry, line: lineOf(text, entry.offset) }));
}

const IMBALANCE_LABELS: Record<DelimiterImbalanceKind, string> = {
  unterminated_string: "unterminated string literal opened by",
  unterminated_block_comment: "unterminated block comment opened by",
  unterminated_heredoc: "unterminated heredoc opened by",
  unclosed_bracket: "unclosed bracket",
  unmatched_closing_bracket: "closing bracket without a matching opener in this fragment:",
};

/** Einzeilige, menschenlesbare Zusammenfassung für den `contentPreview` eines Ledger-Eintrags. */
export function describeDelimiterImbalances(imbalances: readonly DelimiterImbalance[]): string {
  const parts = imbalances.map(
    (entry) =>
      `${IMBALANCE_LABELS[entry.kind]} ${JSON.stringify(entry.delimiter)} at fragment line ${entry.line}`,
  );
  return `implausible fragment boundary: ${parts.join("; ")}`;
}
