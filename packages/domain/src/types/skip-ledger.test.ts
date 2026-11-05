import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical-json.js";

import type { SkipLedgerV1 } from "./skip-ledger.js";
import {
  buildSkipLedgerEntry,
  summarizeSkipReasons,
  validateSkipLedger,
  SKIP_REASONS,
} from "./skip-ledger.js";

describe("buildSkipLedgerEntry", () => {
  it("creates an entry and survives canonical JSON", () => {
    const entry = buildSkipLedgerEntry({
      stage: "parse",
      subjectKind: "file",
      subjectId: "file-7",
      path: "vendor/bundle.min.js",
      reason: "file_too_large",
      detail: "file exceeds the configured size limit of 2 MiB",
      recoverable: false,
    });
    expect(entry.schemaVersion).toBe(1);
    expect(JSON.parse(canonicalJson(entry))).toEqual(entry);
  });

  it("refuses an entry without a reason text (E4)", () => {
    expect(() =>
      buildSkipLedgerEntry({
        stage: "parse",
        subjectKind: "file",
        subjectId: "file-7",
        reason: "parse_failed",
        detail: "   ",
        recoverable: true,
      }),
    ).toThrowError(/non-empty detail/);
  });
});

describe("validateSkipLedger", () => {
  const entry = buildSkipLedgerEntry({
    stage: "file_graph",
    subjectKind: "file_edge",
    subjectId: "edge-1",
    reason: "resolution_failed",
    detail: "no resolver supports the specifier",
    recoverable: false,
  });

  it("accepts a ledger whose counters match its entries", () => {
    const ledger: SkipLedgerV1 = {
      schemaVersion: 1,
      generationId: "gen-1",
      entries: [entry],
      countsByReason: { resolution_failed: 1 },
    };
    expect(validateSkipLedger(ledger)).toEqual([]);
  });

  it("detects counters that disagree with the entries", () => {
    const ledger: SkipLedgerV1 = {
      schemaVersion: 1,
      generationId: "gen-1",
      entries: [entry],
      countsByReason: { resolution_failed: 4 },
    };
    expect(validateSkipLedger(ledger).map((issue) => issue.kind)).toContain("count_mismatch");
  });

  it("detects entries without a subject or without a reason text", () => {
    const ledger: SkipLedgerV1 = {
      schemaVersion: 1,
      generationId: "gen-1",
      entries: [
        {
          schemaVersion: 1,
          stage: "search",
          subjectKind: "search_candidate",
          reason: "duplicate",
          detail: "",
          recoverable: false,
        },
      ],
      countsByReason: { duplicate: 1 },
    };
    const kinds = validateSkipLedger(ledger).map((issue) => issue.kind);
    expect(kinds).toContain("empty_detail");
    expect(kinds).toContain("missing_subject");
  });

  it("summarizes reasons independently of the entry order", () => {
    const second = buildSkipLedgerEntry({
      stage: "search",
      subjectKind: "search_candidate",
      subjectId: "chunk-1",
      reason: "duplicate",
      detail: "same metrics scope as a higher ranked fragment",
      recoverable: false,
    });
    expect(summarizeSkipReasons([entry, second])).toEqual(summarizeSkipReasons([second, entry]));
    expect(summarizeSkipReasons([entry, second, second])).toEqual({
      resolution_failed: 1,
      duplicate: 2,
    });
  });
});

describe("relevance_policy_rejected (E4)", () => {
  it("fuehrt die Policy-Ablehnung als eigenen Grund", () => {
    // `excluded_by_configuration` waere hier das falsche Etikett: es wurde
    // nichts wegkonfiguriert. Das Korpus wurde gemessen, und die kalibrierte
    // Policy hielt die Evidenz fuer unzureichend. Ein falscher Grund ist ein
    // stiller Datenverlust mit Etikett — E4 verbietet beides.
    expect(SKIP_REASONS).toContain("relevance_policy_rejected");
  });

  it("zaehlt ihn getrennt von den elf anderen Ausschlussgruenden", () => {
    const entries = [
      buildSkipLedgerEntry({
        stage: "search",
        subjectKind: "search_candidate",
        subjectId: "a",
        repoId: "repo-1",
        refId: "ref-1",
        reason: "relevance_policy_rejected",
        detail: "the calibrated relevance policy judged the evidence insufficient",
        recoverable: false,
      }),
      buildSkipLedgerEntry({
        stage: "search",
        subjectKind: "search_candidate",
        subjectId: "b",
        repoId: "repo-1",
        refId: "ref-1",
        reason: "relevance_policy_rejected",
        detail: "the calibrated relevance policy judged the evidence insufficient",
        recoverable: false,
      }),
      buildSkipLedgerEntry({
        stage: "search",
        subjectKind: "search_candidate",
        subjectId: "c",
        repoId: "repo-1",
        refId: "ref-1",
        reason: "excluded_by_configuration",
        detail: "below the configured minimum score",
        recoverable: false,
      }),
    ];
    expect(summarizeSkipReasons(entries)).toMatchObject({
      relevance_policy_rejected: 2,
      excluded_by_configuration: 1,
    });
  });
});
