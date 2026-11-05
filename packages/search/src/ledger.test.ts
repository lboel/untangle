import { validateSkipLedger } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { SearchSkipLedger } from "./ledger.js";

describe("SearchSkipLedger", () => {
  it("stamps every entry with the search stage", () => {
    const ledger = new SearchSkipLedger();
    ledger.add({
      subjectKind: "search_candidate",
      subjectId: "c1",
      reason: "duplicate",
      detail: "merged into c2",
    });
    expect(ledger.toArray()[0]?.stage).toBe("search");
  });

  it("refuses an empty justification — E4's whole point", () => {
    const ledger = new SearchSkipLedger();
    expect(() =>
      ledger.add({ subjectKind: "chunk", subjectId: "c1", reason: "duplicate", detail: "   " }),
    ).toThrow(/non-empty detail/u);
  });

  it("defaults recoverable to false, so nothing looks retryable by accident", () => {
    const ledger = new SearchSkipLedger();
    ledger.addCandidate({ subjectId: "c1", reason: "duplicate", detail: "x" });
    expect(ledger.toArray()[0]?.recoverable).toBe(false);
  });

  it("counts by reason consistently with its entries", () => {
    const ledger = new SearchSkipLedger();
    ledger.addCandidate({ subjectId: "c1", reason: "duplicate", detail: "x" });
    ledger.addCandidate({ subjectId: "c2", reason: "duplicate", detail: "y" });
    ledger.addCandidate({ subjectId: "c3", reason: "missing_index_entry", detail: "z" });
    expect(ledger.countsByReason()).toEqual({ duplicate: 2, missing_index_entry: 1 });
    expect(
      validateSkipLedger({
        schemaVersion: 1,
        generationId: "g",
        entries: ledger.toArray(),
        countsByReason: ledger.countsByReason(),
      }),
    ).toEqual([]);
  });

  it("hands out a copy, so callers cannot rewrite the record", () => {
    const ledger = new SearchSkipLedger();
    ledger.addCandidate({ subjectId: "c1", reason: "duplicate", detail: "x" });
    ledger.toArray().pop();
    expect(ledger.size).toBe(1);
  });

  it("keeps optional provenance out of the entry when it is unknown", () => {
    const ledger = new SearchSkipLedger();
    ledger.addCandidate({ subjectId: "c1", reason: "duplicate", detail: "x" });
    expect("path" in (ledger.toArray()[0] ?? {})).toBe(false);
  });
});
