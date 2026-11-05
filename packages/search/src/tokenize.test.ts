import { tokenizeIdentifiers as domainTokens } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  identifierParts,
  informativeQueryTokens,
  isLikelyGermanQuestion,
  splitIdentifierRun,
  termFrequencies,
  tokenizeIdentifiers,
} from "./tokenize.js";

describe("splitIdentifierRun", () => {
  it("splits camelCase", () => {
    expect(splitIdentifierRun("getUserById")).toEqual(["get", "user", "by", "id"]);
  });

  it("keeps an acronym together and starts the next word at its last capital", () => {
    expect(splitIdentifierRun("HTTPServer")).toEqual(["http", "server"]);
  });

  it("splits at a digit-to-capital boundary", () => {
    expect(splitIdentifierRun("v2Token")).toEqual(["v2", "token"]);
  });

  it("leaves an all-lowercase run alone", () => {
    expect(splitIdentifierRun("charge")).toEqual(["charge"]);
  });
});

describe("tokenizeIdentifiers", () => {
  it("emits the whole identifier AND its parts", () => {
    expect(tokenizeIdentifiers("getUser")).toEqual(["getuser", "get", "user"]);
  });

  it("does not double-count a single-word run", () => {
    expect(tokenizeIdentifiers("charge")).toEqual(["charge"]);
  });

  it("splits on punctuation without losing identifier characters", () => {
    expect(tokenizeIdentifiers("payment_service.charge(amount)")).toEqual([
      "payment_service",
      "payment",
      "service",
      "charge",
      "amount",
    ]);
  });

  it("is deterministic across calls", () => {
    const text = "PaymentService.rotateToken(v2Token)";
    expect(tokenizeIdentifiers(text)).toEqual(tokenizeIdentifiers(text));
  });

  it("shares the document/query token space with sparse indexing", () => {
    for (const text of ["getUserById", "get_user_by_id", "HTTPServer", "größenÄnderung"]) {
      expect(tokenizeIdentifiers(text)).toEqual(domainTokens(text));
    }
    expect(tokenizeIdentifiers("get_user_by_id")).toContain("get_user_by_id");
    expect(informativeQueryTokens("user id")).toEqual(["user", "id"]);
  });
});

describe("identifierParts", () => {
  it("returns parts only, never the whole run", () => {
    expect(identifierParts("getUserById")).toEqual(["get", "user", "by", "id"]);
  });
});

describe("informativeQueryTokens", () => {
  it("removes German question framing but keeps subject terms", () => {
    expect(informativeQueryTokens("Wo wird die kognitive Komplexitaet berechnet?")).toEqual([
      "kognitive",
      "komplexitaet",
      "berechnet",
    ]);
  });

  it("removes added German and English interrogative grammar, including Unicode fuer", () => {
    expect(informativeQueryTokens("Warum und wofür ist die Policy relevant?")).toEqual([
      "policy",
      "relevant",
    ]);
    expect(informativeQueryTokens("Who decides when the policy runs?")).toEqual([
      "decides",
      "policy",
      "runs",
    ]);
  });

  it("removes English question framing without damaging identifiers", () => {
    expect(informativeQueryTokens("how is getUserById called")).toEqual([
      "getuserbyid",
      "get",
      "user",
      "id",
      "called",
    ]);
  });

  it("falls back to the original bag when every token is a stop word", () => {
    expect(informativeQueryTokens("is")).toEqual(["is"]);
  });
});

describe("isLikelyGermanQuestion", () => {
  it("recognizes German question framing", () => {
    expect(isLikelyGermanQuestion("Wo wird die kognitive Komplexitaet berechnet?")).toBe(true);
    expect(isLikelyGermanQuestion("Welche Entscheidungen sind unveraenderlich?")).toBe(true);
    expect(isLikelyGermanQuestion("Was ist die Kernthese des Projekts?")).toBe(true);
    expect(isLikelyGermanQuestion("In welcher Datei wird der Index geoeffnet?")).toBe(true);
    expect(isLikelyGermanQuestion("Was geschieht bei einem Fehler?")).toBe(true);
    expect(isLikelyGermanQuestion("Wann wird der Index erneuert?")).toBe(true);
    expect(isLikelyGermanQuestion("Wer berechnet die Metrik?")).toBe(true);
    expect(isLikelyGermanQuestion("Wofür wird der Cache benutzt?")).toBe(true);
    expect(isLikelyGermanQuestion("Wofuer wird der Cache benutzt?")).toBe(true);
  });

  it("does not mistake English 'was' or identifiers for German questions", () => {
    expect(isLikelyGermanQuestion("was the cache invalidated")).toBe(false);
    expect(isLikelyGermanQuestion("compareCodepoints")).toBe(false);
  });
});

describe("termFrequencies", () => {
  it("counts repetitions", () => {
    expect([...termFrequencies(["a", "b", "a"]).entries()]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });
});
