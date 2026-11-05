/**
 * Die Verdrahtung von `untangle query` gegen den ECHTEN Abrufkern.
 *
 * Getestet wird die ganze Strecke von den CLI-Optionen bis zur Ausgabe:
 * Optionen -> `UntangleSearchRequestV1`/`GrepRequestV1` -> `HybridSearchEngine`
 * (das echte Paket, keine Attrappe) -> Textausgabe. Nur die Adapter darunter
 * sind ausgetauscht: der In-Memory-Speicher und der deterministische
 * Embedder des testkits stehen an der Stelle von Qdrant und Ollama.
 *
 * Genau diese Grenze ist der Grund, warum der Abrufkern speicher-agnostisch
 * geschnitten ist — und der Grund, warum dieser Test ohne Docker, ohne Netz
 * und ohne laufendes Ollama vollstaendig aussagekraeftig ist.
 */
import path from "node:path";

import type { CodeChunkPayloadV1, VectorPointV1 } from "@untangle-code/domain";
import { NO_SUFFICIENT_MATCH_WARNING_CODE, createHybridSearchEngine } from "@untangle-code/search";
import { DeterministicEmbedder, InMemoryVectorStore } from "@untangle-code/testkit";
import { beforeAll, describe, expect, it } from "vitest";

import { parseArgs } from "../cli/args.js";
import type { CommandContext } from "../cli/command.js";
import type { FoundIndexState } from "../cli/index-state.js";
import { BufferIo } from "../cli/io.js";

import {
  queryCommand,
  buildGrepRequest,
  buildSearchRequest,
  failedTargets,
  indexStateRoots,
  queryIndexStatesFromResolution,
  queryRefIdsFromIndexStates,
  resolveEmbedderChoice,
  renderGrep,
  renderSearch,
} from "./query.js";

const COLLECTION = "untangle_code_test_v1";
const WORKSPACE = "ws-test";

const clock = { nowEpochMs: () => 1_700_000_000_000, nowIso: () => "2023-11-14T22:13:20.000Z" };
const embedder = new DeterministicEmbedder(clock);

function payload(input: {
  path: string;
  symbol: string;
  content: string;
  startLine: number;
}): CodeChunkPayloadV1 {
  return {
    schema_version: 1,
    point_type: "code_chunk",
    workspace_id: WORKSPACE,
    repo_id: "demo",
    repo_label: "demo",
    ref_id: "demo:main",
    ref_name: "main",
    file_id: input.path,
    file_path: input.path,
    file_hash: "f".repeat(64),
    language: "typescript",
    parse_quality: "complete",
    symbol_id: `sym:${input.symbol}`,
    symbol_name: input.symbol,
    symbol_fqn: input.symbol,
    symbol_kind: "function",
    chunk_id: `${input.path}#${input.symbol}`,
    chunk_kind: "symbol",
    chunk_ordinal: 0,
    start_line: input.startLine,
    end_line: input.startLine + input.content.split("\n").length - 1,
    start_byte: 0,
    end_byte: Buffer.byteLength(input.content, "utf8"),
    content: input.content,
    content_hash: "c".repeat(64),
    parser_version: "test",
    chunker_version: "test",
    metrics_version: "test",
    embedding_profile_id: embedder.profileId,
    generation_id: "gen-test",
    embedding_truncated: false,
    metrics_scope: "symbol",
    metrics_scope_id: `sym:${input.symbol}`,
    cognitive: 4,
    cyclomatic_extended: 3,
  };
}

const FIXTURES = [
  {
    path: "src/payment.ts",
    symbol: "charge",
    startLine: 2,
    content:
      "async function charge(amount: number): Promise<boolean> {\n  return await fetch(url).then((r) => r.ok);\n}",
  },
  {
    path: "src/refund.ts",
    symbol: "refund",
    startLine: 1,
    content: "function refund(amount: number): number {\n  return amount;\n}",
  },
];

const store = new InMemoryVectorStore();

