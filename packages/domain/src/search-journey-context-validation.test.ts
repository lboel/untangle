import { describe, expect, it } from "vitest";

import { searchJourneyValidationIssue } from "./search-journey-validation.js";
import {
  MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH,
  SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS,
  type SearchJourneyExecutionContextV1,
  type SearchJourneyV1,
} from "./types/search-journey.js";

function context(): SearchJourneyExecutionContextV1 {
  const field = { fingerprint: "a".repeat(64) };
  return {
    schemaVersion: 1,
    source: "caller-declared",
    agentModel: { ...field },
    harness: { ...field },
    searchStrategy: { ...field },
    taskClass: { ...field },
  };
}

function session(): SearchJourneyV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId: "session-context",
    workspaceId: "workspace-context",
    status: "active",
    recordingConsent: "explicit",
    retainText: false,
    goal: { fingerprint: "b".repeat(64) },
    executionContext: context(),
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    attempts: [],
    navigation: [],
  };
}

describe("additive search-journey execution context validation", () => {
  it("keeps context-free legacy v1 sessions readable", () => {
    const legacy = session();
    delete legacy.executionContext;
    expect(searchJourneyValidationIssue(legacy)).toBeNull();
    expect(searchJourneyValidationIssue(session())).toBeNull();
  });

  it.each(SEARCH_JOURNEY_EXECUTION_CONTEXT_DIMENSIONS)(
    "requires consent for retained %s labels",
    (dimension) => {
      const value = session();
      const execution = value.executionContext;
      if (execution === undefined) throw new Error("expected context fixture");
      execution[dimension] = { fingerprint: "c".repeat(64), text: "caller label" };
      expect(searchJourneyValidationIssue(value)).toBe(
        "invalid execution context or text retention",
      );
      value.retainText = true;
      expect(searchJourneyValidationIssue(value)).toBeNull();
      execution[dimension] = { fingerprint: "c".repeat(64), text: " " };
      expect(searchJourneyValidationIssue(value)).not.toBeNull();
      execution[dimension] = { fingerprint: "c".repeat(64), text: " padded " };
      expect(searchJourneyValidationIssue(value)).not.toBeNull();
      execution[dimension] = {
        fingerprint: "c".repeat(64),
        text: "x".repeat(MAX_SEARCH_JOURNEY_EXECUTION_CONTEXT_LENGTH),
      };
      expect(searchJourneyValidationIssue(value)).toBeNull();
      execution[dimension].text += "x";
      expect(searchJourneyValidationIssue(value)).not.toBeNull();
    },
  );

  it.each([
    null,
    [],
    "model",
    {},
    { ...context(), schemaVersion: 2 },
    { ...context(), source: "inferred" },
    { ...context(), agentModel: undefined },
    { ...context(), harness: null },
    { ...context(), searchStrategy: "search" },
    { ...context(), taskClass: { fingerprint: "not-a-fingerprint" } },
    { ...context(), taskMix: { fingerprint: "A".repeat(64) } },
    { ...context(), priorContext: { fingerprint: "c".repeat(64), secret: "not allowed" } },
    { ...context(), freeText: "not allowed" },
  ])("rejects malformed or inferred context %#", (invalid) => {
    expect(searchJourneyValidationIssue({ ...session(), executionContext: invalid })).toBe(
      "invalid execution context or text retention",
    );
  });
});
