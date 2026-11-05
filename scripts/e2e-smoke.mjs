#!/usr/bin/env node
/**
 * End-to-end smoke test across the seams that review found broken across
 * Wave-0 and Wave-1: parser-registry -> chunker (region contract, lossless
 * coverage, spec.md §8.5 symbol_fragment identity, spec.md §8.4 truthful
 * ledger) and parser-registry -> complexity (ComplexityIRNode producer,
 * cognitive invariant), plus scanner's binary/encoding classification
 * (spec.md E4: no silent content loss). Runs against a REAL TypeScript file
 * from this repository (packages/complexity/src/cognitive.ts) through the
 * REAL adapters for the baseline seam — no mocks, no hand-built region/IR
 * trees — and additionally against small REAL-adapter-parsed synthetic
 * sources that specifically exercise the three Wave-1 defect paths that
 * cognitive.ts alone never touches (it has no property groups, no
 * in-body comment ahead of the first member, and no UTF-16 content):
 *
 *   c) a class with several properties at a small token budget, asserting
 *      no `symbol_fragment` chunk is ever emitted without `symbolId`
 *      (spec.md §8.5 MUSS);
 *   d) a class with an ordinary comment between the opening brace and the
 *      first member, asserting that comment text surfaces in a real chunk's
 *      content OR as a documented "excluded" ledger entry with a reason —
 *      never silently masked behind the synthesized class_overview
 *      (spec.md §8.4, docs/BUILD_PLAN.md E4);
 *   e) a UTF-16LE and a UTF-16BE sample of plain text with NO byte-order
 *      mark, asserting `classifyBinarySample` reports `isBinary === false`
 *      instead of discarding real source text as binary (docs/BUILD_PLAN.md
 *      E4).
 *
 * WAVE-2 ADDITIONS (docs/BUILD_PLAN.md §12 order, "sechs Defektpfade dieser
 * Welle"): six further checks, one per adversarially-found-and-repaired
 * defect, each against the REAL built dist of the owning package (imported
 * by absolute dist path for packages the root workspace does not declare as
 * a devDependency — see `importDist` below) — never a fake/mock of the
 * fixed code itself, and never the project's own contract-test fakes (those
 * are already exercised by the "contract suites" step further down):
 *
 *   a) WP-76 — a 20000-clause Python `elif` chain must either parse
 *      correctly (every decision point accounted for) OR honestly report a
 *      non-"complete" `parseQuality` with at least one diagnostic — NEVER
 *      "complete" with silently dropped decisions;
 *   b) WP-77 — two `QdrantGraphStore.writeShards()` calls racing to write
 *      the same logical shard must never BOTH report success while the
 *      shard ends up unreadable (silent total data loss);
 *   c) WP-78 — two concurrent `embedDocuments()` calls for the same text,
 *      and one batch containing duplicate texts, must never cause more
 *      backend `/api/embed` HTTP calls than there are distinct texts;
 *   d) WP-79 — a `BoundedQueue` fed one invalid (`Infinity`) item size must
 *      reject that push with a clear error (never fold it into the byte
 *      counter) and must keep enforcing its byte budget for every
 *      well-formed item pushed afterward;
 *   e) WP-80 — a lock lease `renew()` whose `record.json` write is torn
 *      (interrupted mid-write) must never let a concurrent `tryAcquire()`
 *      believe the lease is free — no double ownership of one lock;
 *   f) WP-81 — a SQL file whose last statement has no trailing `;`, and one
 *      whose two statements share a line, must both yield byte-disjoint,
 *      non-degenerate chunks — no invisible loss of either statement.
 *
 * WAVE-8 ADDITION:
 *
 *   h) the built graph-explorer package must turn a structural graph
 *      snapshot into byte-deterministic, source-free, CSP-locked HTML and
 *      atomically write exactly those bytes to disk. This is the package
 *      seam used by `untangle graph visualize`, not a copied renderer.
 *
 * Requires no external services: no Qdrant, no Ollama, no network. Pure
 * Node ESM against the already-built package dists (see root
 * package.json's "e2e:smoke" script, which this file backs).
 *
 * Exits non-zero (and prints which assertion failed, naming the violated
 * invariant) on any violation, so it can gate CI the same way the test
 * suites do.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chunkFile } from "@untangle-code/chunker";
import { buildSymbolIR, computeCognitive } from "@untangle-code/complexity";
import { sha256Hex, validateCoverage } from "@untangle-code/domain";
import { createPythonAdapter, createTypeScriptAdapter } from "@untangle-code/parser-registry";
import { classifyBinarySample, discoverFiles } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import {
  GatedQdrantTransport,
  MiniQdrantTransport,
} from "./e2e-smoke-fixtures/mini-qdrant-transport.mjs";

const ALGORITHM = "untangle-cognitive-v1";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET_FILE = "packages/complexity/src/cognitive.ts";
const absolutePath = path.join(REPO_ROOT, TARGET_FILE);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

/**
 * Imports a package's built dist by absolute path, for the (non-root-
 * devDependency) packages the Wave-2 defect checks below exercise —
 * `storage-qdrant`, `embeddings-ollama`, `jobs`, `storage-local` and
 * `context-artifacts` are not resolvable as bare specifiers from this
 * script (only `chunker`/`complexity`/`domain`/`parser-registry`/`scanner`
 * are root devDependencies), so this loads the REAL built dist file
 * directly by path instead — never a mock of the fixed code.
 */
function importDist(relativeDistPath) {
  return import(pathToFileURL(path.join(REPO_ROOT, relativeDistPath)).href);
}

