import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalJson,
  CHUNKER_VERSION,
  knownParserLanguages,
  LEXICAL_TOKENIZER_VERSION,
  parserVersionForLanguage,
  sha256Hex,
} from "@untangle-code/domain";
import { afterEach, describe, expect, it } from "vitest";

import { resolveTarget } from "../commands/index/target.js";

import { indexConfigFingerprint, inspectIndexFreshness } from "./index-freshness.js";
import type { FoundIndexState } from "./index-state.js";
import { loadWorkspace } from "./workspace.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "untangle-vue-parser-freshness-"));
  directories.push(root);
  await writeFile(
    path.join(root, "Widget.vue"),
    '<template>Ready</template><script setup lang="ts">const ready = true;</script>',
  );
  const view = loadWorkspace({ cwd: root, env: {}, strict: true });
  const target = resolveTarget({
    config: view.config,
    cwd: root,
    rootFlag: root,
    repoFlag: undefined,
    refFlag: undefined,
    configBaseDir: view.root,
  });
  const state: FoundIndexState = {
    repoRoot: root,
    statePath: path.join(root, ".untangle/index-state.json"),
    source: "registry",
    current: true,
    state: {
      schemaVersion: 1,
      workspaceId: view.workspaceId,
      repoId: target.repoId,
      refId: target.refId,
      refName: target.refName,
      embedder: "service",
      embeddingProfileId: view.profileId,
      collection: "test",
      qdrantUrl: "http://127.0.0.1:16333",
      outcome: "completed",
      generationId: "generation",
      corpusRevisionFingerprint: "a".repeat(64),
      indexedAt: "2026-10-23T10:00:00.000Z",
      indexConfigFingerprint: indexConfigFingerprint(view, target),
      lexicalTokenizerVersion: LEXICAL_TOKENIZER_VERSION,
    },
  };
  const first = await inspectIndexFreshness(view, [state]);
  return {
    view,
    target,
    state: {
      ...state,
      state: {
        ...state.state,
        corpusRevisionFingerprint: first.repositories[0]!.currentCorpusFingerprint!,
      },
    },
  };
}

describe("parser-version-bound corpus freshness", () => {
  it("requires a fresh current Vue parser snapshot even when source bytes are identical", async () => {
    const { view, target, state } = await fixture();
    expect(parserVersionForLanguage("vue")).toBe("untangle-parser-vue-sfc-v1");
    expect(await inspectIndexFreshness(view, [state])).toMatchObject({
      status: "fresh",
      repositories: [{ filesChecked: 1 }],
    });
    const previous = sha256Hex(
      canonicalJson({
        chunkerVersion: CHUNKER_VERSION,
        maxFileSizeMb: view.config.index.maxFileSizeMb,
        maxChunkTokens: view.config.index.maxChunkTokens,
        include: target.include ?? [],
        exclude: target.exclude ?? [],
      }),
    );
    expect(
      await inspectIndexFreshness(view, [
        { ...state, state: { ...state.state, indexConfigFingerprint: previous } },
      ]),
    ).toMatchObject({
      status: "stale",
      repositories: [{ reason: "index_configuration_changed", filesChecked: 0 }],
    });
  });

  it("rejects another Vue parser version without invalidating on operational concurrency alone", async () => {
    const { view, target, state } = await fixture();
    const olderVersion = sha256Hex(
      canonicalJson({
        chunkerVersion: CHUNKER_VERSION,
        parserVersions: knownParserLanguages().map((language) => [
          language,
          language === "vue" ? "untangle-parser-v1" : parserVersionForLanguage(language),
        ]),
        maxFileSizeMb: view.config.index.maxFileSizeMb,
        maxChunkTokens: view.config.index.maxChunkTokens,
        include: target.include ?? [],
        exclude: target.exclude ?? [],
      }),
    );
    expect(
      await inspectIndexFreshness(view, [
        { ...state, state: { ...state.state, indexConfigFingerprint: olderVersion } },
      ]),
    ).toMatchObject({ status: "stale", repositories: [{ reason: "index_configuration_changed" }] });
    const concurrentView = {
      ...view,
      config: {
        ...view.config,
        index: { ...view.config.index, scanConcurrency: view.config.index.scanConcurrency + 1 },
      },
    };
    expect(indexConfigFingerprint(concurrentView, target)).toBe(
      indexConfigFingerprint(view, target),
    );
    expect((await inspectIndexFreshness(concurrentView, [state])).status).toBe("fresh");
  });
});
