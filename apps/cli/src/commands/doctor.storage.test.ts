import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BufferIo } from "../cli/io.js";
import { run } from "../index.js";

import { inspectLanceDirectory } from "./doctor.storage.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "untangle-local-doctor-"));
  roots.push(root);
  return root;
};

const snapshot = (root: string) =>
  readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => lstatSync(path.join(root, name)).isFile())
    .map(
      (name) =>
        `${name}:${createHash("sha256")
          .update(readFileSync(path.join(root, name)))
          .digest("hex")}`,
    )
    .sort();

describe("read-only local storage diagnosis", () => {
  it("recognizes a real current offline index on LanceDB and checks its freshness without network requests or file changes", async () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "main.ts"),
      "export function lookupAccount(id: string): string | undefined { if (!id) return undefined; return id.trim(); }\n",
    );
    writeFileSync(
      path.join(root, "untangle.toml"),
      'schemaVersion = 1\nprojectId = "offline-test"\n[[repositories]]\nid = "offline-test"\npath = "."\n[storage]\nbackend = "lancedb"\n',
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request"));
    const indexIo = new BufferIo();
    expect(
      await run(["index", "--embedder=offline", "--format=json"], {
        cwd: root,
        env: {},
        io: indexIo,
        signal: new AbortController().signal,
      }),
      indexIo.errText,
    ).toBe(0);
    const before = snapshot(root);
    const io = new BufferIo();
    expect(
      await run(["doctor", "--skip-embeddings", "--format=json"], {
        cwd: root,
        env: {},
        io,
        signal: new AbortController().signal,
      }),
      io.errText,
    ).toBe(0);
    const report = JSON.parse(io.outText) as {
      checks: { id: string; status: string; facts?: Record<string, unknown> }[];
    };
    const index = report.checks.find((check) => check.id === "index");
    expect(index?.status).toBe("ok");
    expect(index?.facts?.["embedder"]).toBe("offline");
    expect(Number(index?.facts?.["points"])).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === "index-freshness")?.status).toBe("ok");
    expect(snapshot(root)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it.each([false, true])(
    "runs the actual doctor command with existing directory=%s without network requests or index writes",
    async (directoryExists) => {
      const root = fixture();
      writeFileSync(path.join(root, "main.ts"), "export const answer = 42;\n");
      writeFileSync(
        path.join(root, "untangle.toml"),
        'schemaVersion = 1\nprojectId = "local-test"\n[[repositories]]\nid = "local-test"\npath = "."\n[storage]\nbackend = "lancedb"\npath = ".untangle/index/lancedb"\n',
      );
      const directory = path.join(root, ".untangle/index/lancedb");
      if (directoryExists) mkdirSync(directory, { recursive: true });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request"));
      const io = new BufferIo();
      const code = await run(["doctor", "--skip-embeddings", "--format=json"], {
        cwd: root,
        env: {},
        io,
        signal: new AbortController().signal,
      });
      expect(code).toBe(4);
      const report = JSON.parse(io.outText) as { checks: { id: string; status: string }[] };
      expect(report.checks.find((check) => check.id === "lancedb")?.status).toBe("ok");
      expect(report.checks.find((check) => check.id === "index")?.status).toBe("fail");
      expect(report.checks.some((check) => check.id === "qdrant")).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(directory)).toBe(directoryExists);
      if (directoryExists) expect(readdirSync(directory)).toEqual([]);
      else expect(existsSync(path.join(root, ".untangle"))).toBe(false);
    },
  );

  it("reports a configured absent directory without creating parent paths", async () => {
    const root = fixture(),
      directory = path.join(root, ".untangle/index/lancedb");
    const result = await inspectLanceDirectory(directory, new AbortController().signal);
    expect(result).toMatchObject({
      exists: false,
      check: { id: "lancedb", status: "ok", facts: { directoryExists: false } },
    });
    expect(result.check.detail).toContain("Doctor created no files");
    expect(existsSync(path.join(root, ".untangle"))).toBe(false);
  });

  it("reports an existing directory without writing or changing its contents", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "evidence.txt"), "unchanged");
    const before = readdirSync(root);
    const result = await inspectLanceDirectory(root, new AbortController().signal);
    expect(result).toMatchObject({ exists: true, check: { status: "ok" } });
    expect(readdirSync(root)).toEqual(before);
    expect(readFileSync(path.join(root, "evidence.txt"), "utf8")).toBe("unchanged");
  });

  it("reports a file at the storage path as a failure and preserves its bytes", async () => {
    const root = fixture(),
      file = path.join(root, "foreign.txt");
    writeFileSync(file, "preserve foreign data");
    const result = await inspectLanceDirectory(file, new AbortController().signal);
    expect(result).toMatchObject({ exists: false, check: { status: "fail" } });
    expect(result.check.detail).toContain("not a directory");
    expect(readFileSync(file, "utf8")).toBe("preserve foreign data");
  });

  it("propagates cancellation instead of reporting a successful local check", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel doctor"));
    await expect(inspectLanceDirectory(fixture(), controller.signal)).rejects.toThrow(
      "cancel doctor",
    );
  });
});
