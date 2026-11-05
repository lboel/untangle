/**
 * SQL schema adapter (architecture.md §20: "Tabellen, Views, Indizes,
 * Constraints als semantische Abschnitte").
 *
 * Splits the file into top-level statements (terminated by a `;` that is
 * not inside a string literal, a quoted identifier, or a comment), then
 * classifies each statement by its leading keywords. An unrecognized
 * statement (e.g. `INSERT`, `GRANT`) still becomes a chunk — kind
 * `"sql_statement"` — rather than being dropped; nothing in a schema file
 * is silently skipped (rule 4 / BUILD_PLAN §12 E4).
 *
 * Statement boundaries are tracked as exact BYTE offsets, not just line
 * numbers (WP-81 review finding): two statements can share one physical
 * line (`CREATE TABLE a (id int); CREATE TABLE b (id int);`), and a
 * line-only span can't tell them apart — either the second collapses into
 * an empty/inverted range (a phantom chunk carrying no content) or its
 * bytes get silently absorbed into the first statement's chunk, which
 * still reports zero gap (byte coverage looks complete) even though the
 * second statement's identity was lost. `splitStatements` below scans the
 * document's own UTF-8 bytes once, so every statement — including a second
 * one sharing its predecessor's line — gets its own precise, non-empty,
 * non-overlapping byte range that `ChunkDraft.startByte`/`endByte`
 * (`adapters/shared.ts`) carries straight through, instead of snapping to
 * whole-line boundaries.
 *
 * The file's LAST statement is not required to end in `;` — a schema file
 * missing its final terminator (a common paste/truncation mistake) still
 * gets its own chunk for that trailing statement; nothing after the last
 * real `;` is ever silently dropped.
 *
 * WP-118: Der Zerleger kannte lange nur die verdoppelte
 * Anführungszeichen-Konvention (`''`) als Escape. Ein Literal mit `\'` und
 * einem `;` darin — in Dumps alltäglich — zerriss deshalb EIN Statement in
 * zwei syntaktisch kaputte Fragmente, und zwar bei NULL Ledger-Warnungen:
 * die Byte-Abdeckung war lückenlos, die Fragmente weder leer noch
 * überlappend. Zwei Änderungen beheben das:
 *
 * 1. Die Escape-Behandlung ist dialektbewusst ({@link SqlDialect}), mit
 *    einem benannten, begründeten Standardwert ({@link DEFAULT_SQL_DIALECT})
 *    statt einer Vermutung über die vorliegende Datei. Zusätzlich erkennt
 *    der Scanner `$tag$`-Literale, in denen ein `;` genauso alltäglich ist.
 * 2. Wichtiger: `sqlPlausibilityCheck` prüft JEDES fertige Fragment auf
 *    offene Zeichenketten, offene Kommentare und unausgeglichene Klammern.
 *    Damit greift E4 auch dann, wenn nichts FEHLT, sondern etwas FALSCH
 *    GESCHNITTEN ist — unabhängig davon, ob der Dialekt richtig gewählt
 *    war. Eine falsche Dialektwahl ist danach sichtbar, nicht still.
 */
import type {
  ArtifactAdapter,
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ArtifactLink,
} from "@untangle-code/domain";

import type { DelimiterScanOptions, QuoteRule } from "../text/delimiter-balance.js";
import { describeDelimiterImbalances, findDelimiterImbalances } from "../text/delimiter-balance.js";
import {
  buildLineIndex,
  lineNumberForByte,
  sliceBytes,
  type LineIndex,
} from "../text/line-index.js";

import type { ChunkDraft, ChunkPlausibilityCheck, SkipLedgerReporter } from "./shared.js";
import { buildChunks, buildChunksReportingSkips, buildDocuments } from "./shared.js";

const SQL_EXTENSION = /\.sql$/i;

