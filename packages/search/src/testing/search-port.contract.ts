/**
 * Port-Kontraktsuite fuer {@link SearchPort} — dieselbe Bauart wie
 * `runVectorStoreContract` im testkit.
 *
 * Die Suite ist ausschliesslich gegen die oeffentliche Port-Signatur
 * geschrieben. Sie laeuft deshalb unveraendert gegen die In-Memory-Referenz
 * (Selbsttest, `search-port.contract.self-test.test.ts`) und spaeter gegen
 * eine Verdrahtung mit echtem Qdrant — dort ruft das jeweilige Paket
 * `runSearchPortContract(...)` aus seiner eigenen Testdatei auf.
 *
 * BEWUSST NICHT IM UMFANG (benannt, nicht verschwiegen):
 * - absolute Score-WERTE. Sie haengen am Embedder und an der Korpusgroesse;
 *   die Suite prueft Ordnung, Zerlegung und Invarianten, nicht Zahlen.
 * - mehrere Embedding-Profile in einem Lauf: die Gruppenbildung ist in
 *   `engine.test.ts` direkt geprueft, weil eine allgemeine Faktoryform dafuer
 *   zwei Profile vorschreiben muesste, die eine echte Verdrahtung womoeglich
 *   gar nicht hat.
 */
import { validateScoreBreakdown, validateSkipLedger } from "@untangle-code/domain";
import { beforeAll, describe, expect, it } from "vitest";

import type { SearchPort } from "../port.js";
import type { RelevancePolicyV1 } from "../relevance.js";

import type { ChunkFixture } from "./in-memory-index.js";
import { TEST_COLLECTION, TEST_WORKSPACE_ID } from "./in-memory-index.js";

/** Optionale Verdrahtung fuer die Abstinenz-Faelle der Suite. */
export interface SearchPortFactoryOptions {
  /**
   * Eine an die Fixtures gebundene Relevanzpolicy. Die Suite baut sie selbst,
   * weil die produktive Kalibrierung hier NICHT taugt: ihr
   * `denseReferenceRank: 50` ist ueber fuenf Fixtures nie beobachtbar, die
   * Entscheidung faellt also auf `not_evaluated` zurueck und die Suite pruefte
   * nichts.
   */
  relevance?: { policy: RelevancePolicyV1; workspaceId: string; collection: string };
}

/** Baut einen einsatzbereiten Port ueber den uebergebenen Fixtures. */
export type SearchPortFactory = (
  fixtures: readonly ChunkFixture[],
  options?: SearchPortFactoryOptions,
) => SearchPort | Promise<SearchPort>;

/**
 * Eine Policy, die alles ablehnt, und eine, die alles annimmt.
 *
 * Absolute Score-Werte bleiben ausserhalb des Umfangs (siehe Modulkopf); diese
 * beiden erzwingen ihr Urteil deshalb ueber unerreichbare bzw. triviale
 * Schwellen statt ueber eine Zahl, die am Embedder haengt.
 */
export const CONTRACT_ALWAYS_REJECT: RelevancePolicyV1 = {
  calibrationId: "contract/always-reject",
  minimumDenseScore: 1,
  minimumDenseSpread: 2,
  denseReferenceRank: 2,
  minimumCandidateIdfCoverage: 1,
};

export const CONTRACT_ALWAYS_ACCEPT: RelevancePolicyV1 = {
  calibrationId: "contract/always-accept",
  minimumDenseScore: 0,
  minimumDenseSpread: 0,
  denseReferenceRank: 2,
  minimumCandidateIdfCoverage: 0,
};

/** Lexikalisch fremd zum Korpus — erzwingt den Nicht-Symbol-Pfad der Policy. */
export const CONTRACT_ALIEN_QUERY = "blockchain transaction signature verification";

