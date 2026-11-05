/**
 * Erkennung von Suchmustern, deren Auswertung exponentiell werden kann.
 *
 * WARUM ES DIESE PRUEFUNG UEBERHAUPT GIBT: Die Auswertung eines regulaeren
 * Ausdrucks laeuft in JavaScript als EIN synchroner Aufruf. Solange er laeuft,
 * ist die Ereignisschleife blockiert — ein Timer feuert nicht, ein
 * `AbortSignal` kann nicht geprueft werden, ein Budget „durchsuchte Chunks"
 * wird nicht erreicht. Gemessen: ein einziger Chunk mit einer 31 Zeichen
 * langen Zeile und dem Muster `(a+)+$` hat den Aufruf ueber 88 Sekunden
 * festgehalten, obwohl `maxScannedChunks` 1 war und das Abbruchsignal nach
 * 200 ms gesetzt wurde. Ein gefaehrliches Muster muss deshalb VOR dem ersten
 * Speicherzugriff abgelehnt werden; nachtraeglich abbrechen laesst es sich
 * nicht.
 *
 * WARUM NICHT „VERSCHACHTELTER QUANTOR" ALS KRITERIUM: Die erste Fassung
 * dieser Pruefung suchte eine Wiederholung ueber einer Gruppe, die selbst eine
 * unbegrenzte Wiederholung enthaelt (`(a+)+`). Das ist ein SYNTAKTISCHER
 * Stellvertreter fuer die eigentliche Eigenschaft und trifft sie in beide
 * Richtungen daneben:
 *
 *   - `(a|a)+$` und `(\s|\t)+$` enthalten keinen verschachtelten Quantor und
 *     liefen trotzdem nie zurueck (gemessen: nach 30 s per SIGALRM getoetet).
 *     `(\s|\t)+$` ist dabei ein alltaegliches Muster — Suche nach
 *     Zeilenendleerraum.
 *   - `(a+b)+` und `(\w+\.)+` wurden abgelehnt, obwohl ihre Auswertung
 *     hoechstens polynomiell ist.
 *
 * Die tatsaechliche Ursache exponentieller Laufzeit ist MEHRDEUTIGKEIT unter
 * einer unbegrenzten Wiederholung: `R+` wird exponentiell, wenn ein Wort auf
 * mehr als eine Art durch `R` bzw. durch `R·R` zerlegt werden kann. Genau das
 * prueft dieses Modul — an einem geparsten Baum, nicht an der Zeichenkette.
 * Fuer jede unbegrenzte Wiederholung `R{n,}` gilt der Rumpf `R` als
 * gefaehrlich, wenn
 *
 *   (1) `R` das leere Wort matchen kann (`(a*)*`, `(a?)+`),
 *   (2) `R` eine Alternative enthaelt, deren Zweige ein GEMEINSAMES Wort
 *       matchen koennen (`(a|a)`, `(\s|\t)`),
 *   (3a) `R` am Ende unbegrenzt Zeichen aufsaugen kann, die `R` auch beginnen
 *       koennen (`a+`, `\w+\s?`), oder
 *   (3b) `R` am Anfang unbegrenzt Zeichen aufsaugen kann, die `R` auch beenden
 *       koennen (`\w+a`).
 *
 * `(a+b)+` und `(\w+\.)+` fallen durch keine dieser Regeln: der abschliessende
 * Pflichtteil (`b`, `.`) ist ein Trennzeichen, das die Zerlegung eindeutig
 * macht. Sie werden jetzt ausgefuehrt.
 *
 * BEKANNTE GRENZE, ausdruecklich benannt: Das bleibt eine ENTSCHEIDBARE
 * Naeherung eines unentscheidbaren Problems. Sie ist bewusst auf die sichere
 * Seite gebaut — im Zweifel wird abgelehnt (Rueckwaertsreferenzen unter einer
 * Wiederholung, `\p{…}` als „irgendein Zeichen") — aber sie ist kein Beweis.
 * Ein Muster, das sie passiert, kann im schlimmsten Fall noch immer
 * polynomiell teuer sein (etwa `\w+\d+` mit quadratischem Aufwand); nur die
 * exponentielle Familie ist abgedeckt.
 */

// ---------------------------------------------------------------------------
// Zeichenmengen
// ---------------------------------------------------------------------------

/** Groesster Unicode-Codepoint. */
const MAX_CODE_POINT = 0x10ffff;

