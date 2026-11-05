import { describe, expect, it } from "vitest";

import {
  identifierParts,
  informativeQueryTokens,
  isLikelyGermanQuestion,
  splitIdentifierRun,
  termFrequencies,
  tokenizeIdentifiers,
} from "./tokenize.js";

// Characterizes the unchanged tokenize.ts with SHA-256
// 4bb934fb694aff04164f111d34bf6c1a0ff1adf75eaea3560bf293d061719e99.
// These examples describe the existing query heuristic, not general language detection.
describe("German question characterization", () => {
  it("does not classify inputs without letter or number tokens", () => {
    for (const text of ["", " \t\n ", "___!? —"]) {
      expect(tokenizeIdentifiers(text)).toEqual([]);
      expect(informativeQueryTokens(text)).toEqual([]);
      expect(isLikelyGermanQuestion(text)).toBe(false);
    }
  });

  it("keeps English interrogatives outside the German question heuristic", () => {
    for (const text of [
      "How is readUser called?",
      "What does readUser return?",
      "Where does readUser live?",
      "When does readUser run?",
      "Which module owns readUser?",
      "Who calls readUser?",
      "Why retry readUser?",
    ]) {
      expect(isLikelyGermanQuestion(text)).toBe(false);
    }
    expect(informativeQueryTokens("How is readUser called?")).toEqual([
      "readuser",
      "read",
      "user",
      "called",
    ]);
  });

  it("does not classify English past-tense was as a German question", () => {
    expect(isLikelyGermanQuestion("Was the refreshCache operation successful?")).toBe(false);
    expect(isLikelyGermanQuestion("was refreshCache called by the handler?")).toBe(false);
  });

  it("requires question framing at the beginning even when later German grammar is present", () => {
    expect(isLikelyGermanQuestion("Der Index wird von dem Worker gelesen.")).toBe(false);
    expect(isLikelyGermanQuestion("Explain wo der Index ist")).toBe(false);
    expect(isLikelyGermanQuestion("2026 warum refreshCache?")).toBe(false);
  });

  it("recognizes warum before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Warum refreshCache?")).toBe(true);
  });

  it("recognizes wann before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Wann retryQueue?")).toBe(true);
  });

  it("recognizes welche before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Welche Funktion ruft readUser?")).toBe(true);
  });

  it("recognizes welchem before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Welchem Handler folgt enqueueJob?")).toBe(true);
  });

  it("recognizes welchen before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Welchen Pfad liest loadConfig?")).toBe(true);
  });

  it("recognizes welcher before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Welcher Handler validiert userId?")).toBe(true);
  });

  it("recognizes welches before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Welches Modul enthält parseConfig?")).toBe(true);
  });

  it("recognizes wer before an English code identifier", () => {
    expect(isLikelyGermanQuestion("Wer startet refreshIndex?")).toBe(true);
  });

  it("recognizes wie without requiring other German grammar", () => {
    expect(isLikelyGermanQuestion("Wie parseConfig?")).toBe(true);
  });

  it("recognizes wo despite surrounding punctuation and capitalization", () => {
    expect(isLikelyGermanQuestion(" \t\"WO\": loadConfig? ")).toBe(true);
  });

  it("recognizes the composed Unicode wofür opener", () => {
    expect(isLikelyGermanQuestion("Wofür benötigt openCache keyId?")).toBe(true);
  });

  it("recognizes the ASCII wofuer opener", () => {
    expect(isLikelyGermanQuestion("Wofuer benötigt openCache keyId?")).toBe(true);
  });

  it("recognizes in welche as two leading query words", () => {
    expect(isLikelyGermanQuestion("In welche Queue schreibt enqueueJob?")).toBe(true);
  });

  it("recognizes in welchem as two leading query words", () => {
    expect(isLikelyGermanQuestion("In welchem Modul liegt readUser?")).toBe(true);
  });

  it("recognizes in welchen as two leading query words", () => {
    expect(isLikelyGermanQuestion("In welchen Dateien lebt refreshIndex?")).toBe(true);
  });

  it("recognizes in welcher as two leading query words", () => {
    expect(isLikelyGermanQuestion("In welcher Klasse liegt loadConfig?")).toBe(true);
  });

  it("recognizes in welches as two leading query words", () => {
    expect(isLikelyGermanQuestion("In welches Feld schreibt parseConfig?")).toBe(true);
  });

  it("requires an immediate whole inflected pronoun after in", () => {
    expect(isLikelyGermanQuestion("In, welchem Modul liegt readUser?")).toBe(true);
    expect(isLikelyGermanQuestion("In cache welcher Handler?")).toBe(false);
    expect(isLikelyGermanQuestion("In wer ruft readUser?")).toBe(false);
    expect(isLikelyGermanQuestion("In welchemCache?")).toBe(false);
    expect(tokenizeIdentifiers("In welchemCache?")).toEqual([
      "in",
      "welchemcache",
      "welchem",
      "cache",
    ]);
  });

  it("recognizes was bedeutet without additional grammar markers", () => {
    expect(isLikelyGermanQuestion("Was bedeutet refreshCache?")).toBe(true);
  });

  it("recognizes was geschieht without additional grammar markers", () => {
    expect(isLikelyGermanQuestion("Was geschieht während refreshCache?")).toBe(true);
  });

  it("recognizes was ist without additional grammar markers", () => {
    expect(isLikelyGermanQuestion("Was ist readUser?")).toBe(true);
  });

  it("recognizes was passiert without additional grammar markers", () => {
    expect(isLikelyGermanQuestion("Was passiert während enqueueJob?")).toBe(true);
  });

  it("recognizes was sind without additional grammar markers", () => {
    expect(isLikelyGermanQuestion("Was sind userIds?")).toBe(true);
  });

  it("recognizes was werden without additional grammar markers", () => {
    expect(isLikelyGermanQuestion("Was werden cacheKeys ersetzen?")).toBe(true);
  });

  it("recognizes was wird without additional grammar markers", () => {
    expect(isLikelyGermanQuestion("Was wird refreshIndex ersetzen?")).toBe(true);
  });

  it("recognizes was with two distinct grammar tokens outside the predicate position", () => {
    expect(isLikelyGermanQuestion("Was macht der Cache mit dem Token?")).toBe(true);
    expect(isLikelyGermanQuestion("Was macht eine Funktion einer Klasse?")).toBe(true);
    expect(isLikelyGermanQuestion("Was cache der ist?")).toBe(true);
    expect(isLikelyGermanQuestion("Was derIst?")).toBe(true);
    expect(tokenizeIdentifiers("Was derIst?")).toEqual(["was", "derist", "der", "ist"]);
  });

  it("does not let repeated occurrences of one grammar word satisfy the threshold", () => {
    expect(isLikelyGermanQuestion("Was macht der Handler der cacheKey-Funktion?")).toBe(false);
    expect(isLikelyGermanQuestion("Was cache ist ist ist?")).toBe(false);
  });

  it("does not classify was when it has zero or one German grammar word", () => {
    expect(isLikelyGermanQuestion("Was refreshCache successful?")).toBe(false);
    expect(isLikelyGermanQuestion("Was macht der Cache?")).toBe(false);
    expect(isLikelyGermanQuestion("Was refreshCache ist?")).toBe(false);
  });

  it("treats was predicate punctuation as a separator but retains identifier boundaries", () => {
    expect(isLikelyGermanQuestion("Was, ist refreshCache?")).toBe(true);
    expect(isLikelyGermanQuestion("Was istCache?")).toBe(false);
    expect(isLikelyGermanQuestion("Was ist_cache?")).toBe(false);
    expect(tokenizeIdentifiers("Was istCache?")).toEqual(["was", "istcache", "ist", "cache"]);
  });

  it("does not promote question-word components inside a leading identifier", () => {
    expect(isLikelyGermanQuestion("wieCacheWorks")).toBe(false);
    expect(isLikelyGermanQuestion("wasIst")).toBe(false);
    expect(isLikelyGermanQuestion("in_welcher_Datei")).toBe(false);
    expect(tokenizeIdentifiers("in_welcher_Datei")).toEqual([
      "in_welcher_datei",
      "in",
      "welcher",
      "datei",
    ]);
    expect(identifierParts("in_welcher_Datei")).toEqual(["in", "welcher", "datei"]);
    expect(splitIdentifierRun("wasIst")).toEqual(["was", "ist"]);
  });

  it("normalizes decomposed question words while preserving Unicode code terms", () => {
    const text = "Wofu\u0308r größenÄnderung?";
    expect(isLikelyGermanQuestion(text)).toBe(true);
    expect(tokenizeIdentifiers(text)).toEqual([
      "wofür",
      "größenänderung",
      "größen",
      "änderung",
    ]);
    expect(informativeQueryTokens(text)).toEqual(["größenänderung", "größen", "änderung"]);
    expect(isLikelyGermanQuestion("用户名称")).toBe(false);
  });

  it("preserves exact informative query bags, repeated identifiers and stop-word fallback", () => {
    const informative = informativeQueryTokens("Wie ruft getUser_byId getUser_byId?");
    expect(informative).toEqual([
      "ruft",
      "getuser_byid",
      "get",
      "user",
      "id",
      "getuser_byid",
      "get",
      "user",
      "id",
    ]);
    expect([...termFrequencies(informative).entries()]).toEqual([
      ["ruft", 1],
      ["getuser_byid", 2],
      ["get", 2],
      ["user", 2],
      ["id", 2],
    ]);
    expect(informativeQueryTokens("is und was")).toEqual(["is", "und", "was"]);
  });
});