const engine = createHybridSearchEngine({
  vectorStore: store,
  targets: [
    {
      embeddingProfileId: embedder.profileId,
      collection: COLLECTION,
      repoIds: ["demo"],
      embedder,
    },
  ],
  defaults: { workspaceId: WORKSPACE, limit: 10, candidateLimit: 50 },
  clock,
});

beforeAll(async () => {
  await store.ensureCollection({
    name: COLLECTION,
    denseDimensions: embedder.profile.dimensions,
    denseDistance: "Cosine",
    sparseBm25: true,
    onDiskPayload: false,
  });
  const points: VectorPointV1[] = [];
  for (const fixture of FIXTURES) {
    const body = payload(fixture);
    points.push({
      id: body.chunk_id,
      dense: await embedder.embedQuery(`${fixture.path} ${fixture.symbol} ${fixture.content}`),
      payload: body as unknown as Record<string, unknown>,
    });
  }
  await store.upsert(COLLECTION, points);
});

function contextWith(io: BufferIo): CommandContext {
  return { io, cwd: process.cwd(), env: {}, signal: new AbortController().signal };
}

function foundIndexState(repoId: string, refId: string, refName = "main"): FoundIndexState {
  return {
    repoRoot: `/workspace/${repoId}`,
    statePath: `/workspace/${repoId}/.untangle/index-states-v1/records/state.json`,
    source: "registry",
    current: true,
    state: {
      schemaVersion: 1,
      workspaceId: WORKSPACE,
      repoId,
      refId,
      refName,
      embedder: "service",
      embeddingProfileId: embedder.profileId,
      collection: COLLECTION,
      qdrantUrl: "http://127.0.0.1:6333",
      generationId: `generation-${repoId}`,
      corpusRevisionFingerprint: "a".repeat(64),
      outcome: "completed",
    },
  };
}

