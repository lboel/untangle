import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyzeProductAlignment, discoverSddArtifacts } from "@untangle-code/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../cli/args.js";
import type { CommandContext } from "../cli/command.js";
import { BufferIo } from "../cli/io.js";

import { runSddConnection, SDD_CONNECT_FLAGS, writeSddConnection } from "./sdd.js";

const owned: string[] = [];
async function fixture(prefix = "untangle-sdd-connect-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  owned.push(root);
  const files = {
    ".specify/memory/constitution.md": "# Engineering principles\nBehavior stays explicit.\n",
    "specs/001-accounts/spec.md":
      "# Accounts\n## Requirements\n- **FR-001**: Reject empty account identifiers.\n",
    "specs/001-accounts/tasks.md":
      "# Tasks\n- [x] T001 Create `src/accounts.ts`\n- [ ] T002 Check `tests/accounts.test.ts`\n",
    "src/accounts.ts":
      "export function account(id: string) { if (!id) return undefined; return id; }\n",
    "tests/accounts.test.ts": "export const notExecuted = true;\n",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}
function context(root: string): CommandContext & { io: BufferIo } {
  return { cwd: root, env: {}, signal: new AbortController().signal, io: new BufferIo() };
}
const FLAGS = {
  ...SDD_CONNECT_FLAGS,
  root: { kind: "string" as const, describe: "Project" },
  format: { kind: "string" as const, describe: "Format" },
};
afterEach(async () => {
  await Promise.all(owned.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SDD connection CLI and artifact writer", () => {
  it("preserves metacharacter paths as explicit argument-vector data rather than shell commands", async () => {
    const root = await fixture("untangle-sdd-$(echo injected)-`echo owned`-'quoted space-"),
      ctx = context(root);
    expect(await runSddConnection(ctx, parseArgs(["connect", "spec-kit"], FLAGS))).toBe(0);
    const lines = ctx.io.outText.split("\n");
    const parseVector = (prefix: string): string[] =>
      JSON.parse(lines.find((line) => line.startsWith(prefix))!.slice(prefix.length));
    const next = parseVector("Next argv (data, not a shell command): ");
    const map = parseVector("Map argv (data, not a shell command): ");
    expect(next.slice(0, 2)).toEqual(["untangle", "product"]);
    expect(map.slice(0, 3)).toEqual(["untangle", "graph", "features"]);
    expect(next[2]).toBe(map[3]);
    expect(next[2]).toContain("$(echo injected)-`echo owned`-'quoted space-");
    const manifestPath = next[3]!.slice("--manifest=".length);
    expect(map[4]).toBe(`--feature-map=${manifestPath}`);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).features).toHaveLength(1);
    expect(ctx.io.outText).not.toContain("Next: untangle");
    expect(ctx.io.outText).not.toContain("Map: untangle");
  });

  it("keeps a real dry-run read-only and returns proposed evidence as JSON", async () => {
    const root = await fixture(),
      ctx = context(root);
    expect(
      await runSddConnection(
        ctx,
        parseArgs(["connect", "spec-kit", "--dry-run", "--format=json"], FLAGS),
      ),
    ).toBe(0);
    const result = JSON.parse(ctx.io.outText);
    expect(result.report.frameworks).toEqual(["spec-kit"]);
    expect(result.report.draft.features[0]).toMatchObject({
      stage: "planned",
      review: "proposed",
      owners: [],
    });
    expect(result.manifestPath).toBeNull();
    expect(await readdir(root)).not.toContain(".untangle");
  });

  it("writes an idempotent source-bound manifest that the real product analyzer can consume from metadata", async () => {
    const root = await fixture(),
      report = await discoverSddArtifacts({ root });
    const first = await writeSddConnection(report);
    expect(first.manifestPath).toMatch(
      /\.untangle\/sdd\/auto-[a-f0-9]+\/untangle\.features\.json$/u,
    );
    const manifestBytes = await readFile(first.manifestPath!);
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(first.sha256!.manifest);
    const second = await writeSddConnection(await discoverSddArtifacts({ root }));
    expect(second).toEqual(first);
    expect(await readFile(second.manifestPath!)).toEqual(manifestBytes);
    const product = await analyzeProductAlignment({ root, manifestPath: first.manifestPath! });
    expect(product.manifest.status).toBe("loaded");
    expect(product.features).toHaveLength(1);
    expect(product.features[0]!.code.files.map((file) => file.path)).toEqual(["src/accounts.ts"]);
    expect(product.features[0]!.code.metrics!.cognitive.execution_unit).toBeGreaterThan(0);
    expect(product.features[0]!.testEvidence.status).toBe("not_run");
    expect(product.semanticConformance).toBe("not_independently_proven");
    expect(product.features[0]!.review).toBe("proposed");
  });

  it("rejects a changed preview before creating metadata", async () => {
    const root = await fixture(),
      report = await discoverSddArtifacts({ root });
    await writeFile(path.join(root, "src/accounts.ts"), "export const changed = true;\n");
    await expect(writeSddConnection(report)).rejects.toThrow("changed after the preview");
    expect(await readdir(root)).not.toContain(".untangle");
  });

  it("refuses metadata symlinks and preserves the outside directory", async () => {
    const root = await fixture(),
      outside = await mkdtemp(path.join(tmpdir(), "untangle-sdd-outside-"));
    owned.push(outside);
    const report = await discoverSddArtifacts({ root });
    await symlink(outside, path.join(root, ".untangle"));
    await expect(writeSddConnection(report)).rejects.toThrow("without symlinks");
    expect(await readdir(outside)).toEqual([]);
  });

  it("never overwrites conflicting artifacts", async () => {
    const root = await fixture(),
      report = await discoverSddArtifacts({ root });
    const artifact = await writeSddConnection(report);
    await writeFile(artifact.manifestPath!, "owned by another editor\n");
    await expect(writeSddConnection(report)).rejects.toThrow("no file was overwritten");
    expect(await readFile(artifact.manifestPath!, "utf8")).toBe("owned by another editor\n");
  });

  it("does not create metadata for absent frameworks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "untangle-sdd-empty-"));
    owned.push(root);
    const artifact = await writeSddConnection(await discoverSddArtifacts({ root }));
    expect(artifact.report.status).toBe("not_detected");
    expect(artifact.manifestPath).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["report", "manifest", "cancel"] as const)(
    "removes owned partial %s output and permits a clean retry",
    async (failure) => {
      const root = await fixture(),
        report = await discoverSddArtifacts({ root });
      const first = await writeSddConnection(report);
      await rm(first.reportPath!);
      await rm(first.manifestPath!);
      const probe = await open(path.join(root, ".handle-probe"), "w");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const original = prototype.writeFile;
      await probe.close();
      const controller = new AbortController();
      let injected = false;
      const spy = vi.spyOn(prototype, "writeFile").mockImplementation(async function (
        this: FileHandle,
        data,
        options,
      ) {
        const text = typeof data === "string" ? data : "";
        const isReport = text.includes('"kind": "sdd_connection"');
        if (!injected && text.startsWith("{") && (failure === "manifest" ? !isReport : isReport)) {
          injected = true;
          await this.write(Buffer.from(text).subarray(0, 57));
          if (failure === "cancel") controller.abort();
          throw new Error("Injected partial write failure");
        }
        return original.call(this, data, options);
      });
      try {
        await expect(writeSddConnection(report, { signal: controller.signal })).rejects.toThrow(
          "Injected partial write failure",
        );
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(await readdir(path.dirname(first.reportPath!))).toEqual([]);
      const retry = await writeSddConnection(report);
      expect(retry.reportPath).toBe(first.reportPath);
      expect(retry.manifestPath).toBe(first.manifestPath);
      expect(JSON.parse(await readFile(retry.reportPath!, "utf8")).sourceDigest).toBe(
        report.sourceDigest,
      );
    },
  );

  it("preserves a foreign replacement after an owned partial write fails", async () => {
    const root = await fixture(),
      report = await discoverSddArtifacts({ root });
    const first = await writeSddConnection(report);
    await rm(first.reportPath!);
    await rm(first.manifestPath!);
    const probe = await open(path.join(root, ".handle-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const original = prototype.writeFile;
    await probe.close();
    let injected = false;
    const spy = vi.spyOn(prototype, "writeFile").mockImplementation(async function (
      this: FileHandle,
      data,
      options,
    ) {
      const text = typeof data === "string" ? data : "";
      if (!injected && text.includes('"kind": "sdd_connection"')) {
        injected = true;
        await this.write(Buffer.from(text).subarray(0, 57));
        await rename(first.reportPath!, first.reportPath! + ".owned-partial");
        await writeFile(first.reportPath!, "replacement owned by another editor\n");
        throw new Error("Injected replacement during failure");
      }
      return original.call(this, data, options);
    });
    try {
      await expect(writeSddConnection(report)).rejects.toThrow(
        "Injected replacement during failure",
      );
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await readFile(first.reportPath!, "utf8")).toBe("replacement owned by another editor\n");
  });

  it("honors cancellation before writing anything", async () => {
    const root = await fixture(),
      report = await discoverSddArtifacts({ root });
    await expect(writeSddConnection(report, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(await readdir(root)).not.toContain(".untangle");
  });

  it("rejects unsupported framework names and unrelated flags before discovery", async () => {
    const root = await fixture(),
      discover = vi.fn();
    await expect(
      runSddConnection(
        context(root),
        { positionals: ["connect", "invented"], flags: {} },
        { discover },
      ),
    ).rejects.toThrow("auto|spec-kit|openspec");
    await expect(
      runSddConnection(
        context(root),
        { positionals: ["connect", "auto"], flags: { "run-tests": true } },
        { discover },
      ),
    ).rejects.toThrow("--run-tests");
    expect(discover).not.toHaveBeenCalled();
  });
});
