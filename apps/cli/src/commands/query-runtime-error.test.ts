import { describe, expect, it } from "vitest";

import { parseArgs } from "../cli/args.js";
import { EnvironmentError, EXIT, OperationalError } from "../cli/exit.js";

import { buildSearchRequest, queryCommand, toRuntimeError } from "./query.js";

const QDRANT_URL = "http://127.0.0.1:16333";
const cause = new Error("deadline expired");
const timeout = { timedOut: true, error: cause };

function timeoutFor(flags: string[], useOffline = false): EnvironmentError {
  const request = buildSearchRequest(
    parseArgs(["needle", ...flags], queryCommand.spec.flags),
    "workspace",
    "needle",
  );
  const error = toRuntimeError(timeout, QDRANT_URL, 20_000, request, useOffline);
  expect(error).toBeInstanceOf(EnvironmentError);
  const environmentError = error as EnvironmentError;
  expect(environmentError).toMatchObject({
    name: "EnvironmentError",
    exitCode: EXIT.environment,
    cause,
  });
  expect(environmentError.message).toContain("20000ms");
  expect(environmentError.message).toContain("no result is available");
  expect(environmentError.message).toContain(QDRANT_URL);
  expect(environmentError.nextStep).toContain("untangle doctor");
  return environmentError;
}

describe("query timeout diagnostics follow the executed search request", () => {
  it.each(["symbol", "lexical"])(
    "points %s timeouts at Qdrant without an embedding-service diagnosis",
    (mode) => {
      const error = timeoutFor([`--mode=${mode}`]);
      expect(error.message).toContain(`Mode "${mode}"`);
      expect(`${error.message} ${error.nextStep}`).not.toMatch(/Ollama|Query embedding/);
      expect(error.message).not.toContain("Graph enrichment");
    },
  );

  it.each(["symbol", "lexical"])(
    "includes Qdrant-backed graph work for %s context and links",
    (mode) => {
      const error = timeoutFor([`--mode=${mode}`, "--context", "--linked"]);
      expect(error.message).toContain("Graph enrichment (--context --linked) from Qdrant");
      expect(error.nextStep).toContain("without graph enrichment");
      expect(`${error.message} ${error.nextStep}`).not.toMatch(/Ollama|Query embedding/);
    },
  );

  it.each(["--context", "--linked"])("names only the graph flag actually requested: %s", (flag) => {
    const error = timeoutFor(["--mode=symbol", flag]);
    expect(error.message).toContain(`Graph enrichment (${flag})`);
    expect(error.message).not.toContain(flag === "--context" ? "--linked" : "--context");
  });

  it.each(["semantic", "hybrid"])(
    "includes possible embedding-service work for %s search",
    (mode) => {
      const error = timeoutFor([`--mode=${mode}`, "--context", "--linked"]);
      expect(error.message).toContain("Query embedding through Ollama");
      expect(error.message).toContain("Graph enrichment (--context --linked) from Qdrant");
      expect(error.nextStep).toContain("Qdrant and Ollama");
      expect(error.message).not.toContain("Ueblichste Ursache");
    },
  );

  it.each(["semantic", "hybrid"])(
    "distinguishes a local embedding from an Ollama dependency for %s search",
    (mode) => {
      const error = timeoutFor([`--mode=${mode}`], true);
      expect(error.message).toContain("local query embedding");
      expect(`${error.message} ${error.nextStep}`).not.toContain("Ollama");
    },
  );

  it("treats the default mode as hybrid", () => {
    expect(timeoutFor([]).message).toContain('Mode "hybrid"');
    expect(timeoutFor([]).message).toContain("Query embedding");
  });

  it("keeps grep line context separate from graph enrichment and query embedding", () => {
    const error = toRuntimeError(timeout, QDRANT_URL, 20_000, "grep", false) as EnvironmentError;
    expect(error).toMatchObject({ name: "EnvironmentError", exitCode: EXIT.environment, cause });
    expect(error.message).toContain('Mode "grep"');
    expect(error.message).toContain(QDRANT_URL);
    expect(`${error.message} ${error.nextStep}`).not.toMatch(
      /Ollama|Query embedding|Graph enrichment/,
    );
  });

  it.each([
    ["QDRANT_UNAVAILABLE", EnvironmentError, EXIT.environment],
    ["OLLAMA_EMBEDDING_FAILED", EnvironmentError, EXIT.environment],
    ["unexpected provider failure", OperationalError, EXIT.operational],
  ] as const)(
    "preserves non-timeout error classification for %s",
    (message, constructor, exitCode) => {
      const original = new Error(message);
      const error = toRuntimeError(
        { timedOut: false, error: original },
        QDRANT_URL,
        20_000,
        { mode: "symbol" },
        false,
      );
      expect(error).toBeInstanceOf(constructor);
      expect(error).toMatchObject({ exitCode, cause: original });
    },
  );
});