/**
 * Escape-Konvention für Zeichenketten-Literale. Die SQL-Dialekte
 * WIDERSPRECHEN sich hier, und zwar unauflösbar:
 *
 * - `"doubled-quotes-only"` — Standard-SQL: das EINZIGE Escape in einem
 *   Literal ist das verdoppelte Anführungszeichen (`'it''s'`). Ein `\` ist
 *   ein ganz normales Zeichen; `'it\'` ist eine ABGESCHLOSSENE Zeichenkette
 *   mit einem Backslash am Ende.
 * - `"backslash-escapes"` — die verbreitete Erweiterung: zusätzlich zum
 *   verdoppelten Anführungszeichen maskiert `\'` ein Anführungszeichen,
 *   `` ` `` klammert Bezeichner und `#` leitet einen Zeilenkommentar ein.
 *
 * Dieselbe Datei bedeutet also je nach Dialekt etwas anderes, und der
 * Dialekt steht NICHT in der Datei. Deshalb wird hier nicht geraten: die
 * Wahl ist eine explizite Option mit einem benannten Standardwert, und
 * jedes Ergebnis, das unter der gewählten Konvention unsinnig aussieht,
 * erzeugt einen sichtbaren Befund (siehe `sqlPlausibilityCheck`).
 */
export type SqlDialect = "backslash-escapes" | "doubled-quotes-only";

/**
 * Standardwert: `"backslash-escapes"` — bewusst NICHT der Standard-SQL-Dialekt.
 *
 * Begründung (asymmetrische Fehlerkosten für einen ZERLEGER, nicht für
 * einen Ausführer): dieser Adapter führt kein SQL aus, er schneidet nur
 * Abschnitte. Der teure Fehler ist der Schnitt MITTEN durch ein Statement,
 * denn er erzeugt zwei syntaktisch kaputte Chunks, die niemand mehr als
 * ein Statement erkennt (WP-118). Der billige Fehler ist der zu späte
 * Schnitt: zwei Statements landen in einem Chunk, der immer noch gültiges,
 * vollständiges SQL enthält.
 *
 * - Nimmt man `\'` als Escape und die Datei war Standard-SQL, kann nur ein
 *   Literal betroffen sein, das unmittelbar vor seinem Schlusszeichen auf
 *   `\` endet (`'C:\'`) — selten, und das Ergebnis ist eine offene
 *   Zeichenkette, die die Plausibilitätsprüfung meldet.
 * - Nimmt man `\'` NICHT als Escape und die Datei nutzt es, zerreißt jedes
 *   Literal mit `\'` und einem folgenden `;` ein Statement — genau der
 *   gemeldete Defekt, und in Dumps alltäglich.
 *
 * Wer Standard-SQL indexiert und die Backtick-/`#`-Erweiterungen
 * ausschließen will, setzt `dialect: "doubled-quotes-only"`.
 */
export const DEFAULT_SQL_DIALECT: SqlDialect = "backslash-escapes";

interface StatementSpan {
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

function isAsciiWhitespaceByte(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x0b ||
    byte === 0x0c
  );
}

/**
 * After a statement-terminating `;` (buffer offset `semicolonEnd`, already
 * past the `;` itself), decides how far the just-CLOSED statement's span
 * should extend: through the rest of this physical line — its trailing
 * whitespace, an optional trailing `-- ...` line comment, and the newline
 * itself — when nothing else remains before that newline. This matches how
 * a statement "owns" the rest of its own terminator line in the common
 * case, where a schema file has exactly one statement per line (the exact
 * byte a hand-formatted schema's next statement starts on is then, as
 * before, the first byte of the following line).
 *
 * When real content follows the `;` on the SAME line instead — a second
 * statement sharing that line — this returns `semicolonEnd` UNCHANGED, so
 * that content starts its own span right where it begins rather than being
 * silently folded into the span that just closed (the WP-81 review's
 * "two statements, one line" defect: `TABLE_RE`/`VIEW_RE`/etc. would only
 * ever see the FIRST statement's text, and the second statement's own span
 * would either come out empty or never exist at all).
 */