describe("untangle query — semantische Suche", () => {
  it("sucht den Auto-Indexzustand bei --repo nur in den ausgewaehlten Repository-Wurzeln", () => {
    expect(
      indexStateRoots({
        invocationRoot: "/workspace",
        configBaseDir: "/workspace",
        repositories: [
          { id: "selected", path: "packages/selected" },
          { id: "unrelated", path: "packages/unrelated" },
        ],
        selectedRepoIds: ["selected"],
      }),
    ).toEqual([path.resolve("/workspace/packages/selected")]);
  });

  it("begrenzt einen ausgelassenen --ref-Filter auf die kompatiblen lokalen Index-Refs", () => {
    const compatibleStates = [
      foundIndexState("repo-b", "repo-b:main"),
      foundIndexState("repo-a", "repo-a:main"),
    ];

    const inferred = queryRefIdsFromIndexStates([], compatibleStates);
    expect(inferred).toEqual(["repo-a:main", "repo-b:main"]);
    expect(queryRefIdsFromIndexStates(["main"], compatibleStates)).toEqual([
      "repo-a:main",
      "repo-b:main",
    ]);
    // An already canonical ID selects exactly that repo/ref pair; it must not
    // be broadened merely because another selected repo has the same name.
    expect(queryRefIdsFromIndexStates(["repo-a:main"], compatibleStates)).toEqual(["repo-a:main"]);
    expect(queryRefIdsFromIndexStates(["repo-b:release"], compatibleStates)).toEqual([
      "repo-b:release",
    ]);

    const args = parseArgs(["--grep", "needle"], queryCommand.spec.flags);
    expect(buildGrepRequest(args, WORKSPACE, "needle", inferred).refs).toEqual(inferred);
  });

  it("nutzt bei auto nur current, stellt expliziten Profilen aber die ganze Registry bereit", () => {
    const current = foundIndexState("demo", "demo:main");
    const archived: FoundIndexState = {
      ...current,
      statePath: "/workspace/demo/.untangle/index-states-v1/records/archived.json",
      current: false,
      state: {
        ...current.state,
        embedder: "offline",
        embeddingProfileId: "profile-offline",
        generationId: "generation-offline",
      },
    };
    const resolution = {
      kind: "resolved" as const,
      embedder: "service" as const,
      found: current,
      current: [current],
      all: [archived, current],
    };

    expect(queryIndexStatesFromResolution(resolution, true)).toEqual([current]);
    expect(queryIndexStatesFromResolution(resolution, false)).toEqual([archived, current]);
  });

  it("bricht auto bei unterschiedlichen current-Embeddern ab, statt nur einen Ref zu suchen", () => {
    const service = foundIndexState("repo-service", "repo-service:main");
    const offline: FoundIndexState = {
      ...foundIndexState("repo-offline", "repo-offline:main"),
      state: {
        ...foundIndexState("repo-offline", "repo-offline:main").state,
        embedder: "offline",
        embeddingProfileId: "profile-offline",
      },
    };
    const resolution = {
      kind: "ambiguous" as const,
      found: [offline, service],
      all: [offline, service],
    };
    const io = new BufferIo();

    expect(() =>
      resolveEmbedderChoice(
        contextWith(io),
        parseArgs(["needle"], queryCommand.spec.flags),
        resolution,
      ),
    ).toThrow(/--embedder=service.*--embedder=offline/u);
    expect(
      resolveEmbedderChoice(
        contextWith(io),
        parseArgs(["--embedder=service", "needle"], queryCommand.spec.flags),
        resolution,
      ),
    ).toBe(false);
    expect(
      resolveEmbedderChoice(
        contextWith(io),
        parseArgs(["--embedder=offline", "needle"], queryCommand.spec.flags),
        resolution,
      ),
    ).toBe(true);
  });

  it("wendet einen aufgeloesten Ref-Namen in semantischer Suche und grep als kanonische ID an", async () => {
    const compatibleStates = [foundIndexState("demo", "demo:main")];
    const resolved = queryRefIdsFromIndexStates(["main"], compatibleStates);
    expect(resolved).toEqual(["demo:main"]);

    const semanticArgs = parseArgs(["charge", "--ref=main"], queryCommand.spec.flags);
    const semanticRequest = buildSearchRequest(semanticArgs, WORKSPACE, "charge", resolved);
    expect(semanticRequest.refs).toEqual(["demo:main"]);
    expect((await engine.search(semanticRequest)).totalHits).toBeGreaterThan(0);

    const grepArgs = parseArgs(["--grep", "--ref=main", "fetch"], queryCommand.spec.flags);
    const grepRequest = buildGrepRequest(grepArgs, WORKSPACE, "fetch", resolved);
    expect(grepRequest.refs).toEqual(["demo:main"]);
    expect((await engine.grep(grepRequest)).totalMatches).toBe(1);
  });

  it("findet ein Symbol und macht die Score-Zerlegung mit --explain sichtbar", async () => {
    const args = parseArgs(["charge", "--explain", "--limit=5"], queryCommand.spec.flags);
    const request = buildSearchRequest(args, WORKSPACE, "charge");
    expect(request.mode).toBe("hybrid");
    expect(request.limit).toBe(5);

    const result = await engine.search(request);
    expect(result.totalHits).toBeGreaterThan(0);

    const hit = result.groups[0]?.hits[0];
    expect(hit?.symbolName).toBe("charge");
    // Die Zerlegung ist der Kern von vision.md §1d: genau ein base_hybrid,
    // und die Summe der Beitraege ergibt den Endscore.
    const components = hit?.score.components ?? [];
    expect(components.filter((c) => c.kind === "base_hybrid")).toHaveLength(1);
    const sum = components.reduce((total, c) => total + c.contribution, 0);
    expect(sum).toBeCloseTo(hit?.score.final ?? Number.NaN, 6);

    const io = new BufferIo();
    renderSearch(contextWith(io), result, "text", true);
    expect(io.outText).toContain("src/payment.ts");
    expect(io.outText).toContain("base_hybrid");
  });

  it("beendet mit --explain JEDE Ausgabe mit einem Zeilenumbruch (WP-230)", async () => {
    // Der Befund: der Hinweis auf uebersprungene Kandidaten klebte ohne
    // Umbruch an der letzten Trefferzeile, weil `formatHitAsText` ohne
    // Umbruch endet und die Ausgabe ihn nicht ergaenzte. Bei mehreren
    // Treffern klebte auch der naechste Treffer am vorherigen.
    const args = parseArgs(["charge", "--limit=5"], queryCommand.spec.flags);
    const result = await engine.search(buildSearchRequest(args, WORKSPACE, "charge"));
    const io = new BufferIo();
    renderSearch(contextWith(io), result, "text", true);

    expect(io.outText.endsWith("\n")).toBe(true);
    // Keine Zeile traegt zwei Trefferkoepfe — genau das waere das Kleben.
    for (const outputLine of io.outText.split("\n")) {
      const heads = outputLine.match(/\d\.\s+\d\.\d{4}\s{2}/gu);
      expect(heads === null ? 0 : heads.length).toBeLessThan(2);
    }
  });

  it("beendet auch json und jsonl mit einem Zeilenumbruch (WP-230)", async () => {
    const args = parseArgs(["charge"], queryCommand.spec.flags);
    const result = await engine.search(buildSearchRequest(args, WORKSPACE, "charge"));
    for (const format of ["json", "jsonl"] as const) {
      const io = new BufferIo();
      renderSearch(contextWith(io), result, format, false);
      expect(io.outText.endsWith("\n")).toBe(true);
    }
  });

  it("gibt ohne --explain eine kompakte Zeile je Treffer aus", async () => {
    const args = parseArgs(["charge"], queryCommand.spec.flags);
    const result = await engine.search(buildSearchRequest(args, WORKSPACE, "charge"));
    const io = new BufferIo();
    renderSearch(contextWith(io), result, "text", false);
    expect(io.outText).toContain("src/payment.ts");
    expect(io.outText).not.toContain("base_hybrid");
  });

  it("liefert mit --format=json ein Dokument samt Skip-Ledger", async () => {
    const args = parseArgs(["charge", "--format=json"], queryCommand.spec.flags);
    const result = await engine.search(buildSearchRequest(args, WORKSPACE, "charge"));
    const io = new BufferIo();
    renderSearch(contextWith(io), result, "json", false);
    const parsed = JSON.parse(io.outText) as Record<string, unknown>;
    expect(parsed).toHaveProperty("skipped");
    expect(parsed).toHaveProperty("queryFingerprint");
  });

  it("uebersetzt --path/--exclude/--lang in Filter der Anfrage", () => {
    const args = parseArgs(
      ["x", "--path=src/**", "--exclude=**/*.test.ts", "--lang=typescript", "--mode=lexical"],
      queryCommand.spec.flags,
    );
    const request = buildSearchRequest(args, WORKSPACE, "x");
    expect(request.pathGlob).toEqual(["src/**"]);
    expect(request.pathExclude).toEqual(["**/*.test.ts"]);
    expect(request.languages).toEqual(["typescript"]);
    expect(request.mode).toBe("lexical");
  });

  it("uebersetzt --context/--linked in die beiden post-ranking Anreicherungen", () => {
    const args = parseArgs(["x", "--context", "--linked"], queryCommand.spec.flags);
    const request = buildSearchRequest(args, WORKSPACE, "x");
    expect(request.includeContext).toBe(true);
    expect(request.includeLinked).toBe(true);
    expect(args.positionals).toEqual(["x"]);
  });

  it("lehnt die numerische grep-Form im Suchmodus sichtbar ab", () => {
    const args = parseArgs(["x", "--context=2"], queryCommand.spec.flags);
    expect(() => buildSearchRequest(args, WORKSPACE, "x")).toThrow(/applies only in grep mode/);
  });
});

