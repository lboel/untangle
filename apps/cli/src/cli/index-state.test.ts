/**
 * WP-229: Das benutzte Embedding-Profil steht im Indexzustand.
 *
 * Die Faelle hier sind die drei, die `untangle query` auseinanderhalten muss:
 * es gibt einen Zustand, es gibt keinen, und es gibt mehrere, die sich
 * widersprechen. Nur der erste erlaubt eine Entscheidung.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INDEX_STATE_RECORDS_DIR,
  INDEX_STATE_REGISTRY_DIR,
  MAX_INDEX_STATE_FILE_BYTES,
  MAX_INDEX_STATE_REGISTRY_ENTRIES,
  indexStateAfterRun,
  indexStateCurrentPath,
  indexStatePath,
  indexStateRecordPath,
  parseIndexState,
  readIndexState,
  replaceRunningIndexState,
  resolveIndexState,
  stateRootOf,
  writeIndexState,
  type IndexStateV1,
} from "./index-state.js";

const WORKSPACE = "ws-1";

function state(overrides: Partial<IndexStateV1> = {}): IndexStateV1 {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE,
    repoId: "repo-1",
    refId: "repo-1:main",
    refName: "main",
    embedder: "offline",
    embeddingProfileId: "profile-offline",
    collection: "untangle_demo_code_abcd_v1",
    qdrantUrl: "http://127.0.0.1:16333",
    generationId: "generation-1",
    outcome: "completed",
    ...overrides,
  };
}

async function writeLegacyState(stateRoot: string, value: IndexStateV1): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(indexStatePath(stateRoot), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withoutGeneration(value: IndexStateV1): IndexStateV1 {
  const { generationId: _generationId, ...legacy } = value;
  return legacy;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "untangle-index-state-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Indexzustand", () => {
  it("schreibt und liest denselben Zustand zurueck", async () => {
    const repo = path.join(root, "projekt");
    const withCorpusRevision = state({ corpusRevisionFingerprint: "a".repeat(64) });
    const written = await writeIndexState(stateRootOf(repo), withCorpusRevision);
    expect(written.ok).toBe(true);
    await expect(readIndexState(stateRootOf(repo))).resolves.toEqual(withCorpusRevision);
  });

  it("ist deterministisch: derselbe gemeldete Indexzustand schreibt dieselben Bytes", async () => {
    const repo = path.join(root, "projekt");
    await writeIndexState(stateRootOf(repo), state());
    const first = await readIndexState(stateRootOf(repo));
    await writeIndexState(stateRootOf(repo), state());
    const second = await readIndexState(stateRootOf(repo));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("behandelt eine kaputte Datei als fehlenden Zustand, nicht als Absturz", async () => {
    const repo = path.join(root, "projekt");
    await writeIndexState(stateRootOf(repo), state());
    await writeFile(indexStatePath(stateRootOf(repo)), "{ das ist kein json", "utf8");
    await expect(readIndexState(stateRootOf(repo))).resolves.toBeNull();
    expect(parseIndexState('{"schemaVersion":2}')).toBeNull();
    expect(parseIndexState(JSON.stringify({ ...state(), embedder: "magie" }))).toBeNull();
    expect(parseIndexState(JSON.stringify({ ...state(), generationId: "" }))).toBeNull();
    expect(
      parseIndexState(JSON.stringify({ ...state(), corpusRevisionFingerprint: "not-a-sha" })),
    ).toBeNull();
  });

  it("liest einen älteren Zustand ohne Generation weiterhin, markiert sie aber nicht als bekannt", () => {
    const legacy = { ...state() };
    delete legacy.generationId;

    expect(parseIndexState(JSON.stringify(legacy))).toEqual(legacy);
  });

  it("invalidiert einen alten completed-Zustand nach spaetem Fehler, aber nicht bei Readiness-Fehlern", async () => {
    const repo = path.join(root, "projekt");
    const stateRoot = stateRootOf(repo);
    const completed = state({ generationId: "generation-completed", outcome: "completed" });
    await writeIndexState(stateRoot, completed);

    const readinessFailure = indexStateAfterRun({
      ...completed,
      generationId: null,
      outcome: "failed",
    });
    expect(readinessFailure).toBeNull();
    await expect(readIndexState(stateRoot)).resolves.toEqual(completed);

    const lateFailure = indexStateAfterRun({
      ...completed,
      generationId: "generation-partial",
      outcome: "failed",
    });
    expect(lateFailure).not.toBeNull();
    if (lateFailure === null) throw new Error("expected a failed generation state");
    await writeIndexState(stateRoot, lateFailure);

    await expect(readIndexState(stateRoot)).resolves.toEqual(
      state({ generationId: "generation-partial", outcome: "failed" }),
    );
  });

  it("publiziert die Corpus-Revision nur fuer einen abgeschlossenen Index", () => {
    const fingerprint = "b".repeat(64);
    expect(
      indexStateAfterRun({
        ...state(),
        generationId: "generation-completed",
        outcome: "completed",
        corpusRevisionFingerprint: fingerprint,
      }),
    ).toMatchObject({ corpusRevisionFingerprint: fingerprint });
    expect(
      indexStateAfterRun({
        ...state(),
        generationId: "generation-failed",
        outcome: "failed",
        corpusRevisionFingerprint: fingerprint,
      }),
    ).not.toHaveProperty("corpusRevisionFingerprint");
  });

  it("laesst einen alten Abschluss keinen neueren running-Marker ueberschreiben", async () => {
    const repo = path.join(root, "projekt");
    const stateRoot = stateRootOf(repo);
    const runA = state({ generationId: "generation-a", outcome: "running" });
    const runB = state({ generationId: "generation-b", outcome: "running" });
    await writeIndexState(stateRoot, runA);
    await writeIndexState(stateRoot, runB);

    const staleFinish = await replaceRunningIndexState(
      stateRoot,
      state({ generationId: "generation-a", outcome: "completed" }),
    );
    expect(staleFinish).toMatchObject({ ok: true, superseded: true });
    await expect(readIndexState(stateRoot)).resolves.toEqual(runB);

    const currentFinish = await replaceRunningIndexState(
      stateRoot,
      state({ generationId: "generation-b", outcome: "completed" }),
    );
    expect(currentFinish).toMatchObject({ ok: true, superseded: false });
    await expect(readIndexState(stateRoot)).resolves.toEqual(
      state({ generationId: "generation-b", outcome: "completed" }),
    );
  });

  it("invalidiert den current-Zustand, wenn ein neuer Record keine Generation tragen kann", async () => {
    const repo = path.join(root, "generationless-publication");
    const stateRoot = stateRootOf(repo);
    await writeIndexState(stateRoot, state({ generationId: "healthy-generation" }));

    const result = await writeIndexState(stateRoot, withoutGeneration(state()));
    expect(result).toMatchObject({ ok: false, previousStateInvalidated: true });
    await expect(readIndexState(stateRoot)).resolves.toBeNull();
    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("none");
  });

  it("laesst einen pausierten Writer nach Ownership-Verlust nicht ueber einen Nachfolger renamen", async () => {
    const repo = path.join(root, "stale-before-rename");
    const stateRoot = stateRootOf(repo);
    const successor = state({ generationId: "generation-successor" });
    await writeIndexState(stateRoot, successor);

    const ownershipLoss = new Error("publication lease was lost");
    const staleWrite = await writeIndexState(
      stateRoot,
      state({ generationId: "generation-stale", outcome: "running" }),
      {
        assertOwnership: async () => {
          // This guard runs after the temp file exists and immediately before
          // the live rename — precisely the slow/pause boundary under audit.
          await delay(8);
          throw ownershipLoss;
        },
      },
    );

    expect(staleWrite).toMatchObject({
      ok: false,
      previousStateInvalidated: false,
      invalidationError: ownershipLoss,
    });
    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.found.state.generationId).toBe("generation-successor");
    }
  });

  it("findet den Zustand und nennt den Einbetter", async () => {
    const repo = path.join(root, "projekt");
    await writeIndexState(stateRootOf(repo), state());
    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.embedder).toBe("offline");
      expect(resolution.found.repoRoot).toBe(path.resolve(repo));
      expect(resolution.all).toHaveLength(1);
    }
  });

  it("uebergeht den Zustand eines FREMDEN Workspace", async () => {
    const repo = path.join(root, "projekt");
    await writeIndexState(stateRootOf(repo), state({ workspaceId: "ein-anderer" }));
    await expect(resolveIndexState([repo], WORKSPACE)).resolves.toEqual({ kind: "none" });
  });

  it("raet nicht, wenn zwei Repositories sich widersprechen", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await writeIndexState(stateRootOf(a), state({ embedder: "offline", repoId: "a" }));
    await writeIndexState(stateRootOf(b), state({ embedder: "service", repoId: "b" }));
    const resolution = await resolveIndexState([a, b], WORKSPACE);
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.found).toHaveLength(2);
    }
  });

  it("liest jede Wurzel nur einmal, auch wenn sie doppelt genannt wird", async () => {
    const repo = path.join(root, "projekt");
    await writeIndexState(stateRootOf(repo), state());
    const resolution = await resolveIndexState([repo, repo, `${repo}/.`], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
  });

  it("meldet einen Schreibfehler, statt ihn zu verschlucken", async () => {
    // Eine Datei dort, wo das Verzeichnis hin muesste: `mkdir` kann nicht.
    const blocked = path.join(root, "blockiert");
    await writeFile(blocked, "ich bin eine Datei", "utf8");
    const result = await writeIndexState(path.join(blocked, ".untangle"), state());
    expect(result.ok).toBe(false);
  });

  it("entfernt einen alten completed-Zustand, wenn dessen Ersatz nicht publiziert werden kann", async () => {
    const repo = path.join(root, "projekt");
    const stateRoot = stateRootOf(repo);
    await writeIndexState(
      stateRoot,
      state({ embedder: "service", embeddingProfileId: "profile-service" }),
    );

    // Ein Verzeichnis am current-Pfad erzwingt einen Schreibfehler nach dem
    // erfolgreichen Record-Write. Der alte Pointer darf danach nicht als
    // gesunde Provenienz zurueckbleiben.
    const currentPath = indexStateCurrentPath(stateRoot, state());
    await rm(currentPath);
    await mkdir(currentPath);
    const result = await writeIndexState(
      stateRoot,
      state({ embedder: "offline", embeddingProfileId: "profile-offline-next" }),
    );

    expect(result).toMatchObject({ ok: false, previousStateInvalidated: false });
    await expect(readIndexState(stateRoot)).resolves.toBeNull();
  });

  it("scopes die Auto-Auswahl auf beteiligte Repositories und Ref-Namen", async () => {
    const selected = path.join(root, "selected");
    const unrelated = path.join(root, "unrelated");
    await writeIndexState(
      stateRootOf(selected),
      state({ embedder: "offline", repoId: "selected" }),
    );
    await writeIndexState(
      stateRootOf(unrelated),
      state({ embedder: "service", repoId: "unrelated" }),
    );

    const resolution = await resolveIndexState([selected, unrelated], WORKSPACE, {
      repoIds: ["selected"],
      refs: ["main"],
    });
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.embedder).toBe("offline");
      expect(resolution.all.map((entry) => entry.state.repoId)).toEqual(["selected"]);
    }
  });

  it("persistiert zwei Refs unter einer physischen Wurzel und loest omitted, Name und canonical auf", async () => {
    const repo = path.join(root, "multi-ref");
    const stateRoot = stateRootOf(repo);
    const main = state({ refId: "repo-1:main", refName: "main", generationId: "gen-main" });
    const release = state({
      refId: "repo-1:release/1.x",
      refName: "release/1.x",
      generationId: "gen-release",
    });
    await writeIndexState(stateRoot, main);
    await writeIndexState(stateRoot, release);

    const omitted = await resolveIndexState([repo], WORKSPACE);
    expect(omitted.kind).toBe("resolved");
    if (omitted.kind === "resolved") {
      expect(omitted.all.map((entry) => entry.state.refId)).toEqual([
        "repo-1:main",
        "repo-1:release/1.x",
      ]);
      expect(omitted.current).toHaveLength(2);
    }

    const byName = await resolveIndexState([repo], WORKSPACE, { refs: ["release/1.x"] });
    expect(byName.kind).toBe("resolved");
    if (byName.kind === "resolved") {
      expect(byName.all.map((entry) => entry.state.refId)).toEqual(["repo-1:release/1.x"]);
    }

    const canonical = await resolveIndexState([repo], WORKSPACE, { refs: ["repo-1:main"] });
    expect(canonical.kind).toBe("resolved");
    if (canonical.kind === "resolved") {
      expect(canonical.all.map((entry) => entry.state.refName)).toEqual(["main"]);
    }
  });

  it("bewahrt getrennte Repo-IDs auf demselben physischen Pfad ohne Record-Kollision", async () => {
    const repo = path.join(root, "shared-path");
    const stateRoot = stateRootOf(repo);
    const repoA = state({
      repoId: "repo-a",
      refId: "repo-a:main",
      generationId: "gen-a",
    });
    const repoB = state({
      repoId: "repo-b",
      refId: "repo-b:main",
      generationId: "gen-b",
    });

    expect(indexStateRecordPath(stateRoot, repoA)).not.toBe(indexStateRecordPath(stateRoot, repoB));
    await Promise.all([writeIndexState(stateRoot, repoA), writeIndexState(stateRoot, repoB)]);

    const resolution = await resolveIndexState([repo, `${repo}/.`], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.all.map((entry) => entry.state.repoId)).toEqual(["repo-a", "repo-b"]);
      expect(resolution.current).toHaveLength(2);
    }
  });

  it("archiviert mehrere Profile desselben Repo/Refs, ohne dass ein spaeter Abschluss current stiehlt", async () => {
    const repo = path.join(root, "multi-profile");
    const stateRoot = stateRootOf(repo);
    const serviceRun = state({
      embedder: "service",
      embeddingProfileId: "profile-service",
      generationId: "gen-service",
      outcome: "running",
    });
    const offlineRun = state({
      embedder: "offline",
      embeddingProfileId: "profile-offline",
      generationId: "gen-offline",
      outcome: "running",
    });
    await writeIndexState(stateRoot, serviceRun);
    await writeIndexState(stateRoot, offlineRun);

    const lateServiceFinish = await replaceRunningIndexState(stateRoot, {
      ...serviceRun,
      outcome: "completed",
    });
    expect(lateServiceFinish).toMatchObject({ ok: true, superseded: false });

    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.embedder).toBe("offline");
      expect(resolution.found.state.generationId).toBe("gen-offline");
      expect(resolution.all.map((entry) => entry.state.embeddingProfileId)).toEqual([
        "profile-offline",
        "profile-service",
      ]);
      expect(resolution.all.find((entry) => entry.state.embedder === "service")).toMatchObject({
        current: false,
        state: { outcome: "completed" },
      });
    }
  });

  it("liest einen Legacy-Singleton allein als aktuellen Migrations-Fallback", async () => {
    const repo = path.join(root, "legacy-only");
    const legacy = withoutGeneration(state());
    await writeLegacyState(stateRootOf(repo), legacy);

    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.all).toHaveLength(1);
      expect(resolution.found).toMatchObject({ source: "legacy", current: true, state: legacy });
    }
  });

  it("laesst einen Registry-Record denselben Legacy-Key ersetzen, statt ihn zu duplizieren", async () => {
    const repo = path.join(root, "legacy-same-key");
    const stateRoot = stateRootOf(repo);
    await writeLegacyState(stateRoot, state({ generationId: "legacy-generation" }));
    await writeIndexState(stateRoot, state({ generationId: "registry-generation" }));

    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.all).toHaveLength(1);
      expect(resolution.found).toMatchObject({
        source: "registry",
        state: { generationId: "registry-generation" },
      });
    }
  });

  it("vereinigt einen Legacy-Datensatz mit anderem Profil, aber macht den Registry-Pointer current", async () => {
    const repo = path.join(root, "legacy-different-key");
    const stateRoot = stateRootOf(repo);
    await writeLegacyState(
      stateRoot,
      state({
        embedder: "service",
        embeddingProfileId: "profile-service",
        generationId: "legacy-service",
      }),
    );
    await writeIndexState(
      stateRoot,
      state({
        embedder: "offline",
        embeddingProfileId: "profile-offline",
        generationId: "registry-offline",
      }),
    );

    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.embedder).toBe("offline");
      expect(resolution.all).toHaveLength(2);
      expect(resolution.all.find((entry) => entry.source === "legacy")?.current).toBe(false);
      expect(resolution.all.find((entry) => entry.source === "registry")?.current).toBe(true);
    }
  });

  it("loest den menschlichen Ref-Namen eines aelteren Legacy-Refs explizit auf", async () => {
    const repo = path.join(root, "legacy-ref-name");
    const stateRoot = stateRootOf(repo);
    await writeLegacyState(
      stateRoot,
      withoutGeneration(
        state({
          refId: "repo-1:release/legacy",
          refName: "release/legacy",
        }),
      ),
    );
    await writeIndexState(
      stateRoot,
      state({ refId: "repo-1:main", refName: "main", generationId: "registry-main" }),
    );

    const resolution = await resolveIndexState([repo], WORKSPACE, { refs: ["release/legacy"] });
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.all.map((entry) => entry.state.refId)).toEqual(["repo-1:release/legacy"]);
      expect(resolution.found.source).toBe("legacy");
    }
  });

  it("bindet den current-Pointer an Profil und Generation und lehnt Manipulation sichtbar ab", async () => {
    const repo = path.join(root, "pointer-cas");
    const stateRoot = stateRootOf(repo);
    const value = state({ generationId: "generation-current" });
    await writeIndexState(stateRoot, value);
    const pointerPath = indexStateCurrentPath(stateRoot, value);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    pointer["generationId"] = "generation-other";
    await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`, "utf8");

    const resolution = await resolveIndexState([repo], WORKSPACE);
    expect(resolution.kind).toBe("invalid");
    if (resolution.kind === "invalid") {
      expect(resolution.diagnostics[0]?.code).toBe("INDEX_STATE_CORRUPT");
      expect(resolution.diagnostics[0]?.message).toContain("generation-bound");
    }
  });

  it("verwendet nur gehashte Dateinamen, auch wenn Identitaeten Pfadsegmente enthalten", () => {
    const stateRoot = path.join(root, ".untangle");
    const hostile = state({
      repoId: "../../anderes-repo",
      refId: "../../anderes-repo:../branch",
      embeddingProfileId: "../profile",
    });
    const recordPath = indexStateRecordPath(stateRoot, hostile);
    const currentPath = indexStateCurrentPath(stateRoot, hostile);

    expect(path.relative(stateRoot, recordPath)).toMatch(
      /^index-states-v1\/records\/[0-9a-f]{64}\.json$/u,
    );
    expect(path.relative(stateRoot, currentPath)).toMatch(
      /^index-states-v1\/current\/[0-9a-f]{64}\.json$/u,
    );
  });

  it("lehnt korrupte und symbolisch verlinkte Registry-Records fail-closed ab", async () => {
    const corruptRepo = path.join(root, "corrupt-record");
    const corruptRoot = stateRootOf(corruptRepo);
    const corruptState = state({ generationId: "corrupt-generation" });
    await writeIndexState(corruptRoot, corruptState);
    await writeFile(indexStateRecordPath(corruptRoot, corruptState), "{ kaputt", "utf8");
    const corrupt = await resolveIndexState([corruptRepo], WORKSPACE);
    expect(corrupt.kind).toBe("invalid");

    const linkedRepo = path.join(root, "linked-record");
    const linkedRoot = stateRootOf(linkedRepo);
    const linkedState = state({ generationId: "linked-generation" });
    await writeIndexState(linkedRoot, linkedState);
    const recordPath = indexStateRecordPath(linkedRoot, linkedState);
    const outside = path.join(root, "outside-state.json");
    await writeFile(outside, `${JSON.stringify(linkedState)}\n`, "utf8");
    await rm(recordPath);
    await symlink(outside, recordPath);
    const linked = await resolveIndexState([linkedRepo], WORKSPACE);
    expect(linked.kind).toBe("invalid");
  });

  it("lehnt uebergrosse Legacy-Dateien und unbeschraenkte Registries sichtbar ab", async () => {
    const oversizedRepo = path.join(root, "oversized");
    const oversizedRoot = stateRootOf(oversizedRepo);
    await mkdir(oversizedRoot, { recursive: true });
    await writeFile(
      indexStatePath(oversizedRoot),
      "x".repeat(MAX_INDEX_STATE_FILE_BYTES + 1),
      "utf8",
    );
    const oversized = await resolveIndexState([oversizedRepo], WORKSPACE);
    expect(oversized.kind).toBe("invalid");
    if (oversized.kind === "invalid") {
      expect(oversized.diagnostics[0]?.code).toBe("INDEX_STATE_OVERSIZED");
    }

    const oversizedRecordRepo = path.join(root, "oversized-record");
    const oversizedRecordRoot = stateRootOf(oversizedRecordRepo);
    const oversizedRecordState = state({ generationId: "oversized-record-generation" });
    await writeIndexState(oversizedRecordRoot, oversizedRecordState);
    await writeFile(
      indexStateRecordPath(oversizedRecordRoot, oversizedRecordState),
      "x".repeat(MAX_INDEX_STATE_FILE_BYTES + 1),
      "utf8",
    );
    const oversizedRecord = await resolveIndexState([oversizedRecordRepo], WORKSPACE);
    expect(oversizedRecord.kind).toBe("invalid");
    if (oversizedRecord.kind === "invalid") {
      expect(oversizedRecord.diagnostics[0]?.code).toBe("INDEX_STATE_OVERSIZED");
    }

    const unboundedRepo = path.join(root, "unbounded");
    const recordsDirectory = path.join(
      stateRootOf(unboundedRepo),
      INDEX_STATE_REGISTRY_DIR,
      INDEX_STATE_RECORDS_DIR,
    );
    await mkdir(recordsDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_INDEX_STATE_REGISTRY_ENTRIES + 1 }, async (_, index) => {
        const name = index.toString(16).padStart(64, "0");
        await writeFile(path.join(recordsDirectory, `${name}.json`), "{}\n", "utf8");
      }),
    );
    const unbounded = await resolveIndexState([unboundedRepo], WORKSPACE);
    expect(unbounded.kind).toBe("invalid");
    if (unbounded.kind === "invalid") {
      expect(unbounded.diagnostics[0]?.code).toBe("INDEX_STATE_UNBOUNDED");
    }
  });
});
