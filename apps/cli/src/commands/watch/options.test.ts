/**
 * Tests der Aufrufoptionen. Der wichtigste Fall ist der vorletzte: eine
 * unbekannte Option MUSS scheitern. Eine ignorierte Option ist die
 * lautloseste Art, etwas anderes zu messen als der Nutzer wollte.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseWatchArgs, type ParseWatchArgsEnv } from "./options.js";

const ENV: ParseWatchArgsEnv = { cwd: "/tmp/repo", isTty: true, noColorEnv: undefined };

function parse(argv: readonly string[], overrides: Partial<ParseWatchArgsEnv> = {}) {
  return parseWatchArgs(argv, { ...ENV, ...overrides });
}

describe("parseWatchArgs", () => {
  it("hat vollstaendige Vorgaben ohne jedes Argument", () => {
    const result = parse([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.root).toBe("/tmp/repo");
    expect(result.options.repoId).toBe("repo");
    expect(result.options.refId).toBe("repo:working-tree");
    expect(result.options.format).toBe("text");
    expect(result.options.outPath).toBeNull();
    expect(result.options.exitAfterChanges).toBeNull();
  });

  it("loest --root und --out gegen das Arbeitsverzeichnis auf", () => {
    const result = parse(["--root", "sub/tree", "--out", "log.jsonl"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.root).toBe(path.resolve("/tmp/repo", "sub/tree"));
    expect(result.options.outPath).toBe(path.resolve("/tmp/repo", "log.jsonl"));
  });

  it("faerbt im TTY", () => {
    const result = parse([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.color).toBe(true);
  });

  it("faerbt nie bei --no-color, ohne TTY, bei NO_COLOR oder bei --format json", () => {
    const cases: readonly [readonly string[], Partial<ParseWatchArgsEnv>][] = [
      [["--no-color"], {}],
      [[], { isTty: false }],
      [[], { noColorEnv: "1" }],
      [["--format", "json"], {}],
    ];
    for (const [argv, env] of cases) {
      const result = parse(argv, env);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.options.color).toBe(false);
    }
  });

  it("lehnt einen unbekannten Formatwert ab", () => {
    const result = parse(["--format", "yaml"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("--format");
  });

  it("lehnt nicht-positive Zahlen ab", () => {
    for (const flag of ["--debounce", "--reconcile", "--scopes", "--exit-after"]) {
      expect(parse([flag, "0"]).ok).toBe(false);
    }
  });

  it("ignoriert eine unbekannte Option NIE, sondern scheitert", () => {
    const result = parse(["--turbo"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("--turbo");
  });

  it("erkennt eine fehlende Wertangabe", () => {
    expect(parse(["--root", "--format", "json"]).ok).toBe(false);
  });
});