describe("untangle query — grep-Modus (Nutzerwunsch A4)", () => {
  it("findet ein Literal mit Kontextzeilen und zaehlt die durchsuchten Chunks", async () => {
    const args = parseArgs(["--grep", "-C", "1", "fetch"], queryCommand.spec.flags);
    const request = buildGrepRequest(args, WORKSPACE, "fetch");
    expect(request.contextLinesBefore).toBe(1);
    expect(request.contextLinesAfter).toBe(1);
    expect(request.regex).toBe(false);
    expect(request.caseSensitive).toBe(true);

    const result = await engine.grep(request);
    expect(result.totalMatches).toBe(1);
    expect(result.scannedChunks).toBeGreaterThan(0);
    const match = result.matches[0];
    expect(match?.filePath).toBe("src/payment.ts");
    // Echte Dateizeile: der Chunk beginnt auf Zeile 2, der Treffer steht in
    // dessen zweiter Zeile.
    expect(match?.line).toBe(3);
    expect(match?.before).toHaveLength(1);

    const io = new BufferIo();
    renderGrep(contextWith(io), result, "text");
    expect(io.outText).toContain("src/payment.ts:3:");
    expect(io.errText).toContain("chunks searched");
  });

  it("behaelt die lange numerische --context=N-Form fuer grep", () => {
    const args = parseArgs(["--grep", "--context=2", "fetch"], queryCommand.spec.flags);
    const request = buildGrepRequest(args, WORKSPACE, "fetch");
    expect(request.contextLinesBefore).toBe(2);
    expect(request.contextLinesAfter).toBe(2);
  });

  it("faellt bei einem bloßen --context im grep-Modus nicht still auf null Zeilen zurueck", () => {
    const args = parseArgs(["--grep", "--context", "fetch"], queryCommand.spec.flags);
    expect(() => buildGrepRequest(args, WORKSPACE, "fetch")).toThrow(
      /requires a non-negative integer in grep mode/,
    );
  });

  it("sucht mit --regex und respektiert -i", async () => {
    const insensitive = parseArgs(["--regex", "-i", "FETCH"], queryCommand.spec.flags);
    const result = await engine.grep(buildGrepRequest(insensitive, WORKSPACE, "FETCH"));
    expect(result.isRegex).toBe(true);
    expect(result.totalMatches).toBe(1);

    const sensitive = parseArgs(["--regex", "FETCH"], queryCommand.spec.flags);
    const none = await engine.grep(buildGrepRequest(sensitive, WORKSPACE, "FETCH"));
    expect(none.totalMatches).toBe(0);
  });

  it("meldet eine Trefferbegrenzung als Abbruchgrund statt still zu kuerzen", async () => {
    const args = parseArgs(["--regex", "--max-matches=1", "amount"], queryCommand.spec.flags);
    const result = await engine.grep(buildGrepRequest(args, WORKSPACE, "amount"));
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max_matches");
  });
});

