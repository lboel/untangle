import { UntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { EnvironmentError, EXIT } from "../cli/exit.js";

import { toRuntimeError } from "./query.js";

const local = "file:///project/.untangle/index/lancedb";

describe("LanceDB query diagnostics", () => {
  it("identifies local storage and graph work on timeout", () => {
    const cause = new Error("deadline expired");
    const result = toRuntimeError(
      { timedOut: true, error: cause },
      local,
      100,
      { mode: "symbol", includeContext: true, includeLinked: true },
      true,
    ) as EnvironmentError;
    expect(result).toBeInstanceOf(EnvironmentError);
    expect(result.exitCode).toBe(EXIT.environment);
    expect(result.message).toContain("Graph enrichment (--context --linked) from LanceDB");
    expect(result.nextStep).toContain("check LanceDB");
    expect(`${result.message} ${result.nextStep}`).not.toMatch(/Qdrant|Ollama/);
  });

  it.each(["LANCEDB_UNAVAILABLE", "LANCEDB_SCHEMA_INCOMPATIBLE"] as const)(
    "classifies typed %s without relying on message text",
    (code) => {
      const cause = new UntangleError(code, "Cannot read local tables.");
      const result = toRuntimeError(
        { timedOut: false, error: cause },
        local,
        100,
        { mode: "lexical" },
        true,
      ) as EnvironmentError;
      expect(result).toBeInstanceOf(EnvironmentError);
      expect(result.exitCode).toBe(EXIT.environment);
      expect(result.cause).toBe(cause);
      expect(result.nextStep).toContain("check LanceDB");
    },
  );
});
