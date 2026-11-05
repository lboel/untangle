<a id="abnahmeprotokoll--die-kette-auf-einem-fremden-projekt"></a>

# Acceptance record: the workflow on another project

As of 2026-09-05, commit `79e1a43`. Executed by the orchestrator itself, not a subagent.

This record describes that historical revision. Current candidates require the
repeatable acceptance checks below; historical findings do not describe today's
build. Recorded terminal output and multilingual fixture queries below remain
in their original language as evidence. Current product output uses English.

In Wave 4, both reviewers returned **produkt-funktioniert-nicht**: `init` ran a
stub, `index` was unimplemented and `query` was unusable. This repeats the check
after Wave 5.

<a id="das-prüfobjekt"></a>

## The test project

A purpose-built external project, `acme-shop`, with the target properties:
multiple languages, an npm-workspace monorepo and `docker-compose.yml` containing
four services.

```text
services/api/src/orders.ts     TypeScript, contains calculateDiscount
services/web/src/cart.tsx      TSX, imports @acme/api
workers/mailer/src/send.py     Python
docs/architektur.md            Markdown, describes discount logic
docker-compose.yml             web → api → db, mailer → api
```

<a id="schritt-1--untangle-init"></a>

## Step 1 — `untangle init`

```text
Sprachen        typescript 33.3 %, yaml 26.7 %, markdown 15.6 %, python 11.1 %, json 8.9 %
                9 Dateien, 45 Zeilen; 64.4 % mit Parser
                ohne Parser (nur Textsuche): yaml, json
Topologie       4 Pakete, 4 Container-Dienste — Monorepo
                Globs: services/*, workers/*
                @acme/api, @acme/mailer, @acme/web, acme-shop
                Dienste: api, db, mailer, web
Einbettungen    http://127.0.0.1:11434 erreichbar — qwen3-embedding:0.6b (1.024 Dimensionen)
Vektorspeicher  http://127.0.0.1:16333 erreichbar
                nicht geprueft: http://127.0.0.1:6333
Ignorierregeln  keine .gitignore — 15 Vorgaben
```

**Works.** `docker-compose.yml` services are recognized as a separate topology
layer, meeting A3. The foreign Qdrant instance on 6333 is explicitly not probed,
and configuration documents that choice. The generated `untangle.toml` explains
every decision in comments and describes itself as a proposal rather than a
mandate.

<a id="schritt-2--untangle-index"></a>

## Step 2 — `untangle index`

With the running Ollama service, the run hangs indefinitely: cancelled after
300 s without output or progress. See WP-227.

With `--embedder=offline`:

```text
[100%] Fertig in 6279 ms.
Ergebnis:          completed
Sammlung:          untangle_fremdprojekt6_code_6350e2d2_v1
Dateien gefunden:  10   davon geplant: 10   unveraendert: 0   ignoriert: 2
Chunks:            21      Symbole: 8      Punkte abgelegt: 21
Einbettungen:      21 gerechnet, 0 aus dem Zwischenspeicher
Dateigraph:        10 Knoten, 1 Kanten
Symbolgraph:       8 Knoten, 3 Kanten
Uebersprungen:     2   (jeder Eintrag mit Grund: excluded_by_configuration)
```

**Works through the offline path.**

<a id="schritt-3--untangle-query"></a>

## Step 3 — `untangle query`

First, query without the matching profile to verify the failure path. The
historical output was:

> Fehler: Für dieses Embedding-Profil gibt es keinen Index […] **Es wurde nichts durchsucht — das
> ist NICHT dasselbe wie „keine Treffer".** Nächster Schritt: Führe `untangle index` aus.

It says no index exists and nothing was searched, rather than claiming no hits.
This correctly handles the exact E4 violation found in Wave 4, where `query`
reported no results with exit 0 despite performing no search, and supplies a
next step.

Then query with the matching profile:

```text
untangle query "Rabatt berechnen" --embedder=offline
  1  0.7486  services/api/src/orders.ts:3-10  calculateDiscount
  2  0.4000  docs/architektur.md:1-2  Architektur
  3  0.3935  services/web/src/cart.tsx:1-2
```

**Works, better than expected.** A German-language query ranks the correct
function first, followed by its explanatory Markdown document. Prose is actually
searchable, implementing §1c rather than merely recording documents.

<a id="schritt-4----explain-der-kern-von-1d"></a>

## Step 4 — `--explain`, the core of §1d

```text
1. 1.1373  fremdprojekt6@main services/api/src/orders.ts:3-10 function calculateDiscount
    complexity: cognitive 4
    why:
    + base_hybrid = 0.9873 (raw 0.9873 x weight 1.0000)  [RRF over dense#3, lexical#1, symbol#1]
    + exact_symbol_boost = 0.1500 (raw 1.0000 x weight 0.1500)  [symbol_name == "calculateDiscount"]
```

**Works.** The result carries both its complexity and a contribution-by-contribution
ranking breakdown. This links search and complexity as required by §1d: without
the breakdown, difficulty finding something could not be explained.

<a id="urteil"></a>

## Verdict

| Step | Wave 4 | Wave 5 |
|---|---|---|
| `init` | Fails (stub) | **Works** |
| `index` | Fails (unimplemented) | **Works** (offline; online see WP-227) |
| `query` | Fails (no index) | **Works** |
| `--explain` | Unreachable | **Works** |
| `complexity` | Partial | **Works** |
| `watch` | Works | Works |

The workflow is connected. Proof with real embeddings remained missing because
of WP-227 and the hanging Ollama embedding endpoint.

<a id="offene-befunde-aus-dieser-abnahme"></a>

## Open findings from this acceptance run

| ID | Finding | Severity |
|---|---|---|
| WP-227 | `untangle index` has no embedding-service deadline: hanging Ollama causes an unbounded command with no output or progress, for nine files. `doctor` already has `--timeout`; `index` needs the same plus exit 4 with a reason. | **High** |
| WP-228 | `init` reports the embedding service as reachable but checks only `/api/tags`. `/api/embed` may hang while `/api/tags` immediately responds, as observed. A probe omitting the actual endpoint claims more than it verifies. | Medium |
| WP-229 | Profile switching is cumbersome: every query must repeat `--embedder=offline` after offline indexing. The profile belongs in `untangle.toml` or index state so `query` can discover it automatically. The diagnostic is good but should be unnecessary. | Medium |
| WP-230 | The skipped-candidate note is attached to the last result line without a newline. | Low |

<a id="wiederholbare-release-abnahme-ab-oktober-2026"></a>

## Repeatable release acceptance from October 2026

After a fresh build, `pnpm run e2e:search` runs real search cases with Qdrant and
Ollama. Coverage includes independent retrieval paths, identifier spellings,
file changes/deletions, watcher updates, service failures and migration from old
lexical/chunker fingerprints. A long line in an ordinary class must not remove
its private methods from symbol search. `--require-fresh` must explicitly reject
stale results.

`pnpm run e2e:release --out-dir=".untangle/releases/<new-candidate-id>"` checks the
original tarballs, after content and license checks, in fresh external npm and
pnpm projects. The CLI-only consumer must run help, native TypeScript/Python
analysis and MCP stdio before more public packages are installed. Only a
successful run creates the bundle of tarballs, `SHA256SUMS`, `publish-order.json`
and `release-report.json`.

Every candidate must record runtime/platform, source/build checksums, exit codes
and actual search results. Local checks prove only the platform used. The
prepared GitHub matrix, Linux/macOS × Node 22/24, is confirmed only by executed
workflow runs. Procedure and remaining publication steps are in
[CONTRIBUTING.md](../CONTRIBUTING.md#prepare-a-public-release).