/**
 * REGRESSION, live gefunden (WP-124).
 *
 * Bei blockiertem Ollama gab diese Oberflaeche „Keine Treffer." mit
 * Exit-Code 0 aus, obwohl der Abrufkern im Ledger `provider_unavailable`
 * stehen hatte: das Ziel war gar nicht durchsucht worden. Ein leeres
 * Ergebnis als Antwort auf einen Ausfall ist genau die stille Beschoenigung,
 * die BUILD_PLAN E4 verbietet.
 */
describe("ausgefallenes Suchziel", () => {
  it('wird am Ledger erkannt und nicht mit „keine Treffer" verwechselt', () => {
    const failedTarget = {
      schemaVersion: 1 as const,
      stage: "search" as const,
      subjectKind: "search_candidate" as const,
      subjectId: "profile-abc",
      reason: "provider_unavailable" as const,
      detail: 'collection "c" did not answer: Ollama embedding operation was cancelled.',
      recoverable: true,
    };
    const ordinaryExclusion = {
      schemaVersion: 1 as const,
      stage: "search" as const,
      subjectKind: "chunk" as const,
      subjectId: "src/a.ts#0",
      reason: "excluded_by_configuration" as const,
      detail: "path does not pass the globs",
      recoverable: true,
    };

    expect(failedTargets([failedTarget, ordinaryExclusion])).toHaveLength(1);
    // Ein regulaer ausgefilterter Kandidat ist KEIN Ausfall.
    expect(failedTargets([ordinaryExclusion])).toHaveLength(0);
  });

  it('faerbt die Meldung um, statt schlicht „Keine Treffer" zu behaupten', async () => {
    const args = parseArgs(["nichts-das-es-gibt"], queryCommand.spec.flags);
    const result = await engine.search(buildSearchRequest(args, WORKSPACE, "nichts-das-es-gibt"));
    const broken = {
      ...result,
      totalHits: 0,
      groups: [],
      skipped: [
        {
          schemaVersion: 1 as const,
          stage: "search" as const,
          subjectKind: "search_candidate" as const,
          subjectId: "profile-abc",
          reason: "provider_unavailable" as const,
          detail: "collection did not answer",
          recoverable: true,
        },
      ],
    };
    const io = new BufferIo();
    renderSearch(contextWith(io), broken, "text", false);
    expect(io.errText).toContain("search was also incomplete");
  });
});