/** Die Fixtures, gegen die die Suite prueft. */
export const CONTRACT_FIXTURES: ChunkFixture[] = [
  {
    chunkId: "c-charge",
    filePath: "src/payment/payment-service.ts",
    symbolId: "sym-charge",
    symbolName: "charge",
    symbolFqn: "PaymentService.charge",
    symbolKind: "method",
    signature: "charge(amount: number, currency: string): Promise<Receipt>",
    cognitive: 18,
    content:
      "async charge(amount: number, currency: string) {\n  return this.gateway.send(amount, currency);\n}",
  },
  {
    chunkId: "c-charge-fragment",
    filePath: "src/payment/payment-service.ts",
    symbolId: "sym-charge",
    symbolName: "charge",
    symbolFqn: "PaymentService.charge",
    symbolKind: "method",
    chunkKind: "symbol_fragment",
    fragmentIndex: 1,
    fragmentCount: 2,
    startLine: 40,
    signature: "charge(amount: number, currency: string): Promise<Receipt>",
    content:
      "  // retry once on a transient gateway failure\n  await this.retry(() => this.gateway.send(amount, currency));",
  },
  {
    chunkId: "c-refund",
    filePath: "src/payment/refund-service.ts",
    symbolId: "sym-refund",
    symbolName: "refund",
    symbolFqn: "RefundService.refund",
    symbolKind: "method",
    cognitive: 4,
    content: "async refund(receiptId: string) {\n  return this.gateway.refund(receiptId);\n}",
  },
  {
    chunkId: "c-token",
    filePath: "src/auth/token-rotation.ts",
    symbolId: "sym-rotate",
    symbolName: "rotateToken",
    symbolFqn: "TokenService.rotateToken",
    symbolKind: "function",
    cognitive: 27,
    content:
      "export function rotateToken(token: Token) {\n  // token rotation happens here\n  return sign(refresh(token));\n}",
  },
  {
    chunkId: "c-readme",
    filePath: "docs/payments.md",
    language: "markdown",
    chunkKind: "module",
    content: "# Payments\n\nThe payment service charges a card and issues a receipt.",
  },
];

/**
 * Fuehrt den Kontrakt gegen die von `factory` gebaute Implementierung aus.
 * Einmal je Implementierung im Modulrumpf einer `*.test.ts` aufrufen.
 */
