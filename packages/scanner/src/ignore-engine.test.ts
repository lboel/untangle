import { describe, expect, it } from "vitest";

import { createIgnoreEngine } from "./ignore-engine.js";

describe("IgnoreEngine — priority order (spec.md §6.2)", () => {
  it("excludes default-excluded directories out of the box", () => {
    const engine = createIgnoreEngine();
    expect(engine.decide("node_modules", true)).toEqual({
      ignored: true,
      reason: "default-exclude",
    });
    expect(engine.decide("src/index.ts", false)).toEqual({ ignored: false });
  });

  it("lets a config include override a default exclude", () => {
    const engine = createIgnoreEngine({ configInclude: ["dist/keep.json"] });
    expect(engine.decide("dist", true).ignored).toBe(true);
    expect(engine.decide("dist/keep.json", false)).toEqual({ ignored: false });
  });

  it("lets .gitignore override a default exclude", () => {
    const engine = createIgnoreEngine();
    engine.pushGitignoreLayer("", "!dist/\n");
    expect(engine.decide("dist", true)).toEqual({ ignored: false });
  });

  it("lets .untangleignore override .gitignore", () => {
    const engine = createIgnoreEngine();
    engine.pushGitignoreLayer("", "*.log\n");
    engine.pushUntangleIgnoreLayer("", "!important.log\n");
    expect(engine.decide("debug.log", false)).toEqual({ ignored: true, reason: "gitignore" });
    expect(engine.decide("important.log", false)).toEqual({ ignored: false });
  });

  it("lets an explicit config exclude override .untangleignore", () => {
    const engine = createIgnoreEngine({ configExclude: ["secrets"] });
    engine.pushUntangleIgnoreLayer("", "!secrets/\n");
    expect(engine.decide("secrets", true)).toEqual({ ignored: true, reason: "config-exclude" });
  });

  it("never lets anything override a security/system exclude", () => {
    const engine = createIgnoreEngine({ configInclude: [".git"] });
    engine.pushUntangleIgnoreLayer("", "!.git/\n");
    expect(engine.decide(".git", true)).toEqual({ ignored: true, reason: "security" });
  });

  it("a config include does NOT override .gitignore or .untangleignore (only defaults)", () => {
    const engine = createIgnoreEngine({ configInclude: ["debug.log"] });
    engine.pushGitignoreLayer("", "*.log\n");
    expect(engine.decide("debug.log", false)).toEqual({ ignored: true, reason: "gitignore" });
  });

  it("supports negation inside a single .gitignore layer", () => {
    const engine = createIgnoreEngine();
    engine.pushGitignoreLayer("", ["*.log", "!important.log"].join("\n"));
    expect(engine.decide("debug.log", false).ignored).toBe(true);
    expect(engine.decide("important.log", false).ignored).toBe(false);
  });

  it("scopes nested gitignore layers to their own directory and pops them on the way back up", () => {
    const engine = createIgnoreEngine();
    engine.pushGitignoreLayer("", "*.log\n");
    engine.pushGitignoreLayer("packages/app", "!debug.log\n");
    expect(engine.decide("packages/app/debug.log", false)).toEqual({ ignored: false });
    expect(engine.decide("packages/other/debug.log", false)).toEqual({
      ignored: true,
      reason: "gitignore",
    });

    engine.popGitignoreLayer();
    // Back to only the root layer: even under packages/app, debug.log is excluded again.
    expect(engine.decide("packages/app/debug.log", false)).toEqual({
      ignored: true,
      reason: "gitignore",
    });
  });

  it("does not exclude an unrelated file that matches nothing", () => {
    const engine = createIgnoreEngine();
    expect(engine.decide("src/index.ts", false)).toEqual({ ignored: false });
  });
});