function fileRangeOf(content) {
  return {
    startLine: 1,
    endLine: content.split("\n").length,
    startByte: 0,
    endByte: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * Parses `content` with a REAL parser-registry adapter and runs it through
 * the REAL chunker, exactly like the baseline seam above but for small
 * synthetic sources built to exercise one specific defect path. `filePath`
 * only needs to be a plausible relative path; it is never read from disk.
 * `languageId`/`adapter` default to TypeScript for the existing Wave-1
 * defect fixtures below; the Python seam passes its own adapter/languageId.
 */
function chunkSyntheticSource(
  content,
  filePath,
  maxTokensPerChunk,
  { adapter = createTypeScriptAdapter(), languageId = "typescript" } = {},
) {
  const source = {
    fileId: `file-e2e-smoke-${filePath}`,
    repoId: "repo-e2e-smoke",
    refId: "repo-e2e-smoke:main",
    path: filePath,
    languageId,
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const parseResult = adapter.parse(source);
  assert(
    parseResult.parseQuality === "complete",
    `[${filePath}] parse quality was "${parseResult.parseQuality}", expected "complete"`,
  );
  const regions = parseResult.ast === null ? [] : adapter.extractChunks(parseResult.ast);
  const symbols = parseResult.ast === null ? [] : adapter.extractSymbols(parseResult.ast);
  const calls = parseResult.ast === null ? [] : adapter.extractCalls(parseResult.ast);
  const facts = parseResult.ast === null ? null : adapter.computeComplexity(parseResult.ast);
  const chunkResult = chunkFile({
    identity: {
      workspaceId: "ws-e2e-smoke",
      repoId: source.repoId,
      refId: source.refId,
      fileId: source.fileId,
      filePath,
      languageId,
    },
    content,
    parseResult,
    regions,
    symbols,
    config: {
      preparedText: {
        documentPrefix: "search_document:",
        repoLabel: "untangle",
        refName: "main",
      },
      maxTokensPerChunk,
    },
  });
  return { parseResult, regions, symbols, calls, facts, chunkResult };
}

// =============================================================================
// Wave-2 defect checks (a)-(f) — see the file header for the six invariants.
// =============================================================================

/**
 * (a) WP-76 — a pathologically deep Python `elif` chain (the auditor's own
 * 20000-clause reproduction shape) must never produce the false-success
 * class of defect: `parseQuality: "complete"` while silently discarding
 * decision points. Either outcome below is acceptable; a "complete" result
 * that under-counts decisions, or an aborted result with zero diagnostics,
 * is not.
 */
async function checkPythonElifHonesty(rows) {
  const CLAUSE_COUNT = 20000;
  const lines = ["def dispatch(code):", "    if code == 0:", "        return 'ok'"];
  for (let i = 1; i < CLAUSE_COUNT; i += 1) {
    lines.push(`    elif code == ${i}:`);
    lines.push(`        return 'code_${i}'`);
  }
  lines.push("    else:", "        return 'unknown'");
  const content = `${lines.join("\n")}\n`;

  const pythonAdapter = createPythonAdapter();
  const source = {
    fileId: "file-e2e-smoke-elif",
    repoId: "repo-e2e-smoke",
    refId: "repo-e2e-smoke:main",
    path: "e2e-smoke/dispatch.py",
    languageId: "python",
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const parseResult = pythonAdapter.parse(source);

  if (parseResult.parseQuality === "complete") {
    assert(
      parseResult.ast !== null,
      'WP-76 VIOLATED: parseQuality="complete" but the AST is null for a 20000-clause elif chain',
    );
    assert(
      parseResult.diagnostics.length === 0,
      `WP-76 VIOLATED: parseQuality="complete" but ${parseResult.diagnostics.length} diagnostic(s) were recorded — "complete" must mean complete`,
    );
    const facts = pythonAdapter.computeComplexity(parseResult.ast);
    assert(
      facts.decisions.length === CLAUSE_COUNT,
      `WP-76 VIOLATED (false success): parseQuality="complete" but only ${facts.decisions.length} of the ${CLAUSE_COUNT} if/elif decision points were recorded — a stack-overflow-then-swallowed-error would look exactly like this`,
    );
    rows.push(["defect a (python elif)", "outcome", "parsed correctly (complete)"]);
    rows.push(["defect a (python elif)", "decisions recorded", String(facts.decisions.length)]);
  } else {
    assert(
      parseResult.diagnostics.length > 0,
      `WP-76 VIOLATED (E4): parseQuality="${parseResult.parseQuality}" but 0 diagnostics were recorded — an aborted parse must always say why`,
    );
    rows.push([
      "defect a (python elif)",
      "outcome",
      `honestly reported "${parseResult.parseQuality}"`,
    ]);
    rows.push([
      "defect a (python elif)",
      "diagnostics recorded",
      String(parseResult.diagnostics.length),
    ]);
  }
}

/**
 * (g) WP-115 — the SAME honesty class as (a), on the f-string sub-parse
 * path: content that the embedded-expression parse discards must never be
 * reported as `parseQuality: "complete"`. The auditor's reproduction is a
 * nesting depth INSIDE an f-string expression that exceeds
 * `DEFAULT_MAX_PARSE_DEPTH` — `tryParseSubExpression` used to return `null`
 * with no path feeding the failure into `parser.diagnostics`.
 *
 * Two halves, both required: every loss case must be reported, and every
 * VALID f-string form must stay `"complete"` (a fix that just floods
 * diagnostics would trade one dishonesty for another).
 */
async function checkPythonFStringHonesty(rows) {
  const pythonAdapter = createPythonAdapter();
  const parseSource = (name, content) =>
    pythonAdapter.parse({
      fileId: `file-e2e-smoke-${name}`,
      repoId: "repo-e2e-smoke",
      refId: "repo-e2e-smoke:main",
      path: `e2e-smoke/${name}.py`,
      languageId: "python",
      content,
      contentHash: sha256Hex(content),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });

  // WP-115 NACH DER ABLOESUNG DES HANDGESCHRIEBENEN PARSERS (Welle 7b):
  //
  // Die urspruengliche Invariante lautete NIE "tiefe Verschachtelung muss ein
  // Diagnostic erzeugen", sondern "Inhalt darf nicht still verlorengehen". Beim
  // alten Parser war ein Diagnostic der einzige Weg, sie zu erfuellen: sein
  // DEFAULT_MAX_PARSE_DEPTH verwarf den Teilbaum, und `tryParseSubExpression`
  // gab `null` zurueck, ohne den Fehlschlag in die Diagnostics zu speisen.
  //
  // Die Grammatik hinter dem neuen Adapter hat diese Tiefengrenze nicht. Sie
  // VERLIERT den Inhalt gar nicht erst — belegt unten mit der Gegenprobe, die
  // die Bedingung mitten in 5.000 Klammerebenen noch zaehlt. Deshalb ist
  // `parseQuality: "complete"` dort jetzt die WAHRE Aussage, und die Pruefung
  // wird an der Invariante ausgerichtet statt an ihrem frueheren Symptom.
  //
  // Zwei Haelften, beide noetig: kaputte Eingabe MUSS gemeldet werden, und
  // tiefe, aber GUELTIGE Eingabe muss ihren Inhalt behalten.
  const lossCases = [
    ["broken-expr", 'y = f"{1 +}"\n'],
    ["unterminated-brace", 'y = f"{foo(bar"\n'],
    ["trailing-input", 'y = f"{a b}"\n'],
  ];
  for (const [name, content] of lossCases) {
    const result = parseSource(name, content);
    assert(
      result.parseQuality !== "complete",
      `WP-115 VIOLATED (false success): "${name}" discarded f-string content but reported parseQuality="complete"`,
    );
    assert(
      result.diagnostics.length > 0,
      `WP-115 VIOLATED (E4): "${name}" reported parseQuality="${result.parseQuality}" with 0 diagnostics — a discarded sub-parse must always say why`,
    );
  }
  rows.push([
    "defect g (python f-string)",
    "loss cases reported honestly",
    `${lossCases.length}/${lossCases.length}`,
  ]);

  // DIE GEGENPROBE ZUR TIEFE: was frueher verworfen wurde, muss heute ANKOMMEN.
  // Eine Bedingung mitten in N Klammerebenen ist genau ein Entscheidungspunkt.
  // Wird sie bei Tiefe 5.000 noch gezaehlt, ist nichts verlorengegangen — und
  // nur dann darf "complete" behauptet werden.
  const deepDepths = [1, 100, 1000, 5000];
  for (const depth of deepDepths) {
    const content = `y = f"{${"(".repeat(depth)}1 if x else 2${")".repeat(depth)}}"\n`;
    const deep = parseSource(`deep-${depth}`, content);
    assert(
      deep.parseQuality === "complete" && deep.diagnostics.length === 0,
      `WP-115: valid nesting at depth ${depth} was reported as "${deep.parseQuality}" with ${deep.diagnostics.length} diagnostic(s)`,
    );
    const facts = pythonAdapter.computeComplexity(deep.ast);
    const decisions = facts.decisions ?? facts.decisionFacts ?? [];
    assert(
      decisions.length === 1,
      `WP-115 VIOLATED (silent loss): the condition at depth ${depth} ergab ${decisions.length} decisions instead of 1; content did not reach the AST despite a "complete" result`,
    );
  }
  rows.push([
    "defect g (python f-string)",
    "deep nesting keeps its content",
    `${deepDepths.length}/${deepDepths.length}`,
  ]);

  const validForms = [
    'y = f"{x}"\n',
    'y = f"{x!r}"\n',
    'y = f"{x:>{width}}"\n',
    'y = f"{x=}"\n',
    'y = f"{ x = }"\n',
    'y = f"{ {k: v for k, v in d.items()} }"\n',
    "y = f\"{'{}'.format(x)}\"\n",
    'y = f"{n:0{width}d}"\n',
  ];
  for (const content of validForms) {
    const result = parseSource("valid", content);
    assert(
      result.parseQuality === "complete" && result.diagnostics.length === 0,
      `WP-115 OVERSHOT: valid f-string ${JSON.stringify(content)} was reported as "${result.parseQuality}" with ${result.diagnostics.length} diagnostic(s)`,
    );
  }
  rows.push([
    "defect g (python f-string)",
    "valid forms still complete",
    `${validForms.length}/${validForms.length}`,
  ]);

  // The content recovered by the fix must actually reach the AST: a call
  // inside a NESTED format spec was previously lost without a trace.
  const nested = parseSource("nested-spec", 'y = f"{value:>{compute(w)}}"\n');
  assert(
    nested.parseQuality === "complete" && nested.ast !== null,
    "WP-115: a valid nested format spec must parse cleanly",
  );
  const nestedCalls = pythonAdapter.extractCalls(nested.ast).map((c) => c.calleeName);
  assert(
    nestedCalls.length === 1 && nestedCalls[0] === "compute",
    `WP-115: the call inside the nested format spec is still invisible (got ${JSON.stringify(nestedCalls)})`,
  );
  rows.push(["defect g (python f-string)", "call in nested format spec", nestedCalls.join(",")]);
}

/**
 * (b) WP-77 — two `QdrantGraphStore.writeShards()` calls for the SAME
 * logical shard, deterministically interleaved (via a gating fake
 * transport, `GatedQdrantTransport`) so both writers' upserts land before
 * either one's cleanup runs — the exact interleaving that used to let two
 * concurrent writers annihilate each other's parts while both reported
 * success. Mandated invariant: a complete shard is readable afterward OR
 * at least one writer reported an error — never two silent successes over
 * a vanished shard.
 */
async function checkGraphStoreConcurrentWriteShard(rows) {
  const { QdrantVectorStore, QdrantGraphStore } = await importDist(
    "packages/storage-qdrant/dist/index.js",
  );

  const server = new MiniQdrantTransport();
  const holds = [];
  const take = (writer, kind) => {
    const i = holds.findIndex((h) => h.writer === writer && h.kind === kind);
    assert(i >= 0, `WP-77 harness error: no parked "${kind}" request for writer "${writer}"`);
    return holds.splice(i, 1)[0];
  };
  const waitFor = async (condition, what) => {
    for (let i = 0; i < 2000; i += 1) {
      if (condition()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`WP-77 harness timed out waiting for ${what}`);
  };
  const storeFor = (writer, frozenEpochMs) =>
    new QdrantGraphStore({
      vectorStore: new QdrantVectorStore({
        transport: new GatedQdrantTransport(server, writer, holds),
        maxRetries: 0,
        retryDelayMs: 0,
      }),
      clock: { nowEpochMs: () => frozenEpochMs },
      collectionPrefix: "e2e_smoke_",
    });
  const shardOf = (writeId, payload) => ({
    logicalShardId: "file:concurrent.ts",
    collection: "graph_files",
    generationId: "gen-e2e-smoke",
    writeId,
    payload,
  });

  const writeOlder = storeFor("older", 1000).writeShards([
    shardOf("write-older", { deps: ["m1", "m2"] }),
  ]);
  const writeNewer = storeFor("newer", 2000).writeShards([
    shardOf("write-newer", { deps: ["n1"] }),
  ]);
  writeOlder.catch(() => undefined);
  writeNewer.catch(() => undefined);

  await waitFor(
    () => holds.filter((h) => h.kind === "delete").length === 2,
    "both writers' upserts to complete",
  );
  take("older", "delete").release();
  await waitFor(
    () => holds.some((h) => h.writer === "older" && h.kind === "count"),
    "the older writer's cleanup",
  );
  take("newer", "delete").release();
  await waitFor(
    () => holds.some((h) => h.writer === "newer" && h.kind === "count"),
    "the newer writer's cleanup",
  );
  take("older", "count").release();
  take("newer", "count").release();

  const [resultOlder, resultNewer] = await Promise.allSettled([writeOlder, writeNewer]);

  const reader = new QdrantGraphStore({
    vectorStore: new QdrantVectorStore({ transport: server, maxRetries: 0, retryDelayMs: 0 }),
    clock: { nowEpochMs: () => 9000 },
    collectionPrefix: "e2e_smoke_",
  });
  let read = null;
  try {
    read = await reader.readShard("graph_files", "file:concurrent.ts");
  } catch {
    read = null; // an honest thrown error also counts as "not silently lost"
  }

  const bothSucceeded = resultOlder.status === "fulfilled" && resultNewer.status === "fulfilled";
  const atLeastOneErrored = resultOlder.status === "rejected" || resultNewer.status === "rejected";
  assert(
    !(bothSucceeded && read === null),
    "WP-77 VIOLATED: both concurrent writeShards() calls reported success, yet the shard is unreadable afterward — silent total data loss under a concurrent write race",
  );
  assert(
    read !== null || atLeastOneErrored,
    "WP-77 VIOLATED: the shard is unreadable and NEITHER writer reported an error — a write must never vanish without a loud failure",
  );
  rows.push(["defect b (writeShard race)", "older writer", resultOlder.status]);
  rows.push(["defect b (writeShard race)", "newer writer", resultNewer.status]);
  rows.push(["defect b (writeShard race)", "shard readable after race", String(read !== null)]);
}

/**
 * (c) WP-78 — (i) two CONCURRENT `embedDocuments()` calls for the identical
 * text must join one shared in-flight fetch rather than each starting their
 * own, and (ii) duplicate texts WITHIN one batch must be deduplicated
 * before hitting the backend. Both are checked against a fake
 * `fetchImpl` counting real `/api/embed` HTTP calls — never mocking
 * `embedDocuments` itself.
 */
async function checkEmbeddingDeduplication(rows) {
  const { OllamaEmbeddingProvider } = await importDist(
    "packages/embeddings-ollama/dist/provider.js",
  );

  function makeFakeOllamaFetch(dimensions) {
    const embedCalls = [];
    const fetchImpl = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const requestPath = url.pathname.replace(/^\//, "");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (requestPath === "api/tags" && method === "GET") {
        return new Response(JSON.stringify({ models: [{ name: "e2e-smoke-embed:latest" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (requestPath === "api/embed" && method === "POST") {
        const texts = body?.input ?? [];
        embedCalls.push(texts);
        // Simulated network latency: without in-flight dedup, two
        // concurrent callers would both observe "not cached yet" during
        // this window and each fire their own HTTP call.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(
          JSON.stringify({
            model: body?.model,
            embeddings: texts.map(() => new Array(dimensions).fill(0)),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    return { fetchImpl, embedCalls };
  }

  function makeProvider(fetchImpl) {
    return new OllamaEmbeddingProvider(
      {
        profile: {
          provider: "ollama",
          model: "e2e-smoke-embed",
          dimensions: 4,
          queryPrefix: "search_query: ",
          documentPrefix: "search_document: ",
          includePath: true,
          normalization: "none",
          preparedTextVersion: "v1",
        },
        mode: "external",
        url: "http://e2e-smoke-fake-ollama.invalid",
        contextLength: 2048,
        batchSize: 10,
        maxConnections: 4,
        requestTimeoutMs: 5000,
        maxRetries: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
      },
      {
        // Only `nowIso()` (readiness.ts) and `random.nextFloat()` (backoff.ts,
        // never actually exercised since the fake fetch never fails) are
        // read by the code paths this check drives.
        clock: { nowIso: () => new Date().toISOString() },
        random: { nextFloat: () => 0.5 },
        fetchImpl,
      },
    );
  }

  // (i) Two concurrent calls for the same text.
  {
    const { fetchImpl, embedCalls } = makeFakeOllamaFetch(4);
    const provider = makeProvider(fetchImpl);
    const text = "the quick brown fox (e2e-smoke concurrency case)";
    await Promise.all([provider.embedDocuments([text]), provider.embedDocuments([text])]);
    const realEmbedCalls = embedCalls.filter(
      (texts) => !texts.includes("untangle embedding readiness probe"),
    );
    assert(
      realEmbedCalls.length === 1,
      `WP-78 VIOLATED (concurrent dedup): 2 concurrent embedDocuments() calls for the identical text produced ${realEmbedCalls.length} real /api/embed call(s), expected exactly 1 (the second should join the first's in-flight fetch)`,
    );
    rows.push([
      "defect c (embed dedup)",
      "concurrent-call /api/embed calls",
      String(realEmbedCalls.length),
    ]);
  }

  // (ii) One batch containing the same text three times plus one unique text.
  {
    const { fetchImpl, embedCalls } = makeFakeOllamaFetch(4);
    const provider = makeProvider(fetchImpl);
    await provider.embedDocuments(["dup text", "dup text", "dup text", "unique text"]);
    const realEmbedCalls = embedCalls.filter(
      (texts) => !texts.includes("untangle embedding readiness probe"),
    );
    const totalTextsSent = realEmbedCalls.flat().length;
    assert(
      totalTextsSent === 2,
      `WP-78 VIOLATED (batch-internal dedup): embedDocuments() with 3 duplicate + 1 unique text sent ${totalTextsSent} text(s) to the backend, expected exactly 2 (the 3 duplicates collapsed to 1)`,
    );
    rows.push([
      "defect c (embed dedup)",
      "batch-internal texts sent to backend",
      String(totalTextsSent),
    ]);
  }
}

/**
 * (d) WP-79 — `BoundedQueue` fed a single item with an `Infinity` byte size
 * (a plausible upstream bug: bad Content-Length, overflowed byte-length
 * math). Must reject that push outright (never fold it into the running
 * `bytes` counter) and must keep enforcing the byte budget for every
 * normal item pushed afterward — the old defect corrupted `bytes` to `NaN`,
 * permanently disabling backpressure.
 */
async function checkBoundedQueueInvalidSize(rows) {
  const { BoundedQueue } = await importDist("packages/jobs/dist/bounded-queue.js");

  const MAX_BYTES = 1000;
  const ITEM_SIZE = 200; // divides MAX_BYTES evenly — see the drain loop below
  const queue = new BoundedQueue({
    capacity: 1000,
    maxBytes: MAX_BYTES,
    sizeOf: (item) => item.size,
  });

  let rejected = false;
  try {
    await queue.push({ id: "poison", size: Infinity });
  } catch (error) {
    rejected = error?.code === "INDEX_INCOMPLETE" && error?.retryable === false;
  }
  assert(
    rejected,
    "WP-79 VIOLATED: pushing an Infinity-sized item did not reject with a clear INDEX_INCOMPLETE error — an invalid size must never be silently folded into the byte budget",
  );
  const statsAfterReject = queue.stats();
  assert(
    statsAfterReject.depth === 0 && statsAfterReject.bytes === 0,
    `WP-79 VIOLATED: a rejected invalid-size push left the queue non-empty (depth=${statsAfterReject.depth}, bytes=${statsAfterReject.bytes}) — a rejected push must have zero side effects`,
  );

  const TOTAL_ITEMS = 50; // 50 * 200B = 10000B, 10x MAX_BYTES
  let pushedCount = 0;
  const pushLoop = (async () => {
    for (let i = 0; i < TOTAL_ITEMS; i += 1) {
      await queue.push({ id: `normal-${i}`, size: ITEM_SIZE });
      pushedCount += 1;
    }
  })();
  await Promise.race([pushLoop, new Promise((resolve) => setTimeout(resolve, 300))]);
  assert(
    pushedCount < TOTAL_ITEMS,
    `WP-79 VIOLATED (backpressure defeated): all ${TOTAL_ITEMS} × ${ITEM_SIZE}B items were admitted within 300ms despite a ${MAX_BYTES}B budget — the poisoned push must not have disabled the byte counter`,
  );
  rows.push(["defect d (bounded queue)", "invalid size rejected cleanly", String(rejected)]);
  rows.push([
    "defect d (bounded queue)",
    `${ITEM_SIZE}B items admitted within 300ms`,
    `${pushedCount}/${TOTAL_ITEMS}`,
  ]);

  // Drain so the still-pending push() calls (parked on backpressure) settle
  // instead of leaking a dangling promise past this function's return.
  // Safe without a timeout: `bytes` oscillates around MAX_BYTES the whole
  // time (ITEM_SIZE divides MAX_BYTES evenly), so the queue is never truly
  // empty until `pushLoop` itself has already settled.
  let pushLoopSettled = false;
  pushLoop.then(
    () => (pushLoopSettled = true),
    () => (pushLoopSettled = true),
  );
  while (!pushLoopSettled) {
    await queue.pull();
  }
  await pushLoop;
}

/**
 * (e) WP-80 — a lock lease `renew()` whose `record.json` write is torn
 * (interrupted mid-write, then completed) must never let a concurrent
 * `tryAcquire()` for the same key believe the lease is free. Uses a
 * `FileSystemPort` double that always writes any `*.tmp` path in two
 * separate steps with a delay between them — exercising the exact window a
 * non-atomic write would expose — against the REAL `FileLockProvider`.
 */
async function checkLockTornWriteNoDoubleOwnership(rows) {
  const { FileLockProvider } = await importDist("packages/storage-local/dist/lock-provider.js");

  function isNotFound(error) {
    return typeof error === "object" && error !== null && error.code === "ENOENT";
  }

  class RawNodeFileSystem {
    async stat(p) {
      try {
        const s = await stat(p);
        return {
          path: p,
          sizeBytes: s.size,
          mtimeEpochMs: Math.trunc(s.mtimeMs),
          kind: s.isDirectory() ? "directory" : "file",
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    }
    async lstat(p) {
      return this.stat(p);
    }
    async readFile(p) {
      return new Uint8Array(await readFile(p));
    }
    async readTextFile(p) {
      return readFile(p, "utf8");
    }
    async readDir() {
      throw new Error("e2e-smoke RawNodeFileSystem: readDir not implemented");
    }
    async realPath(p) {
      return p;
    }
    async writeFile(p, data) {
      await writeFile(p, data);
    }
    async mkdir(p, options) {
      await mkdir(p, { recursive: options?.recursive ?? false });
    }
    async rename(from, to) {
      await rename(from, to);
    }
    async remove(p, options) {
      await rm(p, { recursive: options?.recursive ?? false, force: true });
    }
  }

  // Writes any `*.tmp` path in two steps (half the bytes, then — after a
  // delay — the rest) without ever throwing: a non-atomic write that
  // eventually succeeds, the exact fault shape WP-80 fixed against.
  class TornThenCompleteFileSystem extends RawNodeFileSystem {
    armed = false;
    async writeFile(p, data) {
      if (this.armed && p.endsWith(".tmp")) {
        const half = data.subarray(0, Math.floor(data.length / 2));
        await super.writeFile(p, half);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await super.writeFile(p, data);
        return;
      }
      return super.writeFile(p, data);
    }
  }

  const clock = {
    // `FileLockProvider` genuinely needs real wall-clock time here — it is
    // the real adapter under test (torn writes vs. a real lease clock), not
    // domain/analysis logic, and has no injectable Clock port of its own to
    // wire a fake into. Same single documented exception as this repo's own
    // `@untangle-code/testkit` `SystemClock` (packages/testkit/src/in-memory/clock.ts).
    // eslint-disable-next-line no-restricted-syntax
    nowEpochMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
  // Only `random.uuid()` is called by FileLockProvider (processInstanceId,
  // temp-file suffix) — backed by Node's real `crypto.randomUUID()` rather
  // than `Math.random()`, so nothing here needs a lint exception.
  const random = {
    nextFloat: () => {
      throw new Error("e2e-smoke random.nextFloat() unused by FileLockProvider");
    },
    nextInt: () => {
      throw new Error("e2e-smoke random.nextInt() unused by FileLockProvider");
    },
    bytes: () => {
      throw new Error("e2e-smoke random.bytes() unused by FileLockProvider");
    },
    uuid: () => randomUUID(),
  };

  const base = await mkdtemp(path.join(os.tmpdir(), "untangle-e2e-smoke-wp80-"));
  try {
    const locksDir = path.join(base, "locks");
    const fsA = new TornThenCompleteFileSystem();
    const fsB = new RawNodeFileSystem();
    const providerA = new FileLockProvider(fsA, locksDir, clock, random, "e2e-smoke-host-a");
    const providerB = new FileLockProvider(fsB, locksDir, clock, random, "e2e-smoke-host-b");

    const handleA = await providerA.tryAcquire("repo:e2e-smoke:main:index", { leaseMs: 30000 });
    assert(handleA !== null, "WP-80 harness error: expected A to acquire the free lock");

    fsA.armed = true;
    const renewPromise = handleA.renew();
    renewPromise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30)); // mid-torn-write
    const handleB = await providerB.tryAcquire("repo:e2e-smoke:main:index", { leaseMs: 30000 });

    assert(
      handleB === null,
      "WP-80 VIOLATED: a concurrent tryAcquire() acquired the lock while the original holder's renew() was mid-write (torn write) — double ownership of one lock",
    );
    await renewPromise;
    rows.push([
      "defect e (torn lock write)",
      "concurrent tryAcquire() during torn renew()",
      "correctly refused (null)",
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/**
 * (f) WP-81 — a SQL file whose last statement has no trailing `;`, and a
 * SQL file with two statements sharing one physical line, must both yield
 * a real chunk for EVERY statement's bytes — no phantom/degenerate chunk
 * and no gap the skip ledger fails to flag.
 *
 * Also WP-118 — a backslash-escaped quote around a semicolon must not tear
 * one statement into two broken fragments, and a fragment that IS cut in
 * the middle of a construct must produce a visible finding even though
 * byte coverage is complete.
 */
async function checkSqlNoInvisibleLoss(rows) {
  const { createSqlAdapter } = await importDist("packages/context-artifacts/dist/adapters/sql.js");
  const { buildArtifactSkipLedger } = await importDist(
    "packages/context-artifacts/dist/coverage.js",
  );

  const artifactDoc = (content) => ({
    artifactName: "e2e-smoke",
    type: "sql",
    path: "e2e-smoke/schema.sql",
    contentHash: sha256Hex(content),
    content,
  });

  // Case 1: missing final semicolon.
  {
    const content = "CREATE TABLE foo (id int);\nCREATE TABLE bar (id int, name text)\n";
    const chunks = createSqlAdapter().chunk(artifactDoc(content));
    assert(
      chunks.length === 2,
      `WP-81 VIOLATED (missing trailing ';'): expected 2 chunks (foo, bar), got ${chunks.length} — the statement with no closing semicolon must not be dropped`,
    );
    assert(
      chunks.some((c) => c.content.includes("bar")) &&
        chunks.some((c) => c.content.includes("foo")),
      "WP-81 VIOLATED: the trailing, semicolon-less statement's content is missing from every chunk",
    );
    const ledger = buildArtifactSkipLedger(artifactDoc(content), chunks);
    assert(
      ledger.length === 0,
      `WP-81 VIOLATED: unexpected skip-ledger gap(s) for the semicolon-less-statement fixture: ${JSON.stringify(ledger)}`,
    );
    rows.push(["defect f (sql no trailing ;)", "chunks emitted", String(chunks.length)]);
  }

  // Case 2: two statements sharing one physical line.
  {
    const content = "CREATE TABLE foo (id int); CREATE TABLE bar (id int);\n";
    const chunks = createSqlAdapter().chunk(artifactDoc(content));
    assert(
      chunks.length === 2,
      `WP-81 VIOLATED (two statements/line): expected 2 chunks (foo, bar), got ${chunks.length}`,
    );
    const [first, second] = [...chunks].sort((a, b) => a.range.startByte - b.range.startByte);
    assert(
      first.range.endByte === second.range.startByte,
      `WP-81 VIOLATED: the two same-line statements' byte ranges are not disjoint/adjacent (first ends at ${first.range.endByte}, second starts at ${second.range.startByte}) — a degenerate/overlapping phantom chunk`,
    );
    assert(
      first.range.endByte > first.range.startByte && second.range.endByte > second.range.startByte,
      "WP-81 VIOLATED: a degenerate (empty or inverted) byte range chunk was produced for a same-line statement",
    );
    const ledger = buildArtifactSkipLedger(artifactDoc(content), chunks);
    assert(
      ledger.length === 0,
      `WP-81 VIOLATED: unexpected skip-ledger gap(s) for the two-statements-per-line fixture: ${JSON.stringify(ledger)}`,
    );
    rows.push(["defect f (sql two stmts/line)", "chunks emitted", String(chunks.length)]);
    rows.push(["defect f (sql two stmts/line)", "byte ranges disjoint", "true"]);
  }

  // Case 3 (WP-118): a backslash-escaped quote around a semicolon must not
  // tear ONE statement into two syntactically broken fragments.
  {
    const content = "INSERT INTO t VALUES ('it\\'s a test; nested clause', 2);\n";
    const chunks = createSqlAdapter().chunk(artifactDoc(content));
    assert(
      chunks.length === 1,
      `WP-118 VIOLATED: a backslash-escaped quote split one statement into ${chunks.length} fragments`,
    );
    assert(
      chunks[0].content === content,
      "WP-118 VIOLATED: the single statement's content is not byte-identical to the source",
    );
    rows.push(["WP-118 (sql backslash escape)", "chunks emitted", String(chunks.length)]);
  }

  // Case 4 (WP-118): the SAME input under the standard-SQL dialect MUST be
  // cut twice — and that mis-cut must be a VISIBLE finding, even though
  // byte coverage is complete and no chunk is empty or overlapping (which
  // is exactly why the old E4 mechanism reported nothing here).
  {
    const content = "INSERT INTO t VALUES ('it\\'s a test; nested clause', 2);\n";
    const findings = [];
    const chunks = createSqlAdapter({
      dialect: "doubled-quotes-only",
      onSkipLedgerGap: (entries) => findings.push(...entries),
    }).chunk(artifactDoc(content));
    assert(
      chunks.length === 2,
      `WP-118 fixture broken: expected 2 fragments, got ${chunks.length}`,
    );
    const ledger = buildArtifactSkipLedger(artifactDoc(content), chunks);
    assert(
      ledger.length === 0,
      `WP-118 fixture broken: byte coverage was expected to look complete, got ${JSON.stringify(ledger)}`,
    );
    assert(
      findings.length === 2 && findings.every((entry) => entry.reason === "implausible_fragment"),
      `WP-118 VIOLATED: a mis-cut statement produced no visible finding: ${JSON.stringify(findings)}`,
    );
    rows.push([
      "WP-118 (sql mis-cut visible)",
      "implausible_fragment findings",
      String(findings.length),
    ]);
  }
}

/**
 * (h) Wave 8 — exercise the REAL built graph-explorer distribution. The
 * fixture includes an adversarial label and unknown source-like fields so
 * this seam fails if a later refactor serializes arbitrary input objects or
 * moves user data out of the inert Base64 payload.
 */
async function checkGraphExplorerArtifact(rows) {
  const { createGraphExplorerHtml, writeGraphExplorerHtml } = await importDist(
    "packages/graph-explorer/dist/index.js",
  );
  const hostile = "</template><script>globalThis.pwned=true</script>";
  const sourceSentinel = "E2E_GRAPH_EXPLORER_MUST_NOT_SERIALIZE_SOURCE";
  const input = {
    workspace: {
      workspaceId: "ws-e2e-graph",
      generationId: "generation-e2e-graph",
      label: hostile,
      repositories: [{ repoId: "repo-b", label: "Repository B" }, { repoId: "repo-a" }],
    },
    fileGraph: {
      schemaVersion: 1,
      workspaceId: "ws-e2e-graph",
      graphGeneration: "generation-e2e-graph",
      nodes: [
        {
          fileId: "file-b",
          repoId: "repo-b",
          refId: "main",
          filePath: "src/b.ts",
          language: "typescript",
        },
        {
          fileId: "file-a",
          repoId: "repo-a",
          refId: "main",
          filePath: `src/${hostile}.ts`,
          language: "typescript",
          content: sourceSentinel,
        },
      ],
      edges: [
        {
          edgeId: "edge-a-b",
          repoId: "repo-a",
          refId: "main",
          fromFileId: "file-a",
          kind: "import",
          resolution: { status: "resolved", targetFileId: "file-b" },
          boundary: { crossRepo: true },
        },
      ],
    },
  };
  const options = { initialView: "symbol", initialLayout: "repository-lanes" };
  const first = createGraphExplorerHtml(input, options);
  const shuffled = {
    ...input,
    workspace: {
      ...input.workspace,
      repositories: [...input.workspace.repositories].reverse(),
    },
    fileGraph: {
      ...input.fileGraph,
      nodes: [...input.fileGraph.nodes].reverse(),
    },
  };
  const second = createGraphExplorerHtml(shuffled, options);

  assert(first.html === second.html, "Wave-8 graph explorer output is not byte-deterministic");
  assert(first.sha256 === sha256Hex(first.html), "Wave-8 graph explorer SHA-256 is not exact");
  assert(
    first.bytes === Buffer.byteLength(first.html, "utf8"),
    "Wave-8 graph explorer byte count is not exact",
  );
  assert(
    !first.html.includes(sourceSentinel),
    "Wave-8 graph explorer serialized an unknown source-content field",
  );
  assert(
    !first.html.includes(hostile),
    "Wave-8 graph explorer placed adversarial user data directly in markup",
  );
  assert(
    first.html.includes("default-src 'none'") && first.html.includes("connect-src 'none'"),
    "Wave-8 graph explorer is missing its offline CSP boundary",
  );
  assert(
    first.views.symbol === null,
    "Wave-8 graph explorer did not report the absent symbol view truthfully",
  );

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "untangle-e2e-smoke-graph-"));
  try {
    const outputPath = path.join(tmpRoot, "graph.html");
    const written = await writeGraphExplorerHtml(outputPath, input, options);
    const diskHtml = await readFile(outputPath, "utf8");
    assert(diskHtml === first.html, "Wave-8 graph explorer wrote different bytes than it returned");
    assert(
      written.sha256 === first.sha256,
      "Wave-8 graph explorer write result reports a different digest",
    );
    assert(
      ((await stat(outputPath)).mode & 0o777) === 0o600,
      "Wave-8 graph explorer did not use its private default file mode",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  rows.push(["Wave 8 graph explorer", "deterministic built artifact", "true"]);
  rows.push(["Wave 8 graph explorer", "source fields serialized", "0"]);
  rows.push(["Wave 8 graph explorer", "default file mode", "0600"]);
}

async function main() {
  const content = readFileSync(absolutePath, "utf8");
  const rows = [];

  // ---------------------------------------------------------------------
  // a) Parse via the REAL parser-registry TypeScript adapter.
  // ---------------------------------------------------------------------
  const adapter = createTypeScriptAdapter();
  const source = {
    fileId: "file-e2e-smoke",
    repoId: "repo-e2e-smoke",
    refId: "repo-e2e-smoke:main",
    path: TARGET_FILE,
    languageId: "typescript",
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const parseResult = adapter.parse(source);
  assert(
    parseResult.parseQuality === "complete",
    `parse quality was "${parseResult.parseQuality}", expected "complete"`,
  );
  assert(parseResult.ast !== null, "parse produced a null AST despite parseQuality=complete");
  rows.push(["parse", "parseQuality", parseResult.parseQuality]);
  rows.push(["parse", "errorNodeCount", String(parseResult.errorNodeCount)]);

  const regions = adapter.extractChunks(parseResult.ast);
  const symbols = adapter.extractSymbols(parseResult.ast);
  const calls = adapter.extractCalls(parseResult.ast);
  const facts = adapter.computeComplexity(parseResult.ast);

  // Region contract (domain analysis.ts doc comment): exactly ONE root
  // region of chunkKind "module" spanning the whole file.
  assert(regions.length === 1, `expected exactly one root region, got ${regions.length}`);
  assert(
    regions[0].chunkKind === "module",
    `expected root chunkKind "module", got "${regions[0].chunkKind}"`,
  );
  rows.push(["parse", "symbols extracted", String(symbols.length)]);

  // ---------------------------------------------------------------------
  // b) Chunk via the REAL chunker.
  // ---------------------------------------------------------------------
  const chunkResult = chunkFile({
    identity: {
      workspaceId: "ws-e2e-smoke",
      repoId: source.repoId,
      refId: source.refId,
      fileId: source.fileId,
      filePath: TARGET_FILE,
      languageId: "typescript",
    },
    content,
    parseResult,
    regions,
    symbols,
    config: {
      preparedText: {
        documentPrefix: "search_document:",
        repoLabel: "untangle",
        refName: "main",
      },
      maxTokensPerChunk: 2000,
    },
  });
  rows.push(["chunk", "strategy", chunkResult.strategy]);
  rows.push(["chunk", "drafts emitted", String(chunkResult.drafts.length)]);

  // ---------------------------------------------------------------------
  // c) At least one function/method chunk with a set symbolId.
  // ---------------------------------------------------------------------
  const namedFunctionOrMethodChunks = chunkResult.drafts.filter(
    (d) => (d.chunkKind === "function" || d.chunkKind === "method") && Boolean(d.symbolId),
  );
  assert(
    namedFunctionOrMethodChunks.length > 0,
    `expected >=1 function/method chunk with symbolId, found ${namedFunctionOrMethodChunks.length} among chunk kinds [${[...new Set(chunkResult.drafts.map((d) => d.chunkKind))].join(", ")}]`,
  );
  rows.push([
    "chunk",
    "function/method chunks with symbolId",
    String(namedFunctionOrMethodChunks.length),
  ]);
  rows.push(["chunk", "sample symbolFqn", namedFunctionOrMethodChunks[0].symbolFqn ?? "(none)"]);

  // ---------------------------------------------------------------------
  // d) Coverage invariant: lossless, no masked gap (spec.md §8.4).
  // ---------------------------------------------------------------------
  const coverageValidation = validateCoverage(chunkResult.coverage, fileRangeOf(content));
  assert(
    coverageValidation.issues.length === 0,
    `coverage validation reported issues: ${JSON.stringify(coverageValidation.issues)}`,
  );
  assert(
    coverageValidation.complete === true,
    "coverage validation reported complete=false (a byte range is neither chunked nor excluded)",
  );
  rows.push(["coverage", "complete", String(coverageValidation.complete)]);
  rows.push(["coverage", "issues", String(coverageValidation.issues.length)]);
  rows.push(["coverage", "gaps", String(coverageValidation.gaps.length)]);

  // ---------------------------------------------------------------------
  // e) Complexity via the REAL path: ComplexityFacts -> buildSymbolIR ->
  //    computeCognitive, for every symbol scope in the file. At least one
  //    scope must have cognitive value > 0, and for every scope the
  //    contribution-sum invariant must hold.
  // ---------------------------------------------------------------------
  assert(
    facts.symbolScopes.length > 0,
    "computeComplexity produced zero symbol scopes for a non-trivial file",
  );

  let maxCognitive = { name: "(none)", value: -1 };
  let anyPositive = false;
  for (const scope of facts.symbolScopes) {
    const root = buildSymbolIR(facts, scope.symbolScopeId, { calls });
    if (root === undefined) continue;
    const result = computeCognitive(root, ALGORITHM);
    const sum = result.contributions.reduce((s, c) => s + c.total, 0);
    assert(
      sum === result.value,
      `sum(contributions.total)=${sum} !== total=${result.value} for symbol "${scope.name}"`,
    );
    if (result.value > 0) anyPositive = true;
    if (result.value > maxCognitive.value) {
      const label = scope.qualifiedName || scope.name || `(${scope.kind} aggregate)`;
      maxCognitive = { name: label, value: result.value };
    }
  }
  assert(anyPositive, "no symbol scope in the file produced a cognitive value > 0");
  assert(maxCognitive.value > 0, "max cognitive value across all scopes was not > 0");
  rows.push(["complexity", "symbol scopes analyzed", String(facts.symbolScopes.length)]);
  rows.push(["complexity", "max cognitive symbol", maxCognitive.name]);
  rows.push(["complexity", "max cognitive value", String(maxCognitive.value)]);
  rows.push(["complexity", "sum(contributions)===total (all scopes)", "true"]);

  // ---------------------------------------------------------------------
  // g) Wave-1 Defekt 1 (spec.md §8.5 MUSS): a class with several properties
  //    at a SMALL token budget, forcing property_group over-budget pieces
  //    to split. Regression: split pieces without a resolvable class symbol
  //    used to become symbol_fragment chunks with NO symbolId.
  // ---------------------------------------------------------------------
  const propertyClassSource = `class UserProfile {
  id: string = "";
  firstName: string = "";
  lastName: string = "";
  emailAddress: string = "";
  createdAtTimestamp: number = 0;
  updatedAtTimestamp: number = 0;

  constructor(id: string, firstName: string, lastName: string) {
    this.id = id;
    this.firstName = firstName;
    this.lastName = lastName;
  }
}
`;
  const { chunkResult: propertyResult } = chunkSyntheticSource(
    propertyClassSource,
    "e2e-smoke/user-profile.ts",
    25,
  );
  const propertyFragments = propertyResult.drafts.filter((d) => d.chunkKind === "symbol_fragment");
  assert(
    propertyFragments.length > 0,
    "expected property-group over-budget split to produce >=1 symbol_fragment chunk, produced 0 " +
      `(chunk kinds: [${[...new Set(propertyResult.drafts.map((d) => d.chunkKind))].join(", ")}])`,
  );
  const propertyFragmentsMissingSymbolId = propertyFragments.filter(
    (d) => d.symbolId === undefined || d.symbolId === "",
  );
  assert(
    propertyFragmentsMissingSymbolId.length === 0,
    `spec.md §8.5 VIOLATED: ${propertyFragmentsMissingSymbolId.length} of ${propertyFragments.length} ` +
      "symbol_fragment chunk(s) from property-group splitting carry no symbolId " +
      `(example: ${JSON.stringify(propertyFragmentsMissingSymbolId[0])})`,
  );
  rows.push(["defect1 (props)", "symbol_fragment chunks", String(propertyFragments.length)]);
  rows.push([
    "defect1 (props)",
    "missing symbolId",
    String(propertyFragmentsMissingSymbolId.length),
  ]);

  // ---------------------------------------------------------------------
  // h) Wave-1 Defekt 2 (spec.md §8.4, docs/BUILD_PLAN.md E4): a class with
  //    an ordinary comment sitting between the opening brace and the first
  //    member. Regression: the synthesized class_overview's header-span
  //    coverage claim used to mask this comment's bytes without any real
  //    chunk or documented exclusion ever carrying them.
  // ---------------------------------------------------------------------
  const MARKER = "E2E_SMOKE_HEADER_COMMENT_MARKER";
  const commentClassSource = `export class Widget {
  // ${MARKER} an ordinary note nobody re-types into the overview

  render(): void {
    return;
  }
}
`;
  const { chunkResult: commentResult } = chunkSyntheticSource(
    commentClassSource,
    "e2e-smoke/widget.ts",
    800,
  );
  const markerInRealChunk = commentResult.drafts.some(
    (d) => d.synthesized !== true && d.content.includes(MARKER),
  );
  const markerBytes = Buffer.from(MARKER, "utf8");
  const sourceBytes = Buffer.from(commentClassSource, "utf8");
  const markerInExcludedLedger = commentResult.coverage.some((entry) => {
    if (entry.status !== "excluded") return false;
    const rangeBytes = sourceBytes.subarray(entry.range.startByte, entry.range.endByte);
    return (
      rangeBytes.indexOf(markerBytes) !== -1 &&
      typeof entry.exclusionReason === "string" &&
      entry.exclusionReason.length > 0
    );
  });
  assert(
    markerInRealChunk || markerInExcludedLedger,
    `spec.md §8.4 / E4 VIOLATED: header comment "${MARKER}" appears in no real chunk content and ` +
      "no documented excluded ledger entry — silently masked behind the synthesized class_overview",
  );
  const commentCoverageValidation = validateCoverage(
    commentResult.coverage,
    fileRangeOf(commentClassSource),
  );
  assert(
    commentCoverageValidation.complete === true,
    `header-comment fixture coverage incomplete: ${JSON.stringify(commentCoverageValidation.issues)}`,
  );
  rows.push(["defect2 (comment)", "marker in real chunk", String(markerInRealChunk)]);
  rows.push(["defect2 (comment)", "marker in excluded+reason", String(markerInExcludedLedger)]);

  // ---------------------------------------------------------------------
  // i) Wave-1 Defekt 3 (docs/BUILD_PLAN.md E4): BOM-less UTF-16LE and
  //    UTF-16BE plain text must NOT be classified as binary. Regression:
  //    every other byte is 0x00 for Basic-Latin text, and the raw
  //    NUL-byte rule alone used to discard such files as binary.
  // ---------------------------------------------------------------------
  const utf16Plaintext =
    "Hello, world! This is a normal UTF-16 text file with no byte-order mark at all.";
  const utf16leBytes = Buffer.from(utf16Plaintext, "utf16le");
  // Node has no native utf16be encoder: byte-swap the LE encoding pairwise.
  const utf16beBytes = Buffer.alloc(utf16leBytes.length);
  for (let i = 0; i + 1 < utf16leBytes.length; i += 2) {
    utf16beBytes[i] = utf16leBytes[i + 1];
    utf16beBytes[i + 1] = utf16leBytes[i];
  }
  const utf16leClassification = classifyBinarySample(new Uint8Array(utf16leBytes));
  const utf16beClassification = classifyBinarySample(new Uint8Array(utf16beBytes));
  assert(
    utf16leClassification.isBinary === false,
    `E4 VIOLATED: BOM-less UTF-16LE plain text classified isBinary=${utf16leClassification.isBinary} ` +
      `(expected false); full result: ${JSON.stringify(utf16leClassification)}`,
  );
  assert(
    utf16beClassification.isBinary === false,
    `E4 VIOLATED: BOM-less UTF-16BE plain text classified isBinary=${utf16beClassification.isBinary} ` +
      `(expected false); full result: ${JSON.stringify(utf16beClassification)}`,
  );
  rows.push(["defect3 (utf16)", "LE no-BOM isBinary", String(utf16leClassification.isBinary)]);
  rows.push(["defect3 (utf16)", "BE no-BOM isBinary", String(utf16beClassification.isBinary)]);

  // ---------------------------------------------------------------------
  // j) Wave-2 seam (WP-09): a real Python file through parser-registry ->
  //    chunker -> complexity, mirroring seam (a)-(e) above but for the
  //    Python LanguageAdapter. Asserts parseQuality=complete, at least one
  //    real chunk with a symbolId, and at least one symbol scope with
  //    cognitive value > 0 (same contribution-sum invariant as TypeScript).
  // ---------------------------------------------------------------------
  const pythonSource = `class OrderBook:
    def __init__(self):
        self.orders = []

    def add(self, order):
        if order not in self.orders:
            self.orders.append(order)


def process_orders(orders):
    total = 0
    for order in orders:
        if order.get("cancelled"):
            continue
        if order.get("amount", 0) > 0:
            for item in order.get("items", []):
                if item.get("discount"):
                    total += item["price"] * (1 - item["discount"])
                else:
                    total += item["price"]
    return total
`;
  const pythonAdapter = createPythonAdapter();
  const {
    parseResult: pythonParseResult,
    symbols: pythonSymbols,
    facts: pythonFacts,
    calls: pythonCalls,
    chunkResult: pythonChunkResult,
  } = chunkSyntheticSource(pythonSource, "e2e-smoke/orders.py", 2000, {
    adapter: pythonAdapter,
    languageId: "python",
  });
  assert(
    pythonParseResult.parseQuality === "complete",
    `Python parse quality was "${pythonParseResult.parseQuality}", expected "complete"`,
  );
  assert(pythonSymbols.length > 0, "Python adapter extracted zero symbols from a non-trivial file");
  const pythonChunksWithSymbolId = pythonChunkResult.drafts.filter((d) => Boolean(d.symbolId));
  assert(
    pythonChunksWithSymbolId.length > 0,
    "expected >=1 Python chunk with symbolId, found 0 among chunk kinds " +
      `[${[...new Set(pythonChunkResult.drafts.map((d) => d.chunkKind))].join(", ")}]`,
  );
  assert(
    pythonFacts !== null && pythonFacts.symbolScopes.length > 0,
    "computeComplexity produced zero symbol scopes for the Python file",
  );
  let pythonAnyPositive = false;
  let pythonMaxCognitive = { name: "(none)", value: -1 };
  for (const scope of pythonFacts.symbolScopes) {
    const root = buildSymbolIR(pythonFacts, scope.symbolScopeId, { calls: pythonCalls });
    if (root === undefined) continue;
    const result = computeCognitive(root, ALGORITHM);
    const sum = result.contributions.reduce((s, c) => s + c.total, 0);
    assert(
      sum === result.value,
      `[python] sum(contributions.total)=${sum} !== total=${result.value} for symbol "${scope.name}"`,
    );
    if (result.value > 0) pythonAnyPositive = true;
    if (result.value > pythonMaxCognitive.value) {
      const label = scope.qualifiedName || scope.name || `(${scope.kind} aggregate)`;
      pythonMaxCognitive = { name: label, value: result.value };
    }
  }
  assert(pythonAnyPositive, "no Python symbol scope produced a cognitive value > 0");
  rows.push(["python seam", "parseQuality", pythonParseResult.parseQuality]);
  rows.push(["python seam", "symbols extracted", String(pythonSymbols.length)]);
  rows.push(["python seam", "chunks with symbolId", String(pythonChunksWithSymbolId.length)]);
  rows.push(["python seam", "max cognitive symbol", pythonMaxCognitive.name]);
  rows.push(["python seam", "max cognitive value", String(pythonMaxCognitive.value)]);

  // ---------------------------------------------------------------------
  // k) WP-64 regression: an extensionless UTF-16LE (no BOM) script with a
  //    shebang must decode under its DETECTED encoding, not always UTF-8,
  //    so `detectLanguage`'s content sniff sees the real shebang text
  //    instead of mojibake and classifies the file correctly. Exercised
  //    through the REAL `discoverFiles` pipeline against a REAL temp
  //    directory via the REAL `NodeFileSystem` adapter — not a unit test
  //    of `detectLanguage` in isolation.
  // ---------------------------------------------------------------------
  {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "untangle-e2e-smoke-wp64-"));
    try {
      const shebangScript =
        "#!/usr/bin/env python3\nprint('hello from a UTF-16LE shebang script')\n";
      const utf16leScriptBytes = Buffer.from(shebangScript, "utf16le");
      await writeFile(path.join(tmpRoot, "extensionless-script"), utf16leScriptBytes);

      const fs = new NodeFileSystem();
      const discovered = [];
      for await (const file of discoverFiles({ fs, roots: [tmpRoot], repoRoot: tmpRoot })) {
        discovered.push(file);
      }
      assert(
        discovered.length === 1,
        `expected exactly 1 discovered file in the WP-64 fixture dir, found ${discovered.length}`,
      );
      const [scriptResult] = discovered;
      assert(
        scriptResult.encoding === "utf16le" && scriptResult.hasBom === false,
        `WP-64 fixture pre-condition failed: expected encoding=utf16le/hasBom=false, got ` +
          `encoding=${scriptResult.encoding}/hasBom=${scriptResult.hasBom}`,
      );
      assert(
        scriptResult.languageId === "python" && scriptResult.languageDetectedBy === "content",
        `WP-64 VIOLATED: extensionless BOM-less UTF-16LE shebang script classified as ` +
          `languageId=${scriptResult.languageId}/detectedBy=${scriptResult.languageDetectedBy}, ` +
          "expected languageId=python/detectedBy=content (mojibake from always-UTF-8 decoding " +
          "must not defeat the shebang sniff)",
      );
      rows.push(["WP-64 (utf16 shebang)", "encoding", scriptResult.encoding]);
      rows.push(["WP-64 (utf16 shebang)", "languageId", scriptResult.languageId]);
      rows.push(["WP-64 (utf16 shebang)", "detectedBy", scriptResult.languageDetectedBy]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------
  // l) Port-contract suites against the new Wave-1 adapters, run against
  //    their own fakes (FakeQdrantServer, an injected fake fetch, an
  //    in-memory-backed real filesystem/lock directory) — NOT re-invented
  //    here, but the actual test files each adapter wired
  //    `run*Contract(...)` into, executed for real via vitest as a
  //    subprocess so this smoke test's exit code reflects their result too.
  // ---------------------------------------------------------------------
  const vitestBin = path.join(REPO_ROOT, "node_modules", ".bin", "vitest");
  const contractSuiteRuns = [
    {
      label: "embeddings-ollama: runEmbeddingProviderContract",
      pkgDir: "packages/embeddings-ollama",
      testFile: "src/provider.test.ts",
    },
    {
      label:
        "storage-qdrant: runVectorStoreContract + runMetadataStoreContract + runGraphStoreContract",
      pkgDir: "packages/storage-qdrant",
      testFile: "src/contract.test.ts",
    },
    {
      label: "storage-local: runLockProviderContract",
      pkgDir: "packages/storage-local",
      testFile: "src/lock-provider.test.ts",
    },
    {
      label: "storage-local: runFileSystemContract",
      pkgDir: "packages/storage-local",
      testFile: "src/local-file-system.test.ts",
    },
  ];
  for (const { label, pkgDir, testFile } of contractSuiteRuns) {
    let output = "";
    let ok = true;
    try {
      output = execFileSync(vitestBin, ["run", testFile], {
        cwd: path.join(REPO_ROOT, pkgDir),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      ok = false;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert(ok, `contract suite FAILED — ${label} (${pkgDir}/${testFile}):\n${output}`);
    const summaryMatch = /Tests\s+(\d+)\s+passed/.exec(output);
    rows.push([
      "contract suites",
      label,
      summaryMatch ? `${summaryMatch[1]} passed` : "passed (count unparsed)",
    ]);
  }

  // ---------------------------------------------------------------------
  // m) Wave-2 defect checks (a)-(f) — see file header. Each runs against
  //    the REAL built dist of the owning package; a failure here throws
  //    (via `assert`) and aborts the whole run with a non-zero exit,
  //    naming exactly which invariant was violated.
  // ---------------------------------------------------------------------
  await checkPythonElifHonesty(rows);
  await checkGraphStoreConcurrentWriteShard(rows);
  await checkEmbeddingDeduplication(rows);
  await checkBoundedQueueInvalidSize(rows);
  await checkLockTornWriteNoDoubleOwnership(rows);
  await checkSqlNoInvisibleLoss(rows);
  await checkPythonFStringHonesty(rows);
  await checkGraphExplorerArtifact(rows);

  // ---------------------------------------------------------------------
  // n) Print a compact table.
  // ---------------------------------------------------------------------
  const widthStage = Math.max(...rows.map((r) => r[0].length), "stage".length);
  const widthMetric = Math.max(...rows.map((r) => r[1].length), "metric".length);
  const widthValue = Math.max(...rows.map((r) => r[2].length), "value".length);
  const line = (a, b, c) =>
    `| ${a.padEnd(widthStage)} | ${b.padEnd(widthMetric)} | ${c.padEnd(widthValue)} |`;
  const sep = `+${"-".repeat(widthStage + 2)}+${"-".repeat(widthMetric + 2)}+${"-".repeat(widthValue + 2)}+`;

  console.log(`\nE2E SMOKE: ${TARGET_FILE}\n`);
  console.log(sep);
  console.log(line("stage", "metric", "value"));
  console.log(sep);
  for (const [stage, metric, value] of rows) {
    console.log(line(stage, metric, value));
  }
  console.log(sep);
  console.log(
    "\nALL ASSERTIONS PASSED — parser-registry -> chunker -> complexity seam verified end to " +
      "end on a real repo file, PLUS the three Wave-1 defect paths (property-group symbolId, " +
      "class-header comment truthfulness, BOM-less UTF-16 detection) AND the six Wave-2 defect " +
      "paths (Python elif-chain honesty, concurrent writeShard() loss, embedding-cache " +
      "deduplication, BoundedQueue invalid-size backpressure, torn lock-write double-ownership, " +
      "SQL semicolon/same-line statement loss) verified against the real built dists. The " +
      "Wave-8 graph-explorer artifact seam is also deterministic, source-free, CSP-locked and " +
      "atomically written by the built package.\n",
  );
}

try {
  await main();
} catch (error) {
  console.error("\nE2E SMOKE FAILED\n");
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
