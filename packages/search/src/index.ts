/**
 * @untangle-code/search — der Abrufkern von Untangle (spec.md §13,
 * architecture.md §18, vision.md §1b/§1d).
 *
 * Das Paket beantwortet die Frage, mit der der Nutzer das Produkt beschrieben
 * hat: „wenn ich nach ‚Funktion X' suche sollte ich schnell an der richtigen
 * Stelle landen, wenn nicht ist der Code vielleicht zu komplex bzw nicht
 * richtig dokumentiert." Beide Haelften stecken hier drin:
 *
 * - die SUCHE — hybrid aus dichtem Vektor, eigenem BM25 und exakten
 *   Symbolnamen, fusioniert per RRF, mit einer Score-Zerlegung, die jeden
 *   Rang begruendet;
 * - der BEFUND — dieselbe Zerlegung, gelesen als Aussage ueber den Code:
 *   `findability.ts` laesst ein Symbol sich selbst suchen und benennt die
 *   Ursache, wenn es sich nicht findet.
 *
 * Dieses Modul ist der EINZIGE oeffentliche Export des Pakets.
 */

// Bezeichner-bewusste Tokenisierung (Grundlage des lexikalischen Zweigs).
export * from "./tokenize.js";

// Deterministisches BM25 ueber den Kandidatenpool.
export * from "./bm25.js";

// Glob-Abgleich fuer Pfad-Ein-/Ausschluss.
export * from "./glob.js";

// Skip-Ledger-Sammler (E4).
export * from "./ledger.js";

// Gespeicherter Chunk-Payload → Kandidat.
export * from "./payload.js";

// Normalisierte Filter → PayloadFilter (plus die Filter, die nicht pushdown-faehig sind).
export * from "./filter.js";

// Exakte und nahe Symbolnamen-Treffer.
export * from "./symbol-match.js";

// Reciprocal Rank Fusion der drei Ranglisten.
export * from "./fusion.js";

// Score-Zerlegung samt Boost-Begrenzung (spec.md §13.3).
export * from "./scoring.js";

// Belegbare Relevanzentscheidung und Abwesenheitsaussage (WP-231).
export * from "./relevance.js";

// Dedupe (spec.md §13.5) und Diversifizierung (architecture.md §18.5).
export * from "./dedupe.js";
export * from "./diversify.js";

// Sortierung der Trefferliste.
export * from "./sort.js";

// Paket-eigene Vertraege (Modus, grep, Formate).
export * from "./types.js";

// Der Port und seine Injektionspunkte.
export * from "./port.js";

// Post-Ranking-Anreicherung aus persistierten Graphen.
export * from "./enrichment.js";

// Die Referenzimplementierung.
export * from "./engine.js";

// Ablehnung von Suchmustern mit exponentiellem Zurueckziehen.
export * from "./regex-safety.js";

// grep-Modus ueber den indexierten Inhalt.
export * from "./grep.js";

// Ausgabeformate (Text, JSON, JSONL).
export * from "./format.js";

// Findability je Symbol (vision.md §1d).
export * from "./findability.js";
export * from "./product-complexity.js";

// Harte Gueltigkeitsgrenze fuer reproduzierbare Live-Benchmarks.
export * from "./benchmark-integrity.js";