describe("begruendete Abwesenheitsaussage", () => {
  it("unterscheidet unzureichende Evidenz von einer gewoehnlich leeren Treffermenge", async () => {
    const observed = await engine.search({ query: "Blockchain-Signatur", limit: 10 });
    const empty = {
      ...observed,
      groups: [],
      totalHits: 0,
      skipped: [],
      warnings: [
        {
          code: NO_SUFFICIENT_MATCH_WARNING_CODE,
          message: "nichts hinreichend Passendes gefunden",
        },
      ],
    };
    const io = new BufferIo();
    renderSearch(contextWith(io), empty, "text", false);
    expect(io.errText).toContain("No sufficiently relevant results found.");
    expect(io.errText).not.toContain("No results.");
  });
});

describe("Enthaltung bleibt sichtbar, auch wenn Treffer stehenbleiben", () => {
  it("meldet die Enthaltung unabhaengig von der Trefferzahl", async () => {
    // Der Kern: frueher stand diese Meldung nur in `if (totalHits === 0)`.
    // Sobald Treffer trotz Ablehnung stehenbleiben, haette das CLI eine
    // selbstbewusst aussehende Liste ohne jeden Hinweis gedruckt.
    const io = new BufferIo();
    renderSearch(
      contextWith(io),
      {
        schemaVersion: 1,
        queryFingerprint: "f",
        rankingContextFingerprint: "r",
        query: { text: "x" },
        skipped: [],
        totalHits: 3,
        profileSeparation: false,
        groups: [
          {
            embeddingProfileId: "p1",
            repoIds: ["repo-1"],
            hits: [],
            rankNormalized: false,
            caveats: ['candidate rejected by relevance policy "test/x": top dense 0.5'],
            relevanceDecision: {
              abstention: "evidence",
              status: "rejected",
              basis: "insufficient_evidence",
              calibrationId: "test/x",
            },
          },
        ],
        warnings: [{ code: "NO_SUFFICIENT_MATCH", message: "nichts hinreichend Passendes" }],
      } as never,
      "text",
      false,
    );
    expect(io.errText).toContain("No sufficiently relevant results found.");
  });

  it("druckt den Vorbehalt auch ohne Profiltrennung", async () => {
    // `profileSeparation` ist im ausgelieferten CLI nie wahr — der Vorbehalt
    // mit den drei gemessenen Werten war damit unsichtbar.
    const io = new BufferIo();
    renderSearch(
      contextWith(io),
      {
        schemaVersion: 1,
        queryFingerprint: "f",
        rankingContextFingerprint: "r",
        query: { text: "x" },
        skipped: [],
        totalHits: 1,
        profileSeparation: false,
        groups: [
          {
            embeddingProfileId: "p1",
            repoIds: ["repo-1"],
            hits: [],
            rankNormalized: false,
            caveats: ["MESSWERT-VORBEHALT"],
          },
        ],
        warnings: [],
      } as never,
      "text",
      false,
    );
    expect(io.errText).toContain("MESSWERT-VORBEHALT");
  });
});
