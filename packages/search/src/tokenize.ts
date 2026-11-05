/**
 * Bezeichner-bewusste Tokenisierung fuer den lexikalischen Zweig
 * (spec.md §13.2 Schritt 3: „Query normalisieren, ohne Identifier-Zeichen zu
 * zerstoeren").
 *
 * Eine reine Wortgrenzen-Tokenisierung („alles ausser Buchstaben/Ziffern ist
 * Trenner") zerlegt `get_user_by_id` korrekt, `getUserById` aber ueberhaupt
 * nicht — dabei ist genau das der Fall, den der Nutzer meint, wenn er nach
 * „Funktion X" sucht. Diese Tokenisierung liefert deshalb ZWEI Ebenen:
 *
 * 1. den ganzen, kleingeschriebenen Bezeichner (`getuserbyid`) — damit ein
 *    exakter Namenstreffer den hoechsten lexikalischen Gewinn hat;
 * 2. seine Teilwoerter (`get`, `user`, `by`, `id`) — damit ein Treffer auch
 *    ueber Teilbegriffe gefunden wird.
 *
 * Beide Ebenen landen im selben Token-Bag. Das ist bewusst: BM25 belohnt
 * dadurch einen Volltreffer zusaetzlich zu seinen Teilen, ohne dass es dafuer
 * ein Sonderregelwerk im Ranker braucht.
 *
 * Alles hier ist reine Arithmetik ueber den Eingabetext — kein Locale, keine
 * Zeit, kein Zufall (docs/BUILD_PLAN.md §3 „Determinismus").
 */

import { tokenizeIdentifiers } from "@untangle-code/domain";

// Indexing, sparse queries and reranking must use one versioned token space.
export { identifierParts, splitIdentifierRun, tokenizeIdentifiers } from "@untangle-code/domain";

/**
 * Funktionswoerter, die in frei formulierten Suchfragen fast nur die Form der
 * Frage beschreiben. Sie als BM25-Begriffe zu werten bevorzugt lange Prosa,
 * die ebenfalls oft "wo wird"/"how is" enthaelt, vor dem gesuchten Code.
 *
 * Die Liste ist absichtlich klein und enthaelt nur geschlossene grammatische
 * Klassen in Deutsch und Englisch. Fachwoerter, Verben und Bezeichner werden
 * nie als Stopwoerter geraten. Wenn eine Anfrage ausschliesslich daraus
 * besteht, faellt {@link informativeQueryTokens} auf die Originaltokens
 * zurueck, damit beispielsweise eine Symbolsuche nach `is` nicht verschwindet.
 */
const QUERY_STOP_WORDS = new Set([
  "a",
  "als",
  "an",
  "and",
  "are",
  "as",
  "at",
  "auf",
  "aus",
  "be",
  "bei",
  "by",
  "das",
  "dass",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "does",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "eines",
  "es",
  "for",
  "from",
  "für",
  "fuer",
  "how",
  "im",
  "in",
  "into",
  "is",
  "ist",
  "it",
  "mit",
  "of",
  "on",
  "or",
  "sich",
  "sind",
  "that",
  "the",
  "this",
  "to",
  "und",
  "von",
  "was",
  "wann",
  "warum",
  "werden",
  "what",
  "when",
  "where",
  "which",
  "wie",
  "wird",
  "with",
  "wo",
  "wofür",
  "wofuer",
  "who",
  "why",
  "welche",
  "welchem",
  "welchen",
  "welcher",
  "welches",
  "wer",
  "zu",
]);

const UNAMBIGUOUS_GERMAN_QUESTION_OPENERS = new Set([
  "warum",
  "wann",
  "welche",
  "welchem",
  "welchen",
  "welcher",
  "welches",
  "wer",
  "wie",
  "wo",
  "wofür",
  "wofuer",
]);

const GERMAN_WAS_PREDICATES = new Set([
  "bedeutet",
  "geschieht",
  "ist",
  "passiert",
  "sind",
  "werden",
  "wird",
]);

const GERMAN_INFLECTED_QUESTION_PRONOUNS = new Set([
  "welche",
  "welchem",
  "welchen",
  "welcher",
  "welches",
]);

const GERMAN_GRAMMAR_MARKERS = new Set([
  "das",
  "dass",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "eines",
  "ist",
  "sich",
  "und",
  "von",
  "werden",
  "wird",
  "zu",
]);

/**
 * Tokenisiert eine frei formulierte Anfrage fuer den lexikalischen Rang und
 * entfernt nur grammatische Fragehuelsen. Wiederholungen bleiben erhalten;
 * der Aufrufer entscheidet wie beim normalen Token-Bag selbst, ob er daraus
 * eine Menge oder Haeufigkeiten braucht.
 */
export function informativeQueryTokens(text: string): string[] {
  const tokens = tokenizeIdentifiers(text);
  const informative = tokens.filter((token) => !QUERY_STOP_WORDS.has(token));
  return informative.length === 0 ? tokens : informative;
}

/**
 * Erkennt die enge Form, fuer die der Benchmark einen systematischen
 * Cross-Language-Konflikt belegt: eine deutsch formulierte Frage vor
 * ueberwiegend englischen Codebezeichnern. Das ist bewusst KEINE allgemeine
 * Spracherkennung. Eindeutige deutsche Fragewoerter reichen; das auch im
 * Englischen vorkommende `was` braucht zwei weitere Grammatikmarker.
 */
export function isLikelyGermanQuestion(text: string): boolean {
  const tokens = tokenizeIdentifiers(text);
  const first = tokens[0];
  if (first === undefined) {
    return false;
  }
  return (
    UNAMBIGUOUS_GERMAN_QUESTION_OPENERS.has(first) ||
    (first === "in" && GERMAN_INFLECTED_QUESTION_PRONOUNS.has(tokens[1] ?? "")) ||
    (first === "was" &&
      (GERMAN_WAS_PREDICATES.has(tokens[1] ?? "") ||
        new Set(tokens.filter((token) => GERMAN_GRAMMAR_MARKERS.has(token))).size >= 2))
  );
}

/** Token-Haeufigkeiten als Map; Reihenfolge der Einfuegung ist Textreihenfolge. */
export function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