function extendPastTrailingLineNoise(buffer: Buffer, semicolonEnd: number): number {
  let j = semicolonEnd;
  for (;;) {
    while (j < buffer.length && buffer[j] !== 0x0a && isAsciiWhitespaceByte(buffer[j]!)) {
      j += 1;
    }
    if (j < buffer.length && buffer[j] === 0x2d && buffer[j + 1] === 0x2d) {
      // "--": a trailing line comment on the terminator's own line is also
      // benign noise, not a new statement — skip to (not past) its newline.
      while (j < buffer.length && buffer[j] !== 0x0a) {
        j += 1;
      }
      continue; // a comment could be followed by more whitespace before the newline
    }
    break;
  }
  if (j >= buffer.length) return buffer.length;
  if (buffer[j] === 0x0a) return j + 1;
  return semicolonEnd; // real content follows on the same line: do not extend past the `;`
}

/** Byte-Konstanten des Scanners — alles Einzelbyte-ASCII, siehe `splitStatements`. */
const BYTE_NEWLINE = 0x0a;
const BYTE_HASH = 0x23;
const BYTE_DOLLAR = 0x24;
const BYTE_SINGLE_QUOTE = 0x27;
const BYTE_DOUBLE_QUOTE = 0x22;
const BYTE_BACKTICK = 0x60;
const BYTE_BACKSLASH = 0x5c;
const BYTE_STAR = 0x2a;
const BYTE_SLASH = 0x2f;
const BYTE_DASH = 0x2d;
const BYTE_SEMICOLON = 0x3b;
const BYTE_UNDERSCORE = 0x5f;

function isDigitByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isLetterByte(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/** Zeichen, die in einem `$tag$`-Etikett vorkommen dürfen (ohne `$` selbst). */
function isTagByte(byte: number | undefined): boolean {
  return (
    byte !== undefined && (isLetterByte(byte) || isDigitByte(byte) || byte === BYTE_UNDERSCORE)
  );
}

/**
 * Länge eines `$tag$`-Öffners an Position `i` (0, wenn dort keiner steht).
 *
 * Ein Dollar-Literal (`$$ … $$`, `$body$ … $body$`) ist der übliche Weg,
 * einen Funktionsrumpf einzubetten — und darin steht fast immer ein `;`.
 * Ohne diese Erkennung zerreißt jeder Funktionsrumpf in Fragmente, also
 * exakt derselbe Defekt wie bei den Backslash-Escapes, nur mit anderem
 * Auslöser. Erkannt wird das dialektübergreifend: `$tag$` hat außerhalb
 * einer Zeichenkette in keinem gängigen Dialekt eine andere Bedeutung, die
 * einen Statement-Zerleger interessieren müsste.
 *
 * Ein vorangehendes Bezeichnerzeichen verhindert die Erkennung — sonst
 * würde der Bezeichner `my$col$x` fälschlich ein Literal öffnen.
 */
function dollarQuoteLength(buffer: Buffer, i: number): number {
  if (buffer[i] !== BYTE_DOLLAR) return 0;
  const previous = i > 0 ? buffer[i - 1] : undefined;
  if (previous !== undefined && (isTagByte(previous) || previous === BYTE_DOLLAR)) return 0;
  let j = i + 1;
  const first = buffer[j];
  if (first !== undefined && (isLetterByte(first) || first === BYTE_UNDERSCORE)) {
    j += 1;
    while (j < buffer.length && isTagByte(buffer[j])) j += 1;
  }
  if (buffer[j] !== BYTE_DOLLAR) return 0;
  return j + 1 - i;
}

/** Ob an Position `i` genau das Etikett steht, das bei `tagStart` geöffnet wurde. */
function matchesDollarTag(buffer: Buffer, i: number, tagStart: number, tagLength: number): boolean {
  if (i + tagLength > buffer.length) return false;
  for (let k = 0; k < tagLength; k += 1) {
    if (buffer[i + k] !== buffer[tagStart + k]) return false;
  }
  return true;
}

/**
 * Splits `index`'s underlying document into top-level statement byte spans
 * (terminated by `;` outside strings/comments — see the module doc for why
 * this is byte-, not line-, precise). Scans the raw UTF-8 `Buffer` directly
 * (never the decoded JS string): every byte this function compares against
 * (`'`, `"`, `` ` ``, `$`, `#`, `;`, `-`, `/`, `*`, `\\`, ASCII whitespace) is
 * single-byte ASCII, and any UTF-8 continuation/multibyte-lead byte is
 * `>= 0x80` and never matches one of those comparisons — so scanning raw
 * bytes instead of UTF-16 code units never misreads a multibyte character
 * (e.g. inside a comment or string) as one of these ASCII control
 * characters. Das gilt auch für das Überspringen des Zeichens nach einem
 * `\\`: übersprungen wird ein einzelnes Byte, und die restlichen Bytes
 * eines Mehrbyte-Zeichens sind `>= 0x80` und lösen selbst nichts aus.
 *
 * `dialect` entscheidet über die Escape-Konvention (siehe {@link SqlDialect}).
 * Falsch geschnittene Ergebnisse bleiben trotzdem möglich — deshalb prüft
 * `sqlPlausibilityCheck` jedes fertige Fragment nach (WP-118, E4).
 */
function splitStatements(index: LineIndex, dialect: SqlDialect): StatementSpan[] {
  const { buffer } = index;
  const backslashEscapes = dialect === "backslash-escapes";
  const backtickIdentifiers = backslashEscapes;
  const hashLineComments = backslashEscapes;

  const spans: StatementSpan[] = [];
  let statementStartByte = 0;
  let statementHasContent = false;
  /** Offenes Anführungszeichen (`'`, `"` oder `` ` ``), sonst `undefined`. */
  let quoteByte: number | undefined;
  /** Länge des offenen `$tag$`-Etiketts (0 = kein Dollar-Literal offen). */
  let dollarTagLength = 0;
  let dollarTagStart = 0;
  let inLineComment = false;
  let inBlockComment = false;

  const flush = (endByteExclusive: number): void => {
    if (!statementHasContent) return;
    spans.push({
      startByte: statementStartByte,
      endByte: endByteExclusive,
      startLine: lineNumberForByte(index, statementStartByte),
      endLine: lineNumberForByte(index, endByteExclusive - 1),
    });
  };

  for (let i = 0; i < buffer.length; i += 1) {
    const c = buffer[i]!;
    const next = buffer[i + 1];

    if (inBlockComment) {
      if (c === BYTE_STAR && next === BYTE_SLASH) {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inLineComment) {
      if (c === BYTE_NEWLINE) inLineComment = false;
      continue;
    }
    if (dollarTagLength > 0) {
      if (c === BYTE_DOLLAR && matchesDollarTag(buffer, i, dollarTagStart, dollarTagLength)) {
        i += dollarTagLength - 1;
        dollarTagLength = 0;
      }
      statementHasContent = true;
      continue;
    }
    if (quoteByte !== undefined) {
      // Reihenfolge: erst Backslash (verschluckt AUCH ein direkt folgendes
      // Anführungszeichen), dann das verdoppelte Anführungszeichen, dann
      // das schließende. Innerhalb von `` ` `` ist `\` kein Escape — dort
      // ist die Verdopplung die einzige Konvention.
      if (backslashEscapes && quoteByte !== BYTE_BACKTICK && c === BYTE_BACKSLASH) {
        i += 1;
      } else if (c === quoteByte && next === quoteByte) {
        i += 1;
      } else if (c === quoteByte) {
        quoteByte = undefined;
      }
      statementHasContent = true;
      continue;
    }
    if (c === BYTE_DASH && next === BYTE_DASH) {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (hashLineComments && c === BYTE_HASH) {
      inLineComment = true;
      continue;
    }
    if (c === BYTE_SLASH && next === BYTE_STAR) {
      inBlockComment = true;
      i += 1;
      continue;
    }
    const dollarLength = dollarQuoteLength(buffer, i);
    if (dollarLength > 0) {
      dollarTagStart = i;
      dollarTagLength = dollarLength;
      i += dollarLength - 1;
      statementHasContent = true;
      continue;
    }
    if (
      c === BYTE_SINGLE_QUOTE ||
      c === BYTE_DOUBLE_QUOTE ||
      (backtickIdentifiers && c === BYTE_BACKTICK)
    ) {
      quoteByte = c;
      statementHasContent = true;
      continue;
    }
    if (c === BYTE_SEMICOLON) {
      const endByteExclusive = extendPastTrailingLineNoise(buffer, i + 1);
      flush(endByteExclusive);
      statementStartByte = endByteExclusive;
      statementHasContent = false;
      i = endByteExclusive - 1;
      continue;
    }
    if (!isAsciiWhitespaceByte(c)) {
      statementHasContent = true;
    }
  }
  // A final statement with no terminating `;` (the file's last statement
  // missing its semicolon) still becomes its own span — never silently
  // dropped (rule 4 / BUILD_PLAN §12 E4). Trailing whitespace-only content
  // after the true last `;` reaches here with `statementHasContent` still
  // `false` and correctly produces no extra span.
  flush(buffer.length);
  return spans;
}

/**
 * Trennzeichen-Konventionen für die Plausibilitätsprüfung, abgeleitet aus
 * demselben Dialekt wie die Zerlegung. Geprüft werden nur runde Klammern —
 * eckige Klammern sind in manchen Dialekten Bezeichner-Klammern und in
 * anderen Array-Syntax; sie zu prüfen brächte Fehlalarme statt Befunde.
 */
function sqlScanOptions(dialect: SqlDialect): DelimiterScanOptions {
  const backslashEscapes = dialect === "backslash-escapes";
  const quotes: QuoteRule[] = [
    { open: "'", close: "'", backslashEscapes, doubledEscapes: true, spansLines: true },
    { open: '"', close: '"', backslashEscapes, doubledEscapes: true, spansLines: true },
    // Backtick-Bezeichner kennt der Zerleger nur im Backslash-Dialekt, der
    // Prüfer dagegen IMMER — er darf misstrauischer sein als der Zerleger
    // (siehe `text/delimiter-balance.ts`). Genau so wird die falsche
    // Dialektwahl sichtbar: eine Datei mit `` `a;b` `` wird unter
    // `"doubled-quotes-only"` falsch geschnitten, und beide Fragmente
    // melden dann einen offenen Backtick, statt still zu bleiben. In
    // Standard-SQL ist ein einzelner Backtick ohnehin ungültig, ein
    // Fehlalarm also nicht möglich.
    { open: "`", close: "`", backslashEscapes: false, doubledEscapes: true, spansLines: true },
  ];
  return {
    quotes,
    brackets: [{ open: "(", close: ")" }],
    lineComments: backslashEscapes ? ["--", "#"] : ["--"],
    blockComment: { open: "/*", close: "*/" },
    dollarQuotedStrings: true,
  };
}

/**
 * Die eigentliche Antwort auf WP-118: ein Statement-Fragment mit offener
 * Zeichenkette, offenem Kommentar oder unausgeglichenen Klammern ist ein
 * Befund — auch dann, wenn die Byte-Abdeckung lückenlos ist, weil nichts
 * FEHLT, sondern etwas FALSCH GESCHNITTEN wurde.
 */
function sqlPlausibilityCheck(dialect: SqlDialect): ChunkPlausibilityCheck {
  const scanOptions = sqlScanOptions(dialect);
  return (chunk) => {
    const imbalances = findDelimiterImbalances(chunk.content, scanOptions);
    return imbalances.length === 0 ? undefined : describeDelimiterImbalances(imbalances);
  };
}

const TABLE_RE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)["`\]]?/i;
const VIEW_RE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)["`\]]?/i;
const INDEX_RE =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)["`\]]?\s+ON\s+["`[]?([\w.]+)["`\]]?/i;
const ALTER_CONSTRAINT_RE =
  /^\s*ALTER\s+TABLE\s+["`[]?([\w.]+)["`\]]?\s+ADD\s+CONSTRAINT\s+["`[]?([\w.]+)["`\]]?/i;

/** Strips leading whitespace and leading `--`/`/* *\/` comments so classification regexes only ever see real SQL. */
function stripLeadingComments(text: string): string {
  let remaining = text;
  for (;;) {
    const trimmed = remaining.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newlineIndex = trimmed.indexOf("\n");
      remaining = newlineIndex === -1 ? "" : trimmed.slice(newlineIndex + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const closeIndex = trimmed.indexOf("*/");
      remaining = closeIndex === -1 ? "" : trimmed.slice(closeIndex + 2);
      continue;
    }
    return trimmed;
  }
}

function classify(rawStatementText: string): { kind: string; title: string } {
  const statementText = stripLeadingComments(rawStatementText);
  const table = TABLE_RE.exec(statementText);
  if (table) return { kind: "sql_table", title: table[1]! };
  const view = VIEW_RE.exec(statementText);
  if (view) return { kind: "sql_view", title: view[1]! };
  const index = INDEX_RE.exec(statementText);
  if (index) return { kind: "sql_index", title: `${index[1]!} ON ${index[2]!}` };
  const constraint = ALTER_CONSTRAINT_RE.exec(statementText);
  if (constraint)
    return { kind: "sql_constraint", title: `${constraint[2]!} ON ${constraint[1]!}` };
  const firstWord = /^\s*(\w+)/.exec(statementText)?.[1] ?? "statement";
  return { kind: "sql_statement", title: firstWord.toUpperCase() };
}

function sqlDrafts(index: LineIndex, dialect: SqlDialect): ChunkDraft[] {
  return splitStatements(index, dialect).map((span) => {
    const text = sliceBytes(index, span.startByte, span.endByte);
    const { kind, title } = classify(text);
    return {
      kind,
      startLine: span.startLine,
      endLine: span.endLine,
      title,
      startByte: span.startByte,
      endByte: span.endByte,
    };
  });
}

/** Table name a chunk defines, when its kind is `"sql_table"` — used by `links()`. */
function tableNameOf(chunk: ArtifactChunk): string | undefined {
  return chunk.kind === "sql_table" ? chunk.title : undefined;
}

/** `snake_case`/`kebab-case` table name → PascalCase-ish repository class name guess. */
function guessRepositoryName(tableName: string): string {
  const bareName = tableName.includes(".") ? tableName.split(".").at(-1)! : tableName;
  const pascal = bareName
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${pascal}Repository`;
}

export interface SqlAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
  /**
   * Escape-Konvention der Zeichenketten-Literale. Standard:
   * {@link DEFAULT_SQL_DIALECT} (`"backslash-escapes"`) — die Begründung
   * dieser Wahl steht dort. Der Dialekt wird NICHT aus dem Dateiinhalt
   * erraten; er ist eine Entscheidung des Aufrufers.
   */
  dialect?: SqlDialect;
}

export function createSqlAdapter(options: SqlAdapterOptions = {}): ArtifactAdapter {
  const dialect = options.dialect ?? DEFAULT_SQL_DIALECT;
  const checkPlausibility = sqlPlausibilityCheck(dialect);
  return {
    supports(type: string, path: string): boolean {
      return type === "sql" || (type === "auto" && SQL_EXTENSION.test(path));
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "sql");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      const index = buildLineIndex(document.content);
      return buildChunksReportingSkips(
        document,
        index,
        sqlDrafts(index, dialect),
        options.onSkipLedgerGap,
        checkPlausibility,
      );
    },

    /**
     * Heuristic-only (architecture.md §20): guesses that table `orders`
     * has a corresponding `OrdersRepository` code symbol, purely from a
     * naming convention. `targetId` is deliberately left unset — this
     * adapter has no code-symbol index to resolve against, only the
     * repository-adapter graph-linking stage (a different WP) can turn
     * `targetName` into a real `targetId`. Confidence is fixed and
     * conservative: this guess is right often enough to be worth surfacing,
     * wrong often enough that a caller MUST treat it as a hint, never a fact.
     */
    links(document: ArtifactDocument): ArtifactLink[] {
      const index = buildLineIndex(document.content);
      const chunks = buildChunks(document, index, sqlDrafts(index, dialect));
      const links: ArtifactLink[] = [];
      for (const chunk of chunks) {
        const tableName = tableNameOf(chunk);
        if (tableName === undefined) continue;
        links.push({
          fromChunkId: chunk.chunkId,
          targetKind: "symbol",
          targetName: guessRepositoryName(tableName),
          heuristic: true,
          confidence: 0.4,
          note: `naming-convention guess: SQL table "${tableName}" → repository symbol, not a resolved reference`,
        });
      }
      return links;
    },
  };
}
