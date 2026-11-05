import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SourceRange } from "@untangle-code/domain";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../cli/args.js";
import { BufferIo } from "../cli/io.js";

import { analyze, complexityCommand } from "./complexity.js";

const directories: string[] = [];
const SCRIPT = [
  "export function feature(enabled: boolean): boolean {",
  "  if (enabled) return helper(enabled);",
  "  return false;",
  "}",
  "function helper(value: boolean): boolean {",
  "  if (value) return true;",
  "  return false;",
  "}",
].join("\n");
const TEMPLATE = '<button v-if="ready" @click="feature">Grüße 🌿 TemplateOnlyMarker</button>';
const STYLE = ".ready { color: green; }";
const SFC = `<template>${TEMPLATE}</template>\r\n<script setup lang="ts">\r\n${SCRIPT}\r\n</script>\r\n<style>${STYLE}</style>`;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "untangle-vue-cli-"));
  directories.push(root);
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(root, name), content);
  return root;
}

function textAt(content: string, range: SourceRange): string {
  return Buffer.from(content).subarray(range.startByte, range.endByte).toString("utf8");
}

describe("Vue complexity through the real CLI consumer", () => {
  it("measures private script helpers with unchanged TypeScript cognitive and cyclomatic totals", async () => {
    const vueRoot = await project({ "Widget.vue": SFC });
    const tsRoot = await project({ "native.ts": SCRIPT });
    const [vue, native] = await Promise.all([
      analyze(vueRoot, new AbortController().signal),
      analyze(tsRoot, new AbortController().signal),
    ]);
    expect(vue.filesAnalyzed).toBe(1);
    expect(vue.totals).toEqual(native.totals);
    expect(vue.totals).toEqual({
      executionUnits: 2,
      executionUnitRoots: 2,
      cognitive: 2,
      cyclomatic: 5,
    });
    expect(
      vue.symbols.map(({ name, cognitive, cyclomatic }) => ({ name, cognitive, cyclomatic })),
    ).toEqual(
      native.symbols.map(({ name, cognitive, cyclomatic }) => ({ name, cognitive, cyclomatic })),
    );
    expect(vue.symbols.map((entry) => entry.name)).toContain("helper");
    expect(vue.symbols.find((entry) => entry.name === "feature")?.line).toBe(3);
  });

  it("reports unmeasured original Unicode block ranges while retaining script metrics", async () => {
    const root = await project({ "Widget.vue": SFC });
    const report = await analyze(root, new AbortController().signal);
    const limits = report.skipped.filter((entry) => entry.reason === "no_metric_defined");
    expect(limits).toHaveLength(2);
    expect(
      limits.every((entry) => entry.subjectKind === "range" && entry.path === "Widget.vue"),
    ).toBe(true);
    expect(limits.map((entry) => textAt(SFC, entry.range!))).toEqual([TEMPLATE, STYLE]);
    expect(
      report.skipped.some(
        (entry) => entry.reason === "unsupported_language" || entry.reason === "parse_failed",
      ),
    ).toBe(false);
    expect(report.totals.cognitive).toBe(2);
  });

  it("serializes scope limits and measured hotspots in the normal JSON command", async () => {
    const root = await project({ "Widget.vue": SFC });
    const io = new BufferIo();
    const code = await complexityCommand.run(
      { io, cwd: root, env: {}, signal: new AbortController().signal },
      parseArgs(["--format=json"], complexityCommand.spec.flags),
    );
    expect(code).toBe(0);
    const report = JSON.parse(io.outText) as {
      filesAnalyzed: number;
      hotspots: { name: string; cognitive: number }[];
      skipped: { subjectKind: string; reason: string; range?: SourceRange }[];
    };
    expect(report.filesAnalyzed).toBe(1);
    expect(report.hotspots.map((entry) => entry.name)).toEqual(["feature", "helper"]);
    expect(
      report.skipped
        .filter((entry) => entry.subjectKind === "range")
        .every((entry) => entry.range !== undefined),
    ).toBe(true);
  });

  it("does not turn template-only or damaged scripts into zero-complexity success", async () => {
    const root = await project({
      "OnlyTemplate.vue": `<template>${TEMPLATE}</template>`,
      "Broken.vue": '<script setup lang="ts">const broken = ;</script>',
    });
    const report = await analyze(root, new AbortController().signal);
    expect(report.filesAnalyzed).toBe(0);
    expect(report.symbols).toEqual([]);
    expect(
      report.skipped
        .filter((entry) => entry.reason === "parse_failed")
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["Broken.vue", "OnlyTemplate.vue"]);
  });
});