/** Eine Zeichenmenge als sortierte, disjunkte, geschlossene Intervalle. */
interface CharSet {
  ranges: readonly (readonly [number, number])[];
}

const EMPTY_SET: CharSet = { ranges: [] };
const UNIVERSE: CharSet = { ranges: [[0, MAX_CODE_POINT]] };

function setOf(...ranges: (readonly [number, number])[]): CharSet {
  return normalizeSet({ ranges });
}

function singleton(codePoint: number): CharSet {
  return { ranges: [[codePoint, codePoint]] };
}

function normalizeSet(set: CharSet): CharSet {
  const sorted = [...set.ranges]
    .filter(([low, high]) => low <= high)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: [number, number][] = [];
  for (const [low, high] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && low <= last[1] + 1) {
      last[1] = Math.max(last[1], high);
      continue;
    }
    merged.push([low, high]);
  }
  return { ranges: merged };
}

function unionSets(left: CharSet, right: CharSet): CharSet {
  return normalizeSet({ ranges: [...left.ranges, ...right.ranges] });
}

function complementSet(set: CharSet): CharSet {
  const normalized = normalizeSet(set);
  const ranges: [number, number][] = [];
  let next = 0;
  for (const [low, high] of normalized.ranges) {
    if (low > next) {
      ranges.push([next, low - 1]);
    }
    next = Math.max(next, high + 1);
  }
  if (next <= MAX_CODE_POINT) {
    ranges.push([next, MAX_CODE_POINT]);
  }
  return { ranges };
}

