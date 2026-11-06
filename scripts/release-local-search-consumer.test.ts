import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const local = (await import(
  pathToFileURL(path.resolve("scripts/release-local-search-consumer.mjs")).href
)) as {
  createLocalSearchFixture(root: string): { root: string; guardPath: string; guardSha256: string };
  localSearchCommandArgs(root: string): Record<string, string[]>;
};
const owned: string[] = [];
afterEach(() => {
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "untangle-local-consumer-test-"));
  owned.push(directory);
  return local.createLocalSearchFixture(directory);
}

describe("installed local-search acceptance guard", () => {
  it("starts from a real new repository without declaring a storage backend or Qdrant", () => {
    const prepared = fixture();
    const config = JSON.parse(
      readFileSync(path.join(prepared.root, ".untangle/config.json"), "utf8"),
    );
    expect(config.storage).toBeUndefined();
    expect(config.qdrant).toBeUndefined();
    expect(config.repositories[0].path).toBe("..");
    expect(readFileSync(path.join(prepared.root, "src/main.ts"), "utf8")).toContain(
      'from "./users"',
    );
  });

  it.each([
    ["fetch", "await fetch('http://127.0.0.1:1')", "must not use HTTP"],
    ["HTTP", "(await import('node:http')).get('http://127.0.0.1:1')", "must not use HTTP"],
    ["HTTPS", "(await import('node:https')).request('https://127.0.0.1:1')", "must not use HTTP"],
    [
      "Docker",
      "(await import('node:child_process')).execFileSync('docker', ['--version'])",
      "must not start external services",
    ],
    [
      "Ollama",
      "(await import('node:child_process')).spawnSync('ollama', ['--version'])",
      "must not start external services",
    ],
  ])("rejects %s inside the actual preloaded consumer guard", (_name, expression, message) => {
    const prepared = fixture();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(prepared.guardPath).href,
        "--input-type=module",
        "-e",
        expression!,
      ],
      {
        cwd: prepared.root,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain(message);
  });

  it("requires fresh independent searches and an actual second CLI invocation", () => {
    const commands = local.localSearchCommandArgs("/fixture");
    expect(commands["symbol"]).toEqual([
      "query",
      "getUserById",
      "--root=/fixture",
      "--embedder=offline",
      "--mode=symbol",
      "--require-fresh",
      "--format=json",
    ]);
    expect(commands["lexical"]).toContain("--mode=lexical");
    expect(commands["lexical"]).toContain("user id");
    expect(commands["reopened"]).toEqual(commands["symbol"]);
    expect(commands["graph"]).toEqual(["graph", "--root=/fixture", "--format=json"]);
  });
});
