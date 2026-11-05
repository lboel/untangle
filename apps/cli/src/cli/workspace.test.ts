import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveTarget } from "../commands/index/target.js";
import { DefaultUntangleMcpRuntime } from "../mcp/default-runtime.js";

import { stateRootOf } from "./index-state.js";
import { loadWorkspace } from "./workspace.js";

describe("folder-contained workspace configuration", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-folder-workspace-")));
    mkdirSync(path.join(root, ".git"));
    mkdirSync(path.join(root, ".untangle"));
    writeFileSync(
      path.join(root, ".untangle", "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: "folder-workspace",
        repositories: [{ id: "toolkin", path: ".." }],
      }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([".", "packages/app/src", ".untangle"])(
    "keeps the project as the workspace and index root when invoked from %s",
    (start) => {
      const cwd = path.join(root, start);
      mkdirSync(cwd, { recursive: true });
      const view = loadWorkspace({ cwd, env: {}, strict: true });
      expect(view.root).toBe(root);
      expect(view.load.sources.configBaseDir).toBe(path.join(root, ".untangle"));
      expect(view.workspaceId).toBe("folder-workspace");
      expect(view.config.repositories).toEqual([{ id: "toolkin", path: root }]);
      const target = resolveTarget({
        config: view.config,
        cwd,
        rootFlag: undefined,
        repoFlag: undefined,
        refFlag: undefined,
        configBaseDir: view.load.sources.configBaseDir,
      });
      expect(target.rootPath).toBe(root);
      expect(stateRootOf(view.root)).toBe(path.join(root, ".untangle"));
      expect(stateRootOf(target.rootPath)).toBe(path.join(root, ".untangle"));
    },
  );

  it("persists a default-root MCP session directly in project metadata", async () => {
    const context = { cwd: root, env: {}, signal: new AbortController().signal };
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_search_session",
      { action: "start", goal: "Inspect the deadline feature" },
      context,
    );
    expect(result).toMatchObject({ ok: true, data: { action: "start" } });
    const session = (result.data as { session?: { sessionId: string } } | undefined)?.session;
    expect(session?.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(
      existsSync(
        path.join(
          root,
          ".untangle",
          "product-complexity",
          "sessions",
          `${String(session?.sessionId)}.json`,
        ),
      ),
    ).toBe(true);
    expect(existsSync(path.join(root, ".untangle", ".untangle"))).toBe(false);
  });

  it.each([".untangle.json", "untangle.toml"])(
    "keeps the existing workspace root when %s takes precedence",
    (legacy) => {
      writeFileSync(
        path.join(root, legacy),
        legacy.endsWith(".json")
          ? JSON.stringify({ schemaVersion: 1, workspaceId: "legacy-workspace" })
          : 'schemaVersion = 1\nworkspaceId = "legacy-workspace"\n',
      );
      const view = loadWorkspace({ cwd: root, env: {}, strict: true });
      expect(view.workspaceId).toBe("legacy-workspace");
      expect(view.root).toBe(root);
      expect(view.load.sources.configBaseDir).toBe(root);
    },
  );

  it("preserves a nested legacy configuration directory as its workspace root", () => {
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(nested, ".untangle.json"),
      JSON.stringify({ schemaVersion: 1, workspaceId: "nested-workspace" }),
    );
    const view = loadWorkspace({ cwd: nested, env: {}, strict: true });
    expect(view.workspaceId).toBe("nested-workspace");
    expect(view.root).toBe(nested);
    expect(view.load.sources.configBaseDir).toBe(nested);
  });
});