function setsIntersect(left: CharSet, right: CharSet): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.ranges.length && rightIndex < right.ranges.length) {
    const a = left.ranges[leftIndex] as readonly [number, number];
    const b = right.ranges[rightIndex] as readonly [number, number];
    if (Math.max(a[0], b[0]) <= Math.min(a[1], b[1])) {
      return true;
    }
    if (a[1] < b[1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return false;
}

function isEmptySet(set: CharSet): boolean {
  return set.ranges.length === 0;
}

/**
 * ASCII-Faltung fuer `i`-Suchen. Nur ASCII: eine unvollstaendige Faltung macht
 * die Menge KLEINER als die Wirklichkeit, und eine zu kleine Menge koennte
 * eine Ueberschneidung uebersehen. Deshalb wird bei `i` zusaetzlich jedes
 * Intervall, das Buchstaben beruehrt, auf beide Schreibweisen erweitert — im
 * Zweifel zu gross, also auf der ablehnenden Seite.
 */
function foldCase(set: CharSet): CharSet {
  const upperA = 0x41;
  const upperZ = 0x5a;
  const lowerA = 0x61;
  const lowerZ = 0x7a;
  const extra: [number, number][] = [];
  for (const [low, high] of set.ranges) {
    const upperLow = Math.max(low, upperA);
    const upperHigh = Math.min(high, upperZ);
    if (upperLow <= upperHigh) {
      extra.push([upperLow + 0x20, upperHigh + 0x20]);
    }
    const lowerLow = Math.max(low, lowerA);
    const lowerHigh = Math.min(high, lowerZ);
    if (lowerLow <= lowerHigh) {
      extra.push([lowerLow - 0x20, lowerHigh - 0x20]);
    }
  }
  return extra.length === 0 ? set : unionSets(set, { ranges: extra });
}

const DIGIT_SET = setOf([0x30, 0x39]);
const WORD_SET = setOf([0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]);
const SPACE_SET = setOf(
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
);
/** `.` ohne `s`-Flag: alles ausser den Zeilentrennern. */
const DOT_SET = complementSet(setOf([0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]));

// ---------------------------------------------------------------------------
// Baum
// ---------------------------------------------------------------------------

type RegexNode =
  /** Ein zeichenverbrauchendes Atom. */
  | { kind: "chars"; set: CharSet }
  /** Nullbreite ohne eigene Zeichen: `^`, `$`, `\b`, Lookarounds. */
  | { kind: "zeroWidth" }
  /** Nicht analysierbar: Rueckwaertsreferenz (Laenge unbekannt). */
  | { kind: "opaque"; text: string }
  | { kind: "concat"; parts: RegexNode[] }
  | { kind: "alt"; branches: RegexNode[] }
  | { kind: "repeat"; body: RegexNode; min: number; max: number; text: string }
  | { kind: "group"; body: RegexNode; text: string };

class PatternParseError extends Error {}

/**
 * Rekursiv absteigender Parser fuer die Teilmenge der JavaScript-Syntax, die
 * fuer die Mehrdeutigkeitsfrage zaehlt. Was er nicht versteht, wird zu
 * `opaque` oder `chars(UNIVERSE)` — beides faellt in der Auswertung auf die
 * ablehnende Seite. Ein Muster, das er gar nicht parsen kann, wird NICHT
 * abgelehnt: dann ist es ohnehin syntaktisch fehlerhaft und `new RegExp`
 * meldet den echten Fehler.
 */
class PatternParser {
  private index = 0;

  public constructor(
    private readonly pattern: string,
    private readonly caseInsensitive: boolean,
  ) {}

  public parse(): RegexNode {
    const node = this.parseAlternation();
    if (this.index < this.pattern.length) {
      throw new PatternParseError(`unexpected "${this.pattern[this.index] ?? ""}"`);
    }
    return node;
  }

  private parseAlternation(): RegexNode {
    const branches: RegexNode[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.index += 1;
      branches.push(this.parseConcat());
    }
    return branches.length === 1 ? (branches[0] as RegexNode) : { kind: "alt", branches };
  }

  private parseConcat(): RegexNode {
    const parts: RegexNode[] = [];
    for (;;) {
      const char = this.peek();
      if (char === undefined || char === "|" || char === ")") {
        break;
      }
      parts.push(this.parseQuantified());
    }
    if (parts.length === 0) {
      return { kind: "zeroWidth" };
    }
    return parts.length === 1 ? (parts[0] as RegexNode) : { kind: "concat", parts };
  }

  private parseQuantified(): RegexNode {
    const start = this.index;
    const atom = this.parseAtom();
    const quantifier = this.readQuantifier();
    if (quantifier === undefined) {
      return atom;
    }
    // Faules `?` bzw. `+` (nur ES2025) aendert die Suchreihenfolge, nicht den
    // schlimmsten Fall — es wird uebergangen.
    if (this.peek() === "?" || this.peek() === "+") {
      this.index += 1;
    }
    return {
      kind: "repeat",
      body: atom,
      min: quantifier.min,
      max: quantifier.max,
      text: this.pattern.slice(start, this.index),
    };
  }

  private parseAtom(): RegexNode {
    const start = this.index;
    const char = this.peek();
    if (char === undefined) {
      throw new PatternParseError("unexpected end of pattern");
    }
    if (char === "(") {
      return this.parseGroup(start);
    }
    if (char === "[") {
      return { kind: "chars", set: this.parseCharacterClass() };
    }
    if (char === "\\") {
      return this.parseEscape();
    }
    if (char === "^" || char === "$") {
      this.index += 1;
      return { kind: "zeroWidth" };
    }
    if (char === ".") {
      this.index += 1;
      return { kind: "chars", set: this.applyCase(DOT_SET) };
    }
    if (char === "*" || char === "+" || char === "?") {
      throw new PatternParseError(`quantifier "${char}" without a preceding atom`);
    }
    const codePoint = this.pattern.codePointAt(this.index);
    if (codePoint === undefined) {
      throw new PatternParseError("unexpected end of pattern");
    }
    this.index += String.fromCodePoint(codePoint).length;
    return { kind: "chars", set: this.applyCase(singleton(codePoint)) };
  }

  private parseGroup(start: number): RegexNode {
    this.index += 1; // "("
    let isLookaround = false;
    if (this.peek() === "?") {
      const next = this.pattern[this.index + 1];
      if (next === ":") {
        this.index += 2;
      } else if (next === "=" || next === "!") {
        this.index += 2;
        isLookaround = true;
      } else if (
        next === "<" &&
        (this.pattern[this.index + 2] === "=" || this.pattern[this.index + 2] === "!")
      ) {
        this.index += 3;
        isLookaround = true;
      } else if (next === "<") {
        const close = this.pattern.indexOf(">", this.index + 2);
        if (close === -1) {
          throw new PatternParseError("unterminated group name");
        }
        this.index = close + 1;
      } else {
        throw new PatternParseError(`unsupported group prefix "(?${next ?? ""}"`);
      }
    }
    const body = this.parseAlternation();
    if (this.peek() !== ")") {
      throw new PatternParseError("unbalanced parenthesis");
    }
    this.index += 1;
    if (isLookaround) {
      // Nullbreite: ein Lookaround verbraucht kein Zeichen und traegt deshalb
      // weder zur Zerlegung noch zur Mehrdeutigkeit von `R·R` bei. Ihn
      // pauschal abzulehnen wuerde alltaegliche Muster wie `(?:(?!foo)\w)+`
      // treffen, die nachweislich eindeutig sind.
      return { kind: "zeroWidth" };
    }
    return { kind: "group", body, text: this.pattern.slice(start, this.index) };
  }

  private parseEscape(): RegexNode {
    this.index += 1; // "\\"
    const char = this.peek();
    if (char === undefined) {
      throw new PatternParseError("pattern ends with a backslash");
    }
    this.index += 1;
    switch (char) {
      case "d":
        return { kind: "chars", set: DIGIT_SET };
      case "D":
        return { kind: "chars", set: complementSet(DIGIT_SET) };
      case "w":
        return { kind: "chars", set: this.applyCase(WORD_SET) };
      case "W":
        return { kind: "chars", set: complementSet(WORD_SET) };
      case "s":
        return { kind: "chars", set: SPACE_SET };
      case "S":
        return { kind: "chars", set: complementSet(SPACE_SET) };
      case "b":
      case "B":
        return { kind: "zeroWidth" };
      case "t":
        return { kind: "chars", set: singleton(0x09) };
      case "n":
        return { kind: "chars", set: singleton(0x0a) };
      case "r":
        return { kind: "chars", set: singleton(0x0d) };
      case "f":
        return { kind: "chars", set: singleton(0x0c) };
      case "v":
        return { kind: "chars", set: singleton(0x0b) };
      case "0":
        return { kind: "chars", set: singleton(0x00) };
      case "p":
      case "P": {
        // `\p{…}` ist EIN Zeichen, dessen Menge hier nicht aufgeloest wird:
        // als „irgendein Zeichen" gelesen ueberschneidet es sich mit allem und
        // faellt damit auf die ablehnende Seite.
        this.skipBracedArgument();
        return { kind: "chars", set: UNIVERSE };
      }
      case "k": {
        this.skipAngledArgument();
        return { kind: "opaque", text: "\\k<…>" };
      }
      case "u":
      case "x": {
        const codePoint = this.readHexEscape(char);
        return { kind: "chars", set: this.applyCase(singleton(codePoint)) };
      }
      case "c": {
        this.index += 1;
        return { kind: "chars", set: UNIVERSE };
      }
      default: {
        if (char >= "1" && char <= "9") {
          while (/[0-9]/u.test(this.peek() ?? "")) {
            this.index += 1;
          }
          return { kind: "opaque", text: `\\${char}` };
        }
        return { kind: "chars", set: this.applyCase(singleton(char.codePointAt(0) as number)) };
      }
    }
  }

  private readHexEscape(kind: string): number {
    if (kind === "u" && this.peek() === "{") {
      const close = this.pattern.indexOf("}", this.index);
      if (close === -1) {
        throw new PatternParseError("unterminated \\u{…}");
      }
      const value = Number.parseInt(this.pattern.slice(this.index + 1, close), 16);
      this.index = close + 1;
      return Number.isNaN(value) ? 0 : value;
    }
    const width = kind === "u" ? 4 : 2;
    const text = this.pattern.slice(this.index, this.index + width);
    if (text.length < width || !/^[0-9a-fA-F]+$/u.test(text)) {
      throw new PatternParseError(`malformed \\${kind} escape`);
    }
    this.index += width;
    return Number.parseInt(text, 16);
  }

  private skipBracedArgument(): void {
    if (this.peek() !== "{") {
      throw new PatternParseError("\\p must be followed by {…}");
    }
    const close = this.pattern.indexOf("}", this.index);
    if (close === -1) {
      throw new PatternParseError("unterminated \\p{…}");
    }
    this.index = close + 1;
  }

  private skipAngledArgument(): void {
    if (this.peek() !== "<") {
      throw new PatternParseError("\\k must be followed by <…>");
    }
    const close = this.pattern.indexOf(">", this.index);
    if (close === -1) {
      throw new PatternParseError("unterminated \\k<…>");
    }
    this.index = close + 1;
  }

  private parseCharacterClass(): CharSet {
    this.index += 1; // "["
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.index += 1;
    }
    let set: CharSet = EMPTY_SET;
    let pendingLow: number | undefined;
    let closed = false;
    while (this.index < this.pattern.length) {
      if (this.peek() === "]") {
        this.index += 1;
        closed = true;
        break;
      }
      const item = this.readClassItem();
      if (item.set !== undefined) {
        // Eine Klassen-Kurzform (`\d`) kann kein Bereichsende sein.
        if (pendingLow !== undefined) {
          set = unionSets(set, singleton(pendingLow));
          pendingLow = undefined;
        }
        set = unionSets(set, item.set);
        continue;
      }
      const codePoint = item.codePoint as number;
      if (pendingLow !== undefined) {
        set = unionSets(set, setOf([pendingLow, codePoint]));
        pendingLow = undefined;
        continue;
      }
      if (this.peek() === "-" && this.pattern[this.index + 1] !== "]") {
        this.index += 1;
        pendingLow = codePoint;
        continue;
      }
      set = unionSets(set, singleton(codePoint));
    }
    if (!closed) {
      throw new PatternParseError("unterminated character class");
    }
    if (pendingLow !== undefined) {
      set = unionSets(set, singleton(pendingLow));
    }
    const resolved = negated ? complementSet(set) : set;
    return this.applyCase(resolved);
  }

  private readClassItem(): { set?: CharSet; codePoint?: number } {
    if (this.peek() !== "\\") {
      const codePoint = this.pattern.codePointAt(this.index) as number;
      this.index += String.fromCodePoint(codePoint).length;
      return { codePoint };
    }
    const node = this.parseEscape();
    if (node.kind === "chars") {
      if (node.set.ranges.length === 1) {
        const [low, high] = node.set.ranges[0] as readonly [number, number];
        if (low === high) {
          return { codePoint: low };
        }
      }
      return { set: node.set };
    }
    // `\b` heisst in einer Klasse Backspace; alles Uebrige (Rueckwaerts-
    // referenzen gibt es hier nicht) wird als „irgendein Zeichen" gelesen.
    return { set: UNIVERSE };
  }

  private readQuantifier(): { min: number; max: number } | undefined {
    const char = this.peek();
    if (char === "*") {
      this.index += 1;
      return { min: 0, max: Number.POSITIVE_INFINITY };
    }
    if (char === "+") {
      this.index += 1;
      return { min: 1, max: Number.POSITIVE_INFINITY };
    }
    if (char === "?") {
      this.index += 1;
      return { min: 0, max: 1 };
    }
    if (char !== "{") {
      return undefined;
    }
    const close = this.pattern.indexOf("}", this.index + 1);
    if (close === -1) {
      return undefined; // `{` als Literal
    }
    const body = this.pattern.slice(this.index + 1, close);
    const match = /^(\d+)(,(\d*)?)?$/u.exec(body);
    if (match === null) {
      return undefined; // `{` als Literal
    }
    const min = Number(match[1]);
    const hasComma = match[2] !== undefined;
    const maxText = match[3];
    const max =
      hasComma && (maxText === undefined || maxText === "")
        ? Number.POSITIVE_INFINITY
        : hasComma
          ? Number(maxText)
          : min;
    this.index = close + 1;
    return { min, max };
  }

  private applyCase(set: CharSet): CharSet {
    return this.caseInsensitive ? foldCase(set) : set;
  }

  private peek(): string | undefined {
    return this.pattern[this.index];
  }
}

// ---------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------

/** Kann der Knoten das leere Wort matchen? */
function isNullable(node: RegexNode): boolean {
  switch (node.kind) {
    case "chars":
      return false;
    case "zeroWidth":
      return true;
    case "opaque":
      return true; // eine Rueckwaertsreferenz kann leer sein
    case "concat":
      return node.parts.every(isNullable);
    case "alt":
      return node.branches.some(isNullable);
    case "repeat":
      return node.min === 0 || isNullable(node.body);
    case "group":
      return isNullable(node.body);
  }
}

/** Alle Zeichen, die der Knoten ueberhaupt verbrauchen kann (Ueberschaetzung). */
function consumableSet(node: RegexNode): CharSet {
  switch (node.kind) {
    case "chars":
      return node.set;
    case "zeroWidth":
      return EMPTY_SET;
    case "opaque":
      return UNIVERSE;
    case "concat":
      return node.parts.reduce<CharSet>(
        (acc, part) => unionSets(acc, consumableSet(part)),
        EMPTY_SET,
      );
    case "alt":
      return node.branches.reduce<CharSet>(
        (acc, branch) => unionSets(acc, consumableSet(branch)),
        EMPTY_SET,
      );
    case "repeat":
      return node.max === 0 ? EMPTY_SET : consumableSet(node.body);
    case "group":
      return consumableSet(node.body);
  }
}

/** Zeichen, mit denen ein Treffer des Knotens beginnen kann. */
function firstSet(node: RegexNode): CharSet {
  return edgeSet(node, "first");
}

/** Zeichen, mit denen ein Treffer des Knotens enden kann. */
function lastSet(node: RegexNode): CharSet {
  return edgeSet(node, "last");
}

function edgeSet(node: RegexNode, side: "first" | "last"): CharSet {
  switch (node.kind) {
    case "chars":
      return node.set;
    case "zeroWidth":
      return EMPTY_SET;
    case "opaque":
      return UNIVERSE;
    case "alt":
      return node.branches.reduce<CharSet>(
        (acc, branch) => unionSets(acc, edgeSet(branch, side)),
        EMPTY_SET,
      );
    case "group":
      return edgeSet(node.body, side);
    case "repeat":
      return node.max === 0 ? EMPTY_SET : edgeSet(node.body, side);
    case "concat": {
      const order = side === "first" ? node.parts : [...node.parts].reverse();
      let acc: CharSet = EMPTY_SET;
      for (const part of order) {
        acc = unionSets(acc, edgeSet(part, side));
        if (!isNullable(part)) {
          break;
        }
      }
      return acc;
    }
  }
}

/**
 * Zeichen, die der Knoten an seinem Rand UNBEGRENZT aufsaugen kann.
 *
 * Das ist die Menge, die eine Zerlegung von `R·R` mehrdeutig macht: kann `R`
 * am Ende beliebig viele Zeichen schlucken, die `R` auch beginnen koennen,
 * dann gibt es zu einem Wort mehr als eine Aufteilung — und genau daraus
 * entsteht das exponentielle Zurueckziehen.
 */
function unboundedEdgeSet(node: RegexNode, side: "first" | "last"): CharSet {
  switch (node.kind) {
    case "chars":
    case "zeroWidth":
    case "opaque":
      return EMPTY_SET;
    case "alt":
      return node.branches.reduce<CharSet>(
        (acc, branch) => unionSets(acc, unboundedEdgeSet(branch, side)),
        EMPTY_SET,
      );
    case "group":
      return unboundedEdgeSet(node.body, side);
    case "repeat":
      return node.max === Number.POSITIVE_INFINITY
        ? unionSets(consumableSet(node.body), unboundedEdgeSet(node.body, side))
        : unboundedEdgeSet(node.body, side);
    case "concat": {
      const order = side === "first" ? node.parts : [...node.parts].reverse();
      let acc: CharSet = EMPTY_SET;
      for (const part of order) {
        acc = unionSets(acc, unboundedEdgeSet(part, side));
        if (!isNullable(part)) {
          break;
        }
      }
      return acc;
    }
  }
}

/** Feste Laenge eines Knotens in Zeichen, oder `undefined` bei Variabilitaet. */
function fixedLength(node: RegexNode): number | undefined {
  switch (node.kind) {
    case "chars":
      return 1;
    case "zeroWidth":
      return 0;
    case "opaque":
      return undefined;
    case "concat": {
      let total = 0;
      for (const part of node.parts) {
        const length = fixedLength(part);
        if (length === undefined) {
          return undefined;
        }
        total += length;
      }
      return total;
    }
    case "alt": {
      let common: number | undefined;
      for (const branch of node.branches) {
        const length = fixedLength(branch);
        if (length === undefined || (common !== undefined && common !== length)) {
          return undefined;
        }
        common = length;
      }
      return common;
    }
    case "repeat":
      if (node.min !== node.max) {
        return undefined;
      }
      {
        const length = fixedLength(node.body);
        return length === undefined ? undefined : length * node.min;
      }
    case "group":
      return fixedLength(node.body);
  }
}

/**
 * Die Zeichenmenge an Position `offset` eines Knotens FESTER Laenge.
 * Nur fuer solche Knoten definiert; sonst `UNIVERSE` (ablehnende Seite).
 */
function setAtPosition(node: RegexNode, offset: number): CharSet {
  switch (node.kind) {
    case "chars":
      return offset === 0 ? node.set : EMPTY_SET;
    case "zeroWidth":
      return EMPTY_SET;
    case "opaque":
      return UNIVERSE;
    case "group":
      return setAtPosition(node.body, offset);
    case "alt":
      return node.branches.reduce<CharSet>(
        (acc, branch) => unionSets(acc, setAtPosition(branch, offset)),
        EMPTY_SET,
      );
    case "concat": {
      let consumed = 0;
      for (const part of node.parts) {
        const length = fixedLength(part);
        if (length === undefined) {
          return UNIVERSE;
        }
        if (offset < consumed + length) {
          return setAtPosition(part, offset - consumed);
        }
        consumed += length;
      }
      return EMPTY_SET;
    }
    case "repeat": {
      const bodyLength = fixedLength(node.body);
      if (bodyLength === undefined || bodyLength === 0) {
        return UNIVERSE;
      }
      return setAtPosition(node.body, offset % bodyLength);
    }
  }
}

/**
 * Koennen zwei Alternativzweige unter einer Wiederholung eine mehrdeutige
 * Zerlegung erzeugen?
 *
 * GLEICHE FESTE LAENGE ist exakt entscheidbar: ein gemeinsames Wort gibt es
 * genau dann, wenn sich die Zeichenmengen an JEDER Position ueberschneiden.
 * `(a|b)` und `(ab|ac)` fallen damit durch — zu Recht.
 *
 * VERSCHIEDENE FESTE LAENGE ist der Fall, an dem eine reine „gemeinsames
 * Wort"-Pruefung zu kurz greift: `(x|xx)+` hat keine zwei Zweige mit
 * gemeinsamem Wort und ist trotzdem exponentiell, weil der kuerzere Zweig ein
 * PRAEFIX des laengeren ist und `n` Zeichen sich damit auf Fibonacci-viele
 * Arten zerlegen lassen. Geprueft wird deshalb das Praefix — das ist der
 * Ansatz von Sardinas/Patterson in seiner ersten Runde. Der Preis ist eine
 * bewusste Ueber-Sperrung: `(a|ab)+` wird abgelehnt, obwohl es eindeutig ist.
 *
 * VARIABLE LAENGE laesst sich hier nicht mehr entscheiden; dann entscheiden
 * die Anfangszeichen, wieder auf der ablehnenden Seite.
 */
function branchesCanShareWord(left: RegexNode, right: RegexNode): boolean {
  if (isNullable(left) && isNullable(right)) {
    return true;
  }
  const leftLength = fixedLength(left);
  const rightLength = fixedLength(right);
  if (leftLength !== undefined && rightLength !== undefined) {
    const shorter = leftLength <= rightLength ? left : right;
    const longer = leftLength <= rightLength ? right : left;
    const overlap = Math.min(leftLength, rightLength);
    for (let offset = 0; offset < overlap; offset += 1) {
      if (!setsIntersect(setAtPosition(shorter, offset), setAtPosition(longer, offset))) {
        return false;
      }
    }
    return true;
  }
  return setsIntersect(firstSet(left), firstSet(right));
}

/** Sammelt alle Alternativknoten unterhalb (und einschliesslich) `node`. */
function collectAlternations(node: RegexNode, into: RegexNode[]): void {
  switch (node.kind) {
    case "alt":
      into.push(node);
      node.branches.forEach((branch) => collectAlternations(branch, into));
      return;
    case "concat":
      node.parts.forEach((part) => collectAlternations(part, into));
      return;
    case "group":
    case "repeat":
      collectAlternations(node.body, into);
      return;
    default:
      return;
  }
}

/** Enthaelt der Teilbaum eine Rueckwaertsreferenz? */
function containsBackreference(node: RegexNode): boolean {
  switch (node.kind) {
    case "opaque":
      return true;
    case "concat":
      return node.parts.some(containsBackreference);
    case "alt":
      return node.branches.some(containsBackreference);
    case "group":
    case "repeat":
      return containsBackreference(node.body);
    default:
      return false;
  }
}

function describe(node: RegexNode): string {
  if (node.kind === "group" || node.kind === "repeat") {
    return node.text;
  }
  return "the repeated subexpression";
}

/**
 * Begruendung, warum der Rumpf einer unbegrenzten Wiederholung mehrdeutig ist
 * — oder `undefined`, wenn er es nachweislich nicht ist.
 */
function ambiguityReason(body: RegexNode, repeatText: string): string | undefined {
  if (isNullable(body)) {
    return `the repeated subexpression in "${repeatText}" can match the empty string, so a word has unboundedly many decompositions`;
  }
  if (containsBackreference(body)) {
    return `the repeated subexpression in "${repeatText}" contains a backreference, whose matched length is unknown; ambiguity cannot be ruled out`;
  }
  const alternations: RegexNode[] = [];
  collectAlternations(body, alternations);
  for (const alternation of alternations) {
    if (alternation.kind !== "alt") {
      continue;
    }
    for (let left = 0; left < alternation.branches.length; left += 1) {
      for (let right = left + 1; right < alternation.branches.length; right += 1) {
        const a = alternation.branches[left] as RegexNode;
        const b = alternation.branches[right] as RegexNode;
        if (branchesCanShareWord(a, b)) {
          return `two alternatives inside "${repeatText}" can match the same text, so the repetition can split a word in more than one way`;
        }
      }
    }
  }
  const tail = unboundedEdgeSet(body, "last");
  if (!isEmptySet(tail) && setsIntersect(tail, firstSet(body))) {
    return `"${repeatText}" can absorb characters at the end of one repetition that could equally start the next one, so a word has more than one decomposition`;
  }
  const head = unboundedEdgeSet(body, "first");
  if (!isEmptySet(head) && setsIntersect(head, lastSet(body))) {
    return `"${repeatText}" can absorb characters at the start of one repetition that could equally end the previous one, so a word has more than one decomposition`;
  }
  return undefined;
}

/** Durchsucht den Baum nach einer gefaehrlichen Wiederholung. */
function findAmbiguousRepetition(node: RegexNode): string | undefined {
  switch (node.kind) {
    case "repeat": {
      // `max > 1` genau wie zuvor: schon `(a+){2}` verdoppelt den Aufwand je
      // Schachtelungsebene, und `{2,}` ist ohnehin unbegrenzt.
      if (node.max > 1) {
        const reason = ambiguityReason(node.body, describe(node));
        if (reason !== undefined) {
          return reason;
        }
      }
      return findAmbiguousRepetition(node.body);
    }
    case "group":
      return findAmbiguousRepetition(node.body);
    case "concat": {
      for (const part of node.parts) {
        const reason = findAmbiguousRepetition(part);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    }
    case "alt": {
      for (const branch of node.branches) {
        const reason = findAmbiguousRepetition(branch);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Optionen der Sicherheitspruefung. */
export interface GrepPatternSafetyOptions {
  /** True, wenn das Muster mit dem `i`-Flag laufen soll. */
  caseInsensitive?: boolean;
}

/**
 * Beschreibt, warum ein Muster als unsicher gilt — oder `undefined`, wenn die
 * Pruefung keine exponentielle Mehrdeutigkeit findet.
 *
 * Ein Muster, das der Parser nicht versteht, gilt hier als sicher: es ist dann
 * syntaktisch fehlerhaft, und `new RegExp` meldet den zutreffenden Fehler,
 * statt dass diese Pruefung eine falsche Begruendung erfindet (E4).
 */
export function findUnsafeGrepPattern(
  pattern: string,
  options: GrepPatternSafetyOptions = {},
): string | undefined {
  const caseInsensitive = options.caseInsensitive === true;
  let tree: RegexNode;
  try {
    tree = new PatternParser(pattern, caseInsensitive).parse();
  } catch {
    // WICHTIG: „mein Parser hat es nicht verstanden" heisst NICHT „das Muster
    // ist harmlos". Ohne diese Unterscheidung waere jede Luecke im Parser eine
    // stille Luecke in der Sicherheitspruefung — das Muster liefe ungeprueft.
    // Also wird gegenueber der Sprache selbst geprueft: haelt `RegExp` das
    // Muster fuer gueltig, ist es GUELTIG UND UNANALYSIERBAR und wird
    // abgelehnt. Haelt `RegExp` es fuer fehlerhaft, ist der Syntaxfehler die
    // zutreffende Meldung, und diese Pruefung erfindet keine zweite (E4).
    try {
      new RegExp(pattern, caseInsensitive ? "ui" : "u");
    } catch {
      return undefined;
    }
    return `the pattern uses a construct this safety check cannot analyse, so exponential backtracking cannot be ruled out`;
  }
  return findAmbiguousRepetition(tree);
}

/**
 * Wirft, wenn das Muster exponentielles Zurueckziehen ausloesen kann.
 *
 * Siehe den Modulkopf fuer das Kriterium und seine ausdrueckliche Grenze.
 */
export function assertSafeGrepPattern(
  pattern: string,
  options: GrepPatternSafetyOptions = {},
): void {
  const unsafe = findUnsafeGrepPattern(pattern, options);
  if (unsafe !== undefined) {
    throw new Error(
      `grep pattern is rejected as unsafe: ${unsafe}. Such a repetition can take exponential time to evaluate, and that evaluation cannot be interrupted — not by maxScannedChunks and not by an abort signal. Rewrite the repeated part so that each repetition has exactly one possible decomposition (for example by ending it with a character the repetition itself cannot match).`,
    );
  }
}
