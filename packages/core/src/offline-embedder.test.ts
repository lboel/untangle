/**
 * Der netzlose Einbetter ist eine PRODUKTIONS-Neuschreibung des
 * deterministischen Einbetters aus `@untangle-code/testkit` (dieselbe
 * Entscheidung, die `@untangle-code/storage-qdrant` fuer die
 * BM25-Vektorisierung getroffen hat: Testinfrastruktur darf keine
 * Produktionsabhaengigkeit werden).
 *
 * Eine Neuschreibung ist nur dann harmlos, wenn sie nachweislich DASSELBE tut.
 * Genau das prueft diese Datei — Vektor fuer Vektor, ueber mehrere
 * Dimensionszahlen und ueber Texte, die die Randfaelle treffen: leer, nur
 * Trennzeichen, Unicode, Wiederholungen.
 */
import {
  DeterministicEmbedder,
  embedTextDeterministically,
  FakeClock,
} from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import {
  embedTextOffline,
  hashEmbeddingToken,
  l2Normalize,
  OFFLINE_EMBEDDING_PROFILE,
  OfflineEmbeddingProvider,
  tokenizeForEmbedding,
} from "./offline-embedder.js";

const TEXTS = [
  "",
  "   ",
  "---",
  "export function chunkFile(params: ChunkFileParams): ChunkFileResult",
  "Grosse Umlaute: AEOEUE und Kleine: aeoeue, plus 漢字 and emoji 🚀",
  "wiederholung wiederholung wiederholung wiederholung",
  "a",
  "search_document: repository=untangle ref=main path=src/index.ts",
];

describe("offline embedder is bit-identical to the testkit reference", () => {
  for (const dimensions of [8, 64, 256, 768]) {
    it(`matches for ${String(dimensions)} dimensions`, () => {
      for (const text of TEXTS) {
        expect(embedTextOffline(text, dimensions)).toEqual(
          embedTextDeterministically(text, dimensions),
        );
      }
    });
  }

  it("matches the reference provider through the port as well", async () => {
    const clock = new FakeClock(0);
    const profile = { ...OFFLINE_EMBEDDING_PROFILE, dimensions: 64 };
    const mine = new OfflineEmbeddingProvider(clock, profile);
    const reference = new DeterministicEmbedder(clock, profile);

    const mineResult = await mine.embedDocuments([...TEXTS]);
    const referenceResult = await reference.embedDocuments([...TEXTS]);
    expect(mineResult.vectors).toEqual(referenceResult.vectors);
    expect(mineResult.truncated).toEqual(referenceResult.truncated);
    expect(await mine.embedQuery("hallo welt")).toEqual(await reference.embedQuery("hallo welt"));
  });
});

describe("offline embedder building blocks", () => {
  it("tokenizes on runs of non-alphanumeric characters", () => {
    expect(tokenizeForEmbedding("Foo.bar__BAZ 42!")).toEqual(["foo", "bar", "baz", "42"]);
    expect(tokenizeForEmbedding("---")).toEqual([]);
  });

  it("hashes tokens into the non-negative 31-bit range, stably", () => {
    const first = hashEmbeddingToken("chunkFile");
    expect(first).toBe(hashEmbeddingToken("chunkFile"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(0x7fffffff);
  });

  it("returns an all-zero vector unchanged instead of NaN", () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
    expect(embedTextOffline("", 4)).toEqual([0, 0, 0, 0]);
  });

  it("produces a unit vector for any text with tokens", () => {
    const vector = embedTextOffline("alpha beta gamma", 32);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 12);
  });

  it("scores similar texts higher than unrelated ones", () => {
    const a = embedTextOffline("chunk the file losslessly", 256);
    const b = embedTextOffline("chunk the file losslessly and keep coverage", 256);
    const c = embedTextOffline("qdrant collection provisioning retries", 256);
    const dot = (x: number[], y: number[]): number =>
      x.reduce((sum, value, index) => sum + value * (y[index] ?? 0), 0);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });

  it("refuses a non-positive dimension count instead of returning something", () => {
    expect(() => embedTextOffline("x", 0)).toThrow(/positive integer/u);
    expect(
      () =>
        new OfflineEmbeddingProvider(new FakeClock(0), {
          ...OFFLINE_EMBEDDING_PROFILE,
          dimensions: -1,
        }),
    ).toThrow(/positive integer/u);
  });

  it("has a profile id that cannot collide with a real provider's", () => {
    const clock = new FakeClock(0);
    const offline = new OfflineEmbeddingProvider(clock);
    expect(offline.profile.provider).toBe("untangle-offline");
    expect(offline.profileId).toHaveLength(64);
  });
});