export function runSearchPortContract(factory: SearchPortFactory): void {
  describe("SearchPort contract", () => {
    let port: SearchPort;

    beforeAll(async () => {
      port = await factory(CONTRACT_FIXTURES);
    });

    describe("hybrid search", () => {
      it("puts the exactly-named symbol first", async () => {
        const result = await port.search({ query: "charge", limit: 5 });
        const hits = result.groups.flatMap((group) => group.hits);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]?.symbolName).toBe("charge");
      });

      it("assigns dense 1-based ranks inside a group", async () => {
        const result = await port.search({ query: "payment", limit: 5 });
        for (const group of result.groups) {
          expect(group.hits.map((hit) => hit.rank)).toEqual(
            group.hits.map((_hit, index) => index + 1),
          );
        }
      });

      it("every hit carries a valid score breakdown with exactly one base_hybrid", async () => {
        const result = await port.search({ query: "charge a card", limit: 10 });
        const hits = result.groups.flatMap((group) => group.hits);
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) {
          const validation = validateScoreBreakdown(hit.score, 1e-9);
          expect(validation.issues).toEqual([]);
          expect(validation.valid).toBe(true);
          expect(
            hit.score.components.filter((component) => component.kind === "base_hybrid"),
          ).toHaveLength(1);
          // spec.md §13.3: Boosts duerfen die Basis nicht vollstaendig ueberstimmen.
          expect(validation.baseShare).toBeGreaterThanOrEqual(0.6);
        }
      });

      it("respects the limit", async () => {
        const result = await port.search({ query: "service", limit: 2 });
        for (const group of result.groups) {
          expect(group.hits.length).toBeLessThanOrEqual(2);
        }
      });

      it("is deterministic: the same request yields byte-identical results", async () => {
        const first = await port.search({ query: "gateway retry", limit: 5 });
        const second = await port.search({ query: "gateway retry", limit: 5 });
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      });

      it("carries the query fingerprint and the normalized query", async () => {
        const result = await port.search({ query: "  charge  ", limit: 3 });
        expect(result.query.text).toBe("charge");
        expect(result.queryFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      });
    });

    describe("filters", () => {
      it("filters by language", async () => {
        const result = await port.search({ query: "payment", languages: ["markdown"], limit: 10 });
        const hits = result.groups.flatMap((group) => group.hits);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((hit) => hit.language === "markdown")).toBe(true);
      });

      it("filters by path glob and records what it dropped", async () => {
        const result = await port.search({
          query: "service",
          pathGlob: ["src/payment/**"],
          limit: 10,
        });
        const hits = result.groups.flatMap((group) => group.hits);
        expect(hits.every((hit) => hit.filePath.startsWith("src/payment/"))).toBe(true);
        expect(result.skipped.length).toBeGreaterThan(0);
      });

      it("filters by a complexity range — the differentiating feature", async () => {
        const result = await port.search({
          query: "service",
          complexity: { cognitiveMin: 20 },
          limit: 10,
        });
        const hits = result.groups.flatMap((group) => group.hits);
        for (const hit of hits) {
          expect(hit.complexity?.cognitive ?? 0).toBeGreaterThanOrEqual(20);
        }
      });
    });

    describe("dedupe and provenance", () => {
      it("collapses fragments of one symbol into related fragments", async () => {
        const result = await port.search({ query: "charge", limit: 10 });
        const hits = result.groups.flatMap((group) => group.hits);
        const chargeHits = hits.filter((hit) => hit.symbolId === "sym-charge");
        expect(chargeHits).toHaveLength(1);
        expect(chargeHits[0]?.relatedFragments.length).toBeGreaterThan(0);
      });

      it("every hit names repo, ref and file", async () => {
        const result = await port.search({ query: "charge", limit: 10 });
        for (const hit of result.groups.flatMap((group) => group.hits)) {
          expect(hit.repoId).not.toBe("");
          expect(hit.refId).not.toBe("");
          expect(hit.filePath).not.toBe("");
          expect(hit.dedupeKey).not.toBe("");
        }
      });
    });

    describe("skip ledger (BUILD_PLAN E4)", () => {
      it("every skipped entry carries a non-empty reason and a subject", async () => {
        const result = await port.search({
          query: "service",
          pathGlob: ["src/payment/**"],
          limit: 1,
        });
        expect(
          validateSkipLedger({
            schemaVersion: 1,
            generationId: "test",
            entries: result.skipped,
            countsByReason: result.skipped.reduce<Record<string, number>>((counts, entry) => {
              counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
              return counts;
            }, {}),
          }),
        ).toEqual([]);
        for (const entry of result.skipped) {
          expect(entry.detail.trim()).not.toBe("");
          expect(entry.stage).toBe("search");
        }
      });
    });

    describe("grep mode", () => {
      it("finds a literal string with its real file line number", async () => {
        const result = await port.grep({ pattern: "gateway.refund" });
        expect(result.totalMatches).toBeGreaterThan(0);
        const match = result.matches[0];
        expect(match?.filePath).toBe("src/payment/refund-service.ts");
        expect(match?.line).toBe(2);
        expect(match?.column).toBeGreaterThan(0);
      });

      it("supports regular expressions", async () => {
        const result = await port.grep({ pattern: "async\\s+\\w+\\(", regex: true });
        expect(result.totalMatches).toBeGreaterThanOrEqual(2);
      });

      it("treats a literal pattern literally", async () => {
        const literal = await port.grep({ pattern: "gateway.send" });
        const asRegex = await port.grep({ pattern: "gateway.send", regex: true });
        expect(literal.totalMatches).toBeLessThanOrEqual(asRegex.totalMatches);
      });

      it("returns context lines", async () => {
        const result = await port.grep({
          pattern: "retry",
          contextLinesBefore: 1,
          contextLinesAfter: 1,
        });
        expect(result.totalMatches).toBeGreaterThan(0);
        expect(result.matches.some((match) => match.before.length + match.after.length > 0)).toBe(
          true,
        );
      });

      it("honours path exclusion", async () => {
        const result = await port.grep({ pattern: "payment", pathExclude: ["docs/**"] });
        expect(result.matches.every((match) => !match.filePath.startsWith("docs/"))).toBe(true);
      });

      it("names its truncation reason instead of silently cutting", async () => {
        const result = await port.grep({ pattern: "e", maxMatches: 1 });
        expect(result.matches).toHaveLength(1);
        expect(result.truncated).toBe(true);
        expect(result.truncationReason).toBe("max_matches");
        expect(result.skipped.length).toBeGreaterThan(0);
      });

      it("reports how much it actually scanned", async () => {
        const result = await port.grep({ pattern: "zzz-not-present-zzz" });
        expect(result.totalMatches).toBe(0);
        expect(result.scannedChunks).toBeGreaterThan(0);
      });

      it("rejects an invalid regular expression instead of returning nothing", async () => {
        await expect(port.grep({ pattern: "([a-z", regex: true })).rejects.toThrow(
          /not a valid regular expression/u,
        );
      });
    });

    /**
     * Abstinenz — der Teil, den jede Verdrahtung gleich beantworten muss.
     *
     * Bis Welle 14 sagte diese Suite darueber nichts, obwohl das Verhalten
     * ueber die Port-Signatur laeuft. Eine Verdrahtung konnte die Enthaltung
     * also beliebig anders auslegen, ohne dass es auffiel.
     *
     * Geprueft wird die INVARIANTE, nicht die Zahl: das Verdikt ist in beiden
     * Verhalten dasselbe, und nur die Trefferliste unterscheidet sich.
     */
    describe("relevance abstention", () => {
      it("verwirft unter strict und nennt den Grund", async () => {
        const guarded = await factory(CONTRACT_FIXTURES, {
          relevance: {
            policy: CONTRACT_ALWAYS_REJECT,
            workspaceId: TEST_WORKSPACE_ID,
            collection: TEST_COLLECTION,
          },
        });
        const result = await guarded.search({ query: CONTRACT_ALIEN_QUERY, limit: 5 });
        expect(result.totalHits).toBe(0);
        expect(result.groups[0]?.relevanceDecision).toMatchObject({
          abstention: "strict",
          status: "rejected",
          calibrationId: "contract/always-reject",
        });
        expect(result.skipped.some((entry) => entry.reason === "relevance_policy_rejected")).toBe(
          true,
        );
      });

      it("behaelt unter evidence die Treffer UND dasselbe Verdikt", async () => {
        const guarded = await factory(CONTRACT_FIXTURES, {
          relevance: {
            policy: CONTRACT_ALWAYS_REJECT,
            workspaceId: TEST_WORKSPACE_ID,
            collection: TEST_COLLECTION,
          },
        });
        const result = await guarded.search({
          query: CONTRACT_ALIEN_QUERY,
          limit: 5,
          abstention: "evidence",
        });
        expect(result.totalHits).toBeGreaterThan(0);
        expect(result.groups[0]?.relevanceDecision).toMatchObject({
          abstention: "evidence",
          status: "rejected",
          calibrationId: "contract/always-reject",
        });
        // Kein Ledger-Eintrag ueber einen Gegenstand, der im Ergebnis steht.
        expect(result.skipped.some((entry) => entry.reason === "relevance_policy_rejected")).toBe(
          false,
        );
      });

      it("traegt das Verdikt auch bei einer Annahme", async () => {
        const guarded = await factory(CONTRACT_FIXTURES, {
          relevance: {
            policy: CONTRACT_ALWAYS_ACCEPT,
            workspaceId: TEST_WORKSPACE_ID,
            collection: TEST_COLLECTION,
          },
        });
        const result = await guarded.search({ query: "charge", limit: 5 });
        expect(result.groups[0]?.relevanceDecision?.status).toBe("accepted");
      });

      it("laesst das Verdikt weg, wenn keine Policy gebunden ist", async () => {
        // Abwesenheit heisst „keine Policy gebunden", nicht „akzeptiert".
        const result = await port.search({ query: "charge", limit: 5 });
        expect(result.groups[0]?.relevanceDecision).toBeUndefined();
      });
    });
  });
}
