# Untangle — Master-Bauplan (BUILD_PLAN)

**Status:** verbindlich für alle Agenten-Wellen
**Stand:** build-plan-v1, 2026-09-03
**Normative Quellen:** [`spec.md`](../spec.md) (spec-v1, gewinnt im Konflikt) · [`architecture.md`](../architecture.md) (architecture-v1) · [`product.md`](../product.md) · [`vision.md`](../vision.md) · [`portfolio.md`](../portfolio.md) (portfolio-v1)

Dieser Plan ist das Arbeitsdokument für parallele Agenten-Wellen. Jede WP-Zeile plus die genannten Spec-Abschnitte MUSS ausreichen, um das Package eigenständig zu bauen. Bei Widerspruch zwischen diesem Plan und `spec.md` gilt `spec.md`; für den Portfolio-Pfeiler gilt `portfolio.md`.

Globale Bauregeln für jedes WP (nicht wiederholt in den Zeilen):

- TypeScript strict, ESM (`"type": "module"`), Node `>=22.12.0`, vitest, Tests co-located `src/**/*.test.ts`;
- jedes Package: `package.json`, `tsconfig.json` (extends `../../tsconfig.base.json`), `src/index.ts` als einziger öffentlicher Export, `README.md` mit Abschnitt „Entscheidungen";
- kein `Date.now()`/`Math.random()` in Domain-/Analyse-Logik — Ports `Clock`/`Random` verwenden; IDs UUIDv5 nach `spec.md` §5;
- keine Netzwerkzugriffe, kein echtes Qdrant/Ollama in Unit-Tests (Testkit-Ports verwenden);
- keine Platzhalter (`TODO: implement`, `not implemented`) in beauftragtem Code;
- Code, Bezeichner, Kommentare, Fehlermeldungen, Log-Events, Testnamen: Englisch; Doku: Deutsch.

---

## 1. Work-Package-Katalog

Legende: Größe S (≤ 1 Agententag), M (1–2), L (2–4), XL (> 4). „Quellabschnitte" = normative Pflichtlektüre (Dokument §Abschnitt). „Deps" = harte Build-/Import-Abhängigkeiten auf andere WPs. Alle internen Packages sind `private: true` mit Namen `@untangle-code/<name>` (nur cli, core, config, plugin-sdk, testkit werden öffentlich, spec §2.2).

### Welle 0 (bereits gebaut oder parallel im Bau — hier nur als Referenz und Abnahmemaßstab)

| ID | Package / npm-Name | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-00 | root-scaffold (privat, Root) | pnpm-Workspace, `tsconfig.base.json`, Root-`package.json`, `vitest.workspace.ts`, `.gitignore`, `scripts/` | arch §5; spec §2.3 | — | S | `pnpm install` läuft fehlerfrei; `pnpm -r typecheck` und `pnpm -r test` existieren als Root-Scripts; Node-Engine `>=22.12.0` in Root-`package.json` |
| WP-01 | packages/domain `@untangle-code/domain` (privat) | Reine Typen, Ports, IDs, Fehlerklassen, Invarianten; keine I/O | spec §5, §25.1; arch §2.1, §6.1, §10, §22.1; portfolio §5, §7 | WP-00 | L | Alle Typen/Ports aus Abschnitt 3 dieses Plans exportiert; UUIDv5-ID-Funktionen deterministisch (Testfall: gleiche Eingabe ⇒ gleiche ID über zwei Prozesse); `UntangleError` mit allen ErrorCodes aus spec §25.1 + portfolio §15; kein Import von `node:fs`/`node:net`/Adaptern |
| WP-02 | packages/config `@untangle-code/config` (öffentlich) | Config Discovery, Layering (spec §4.1), JSON-Schema-Validierung, Effective Config, Profil-Hashing; besitzt `schemas/` | spec §4, §5.7; arch §6.3, §7.3; portfolio §14.4 | WP-01 | M | Prioritätsreihenfolge spec §4.1 durch Test belegt; ungültige Enums brechen Start ab; `embedding_profile_id = SHA256(canonical_json(...))` mit allen Pflichtfeldern spec §5.7; `portfolio.blueprint.weights` validiert Summe 1.0 ± 0.001 (portfolio §14.4); JSON-Schema `config-v1.json` in `schemas/` |
| WP-03 | packages/observability (privat) | Strukturierte Logs, Correlation IDs, Metrikzähler, Secret-Redaktion | spec §23; arch §24 | WP-01 | S | `LogEvent`-Shape arch §24.2; Redaktionstest: API-Key erscheint nie im Log; Zähler aus spec §23.3 vorhanden |
| WP-04 | packages/testkit `@untangle-code/testkit` (öffentlich) | In-Memory-Ports, Fake Embedder (deterministisch), Fixture Builder, Port-Contract-Harness, Golden-Assertions, Search-Eval-Utilities | arch §7.5, §27.1–27.2; spec §27 | WP-01 | M | Fake Embedder: gleicher Text ⇒ gleicher Vektor; Contract-Harness läuft gegen In-Memory-Implementierungen aller Ports grün; keine Netzwerkabhängigkeit |
| WP-05 | packages/scanner (privat) | Discovery, Ignore-Regeln, Binär-/Größen-/Symlink-Behandlung, Hash-Pipeline | spec §6; arch §6.4, §23.1 | WP-01 | M | Ignore-Priorität spec §6.2 durch Test belegt; Symlink-Zyklus terminiert; Workspace-Escape via Symlink wird abgelehnt; Content-Hash ist alleinige Unchanged-Quelle |
| WP-06 | packages/parser-registry (privat) | `LanguageAdapter`-Registry + Adapter TS/JS/TSX (deep) | spec §7; arch §6.5 | WP-01 | L | `LanguageAdapter`-Interface arch §6.5 implementiert; Parse Quality complete/partial/failed korrekt klassifiziert (Fixture mit Syntaxfehler ⇒ partial/failed); Golden Tests TS/JS/TSX für Symbole, Imports, Calls |
| WP-07 | packages/chunker (privat) | Lossless AST-Chunking, drei Strategien, Coverage Ledger + Validator, Prepared Text | spec §8; arch §6.6, §14 | WP-01, WP-06 | L | Coverage-Invariante spec §8.4 maschinell geprüft (Validator-Test mit Lücke ⇒ Fehler); Fragmente tragen `fragment_index/count` + Symbolheader; Token-Budget inkl. Metadatenheader eingehalten; Chunk-IDs stabil bei unverändertem Symbol |
| WP-08 | packages/complexity (privat) | Complexity IR, alle Calculators (cyclomatic classic/extended, cognitive `untangle-cognitive-v1`, structural, textual, syntactic, Halstead, MI), Aggregation | spec §16; arch §6.7, §15 | WP-01, WP-06 | XL | Jede Cognitive-Summe = Summe ihrer Contributions (Test); MI-Formel spec §16.9 exakt; Aggregationen liefern count/sum/mean/median/max/p90/p95/SLOC-gewichtet; Dedupe über `metrics_scope_id`; Golden Tests pro Metrikfamilie |

### Welle 1

| ID | Package / npm-Name | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-09 | parser-python (Erweiterung in packages/parser-registry, Pfad `src/languages/python/`) | Python-Adapter Level `deep`: Parse, Chunks, Symbole, Imports, Calls, ComplexityFacts | spec §7.2, §7.3, §16 (Adapterregeln); arch §6.5, §15.1 | WP-06, WP-08 (Facts-Typen via WP-01) | M | Golden Tests Python: Symbole, relative/absolute Imports, Calls, cyclomatic-Entscheidungspunkte inkl. `elif`/Comprehension-Regeln dokumentiert und versioniert; Parse-Quality-Fixture (Syntaxfehler) ⇒ partial mit Textfallback-Kennzeichnung |
| WP-10 | packages/embeddings-ollama (privat) | `EmbeddingProvider`-Adapter: Readiness-Sequenz, Batching, Retry/Backoff+Jitter, Dimension Check, Truncation Guard, Embedding Cache | spec §9, §5.7; arch §6.8 | WP-01, WP-02, WP-04 | M | Readiness-Schritte spec §9.1 in Reihenfolge getestet (gemockter HTTP-Client); Cache-Key `embedding_profile_id + SHA256(prepared_text)`; Cache-Hit ⇒ kein Provideraufruf (Test); permanenter Fehler nach Retries ⇒ kontrollierter Jobstopp mit `EMBEDDING_UNAVAILABLE`; Dimensions-Mismatch ⇒ `EMBEDDING_DIMENSION_MISMATCH` vor erstem Upsert |
| WP-11 | packages/storage-qdrant (privat) | Adapter für `VectorStore`, `MetadataStore`, `GraphStore`: Provisioning, Payload-Indizes, Dense/Sparse-Upserts, Hybrid Query (RRF), Byte Budget, Multipart, Kompatibilitätschecks | spec §10; arch §6.9, §11; portfolio §12 | WP-01, WP-02, WP-04 | XL | Upsert-Flush-Regel arch §11.7 (points ODER bytes) durch Test belegt; einzelner zu großer Punkt ⇒ `POINT_TOO_LARGE` oder Multipart-Split; Multipart-Reader verwirft inkonsistente `write_id`/Checksums; Status-Read erzeugt keine Collection als Seiteneffekt; Collection-Namen exakt nach spec §10.1 + portfolio §12.1; alle Payload-Indizes spec §10.4 + portfolio §12.3 werden provisioniert (Unit-Test gegen gemockten Client, Integrationstest via Testcontainer separat markiert) |
| WP-12 | packages/storage-local (privat) | `.untangle/`-Layout: Caches (embeddings/parser/git-blobs), Checkpoint-Spiegel, Datei-Locks, Artefakte, Logs | arch §12, §21.2 | WP-01, WP-04 | M | Lock-Record enthält PID, Startzeit, Host, Lease, zufällige Process Instance ID; Stale-Detection nutzt nicht nur PID (Test); Cache-Löschung ist verlustfrei rekonstruierbar (Reads degradieren kontrolliert); atomare Checkpoint-Schreibweise (temp + rename) |
| WP-13 | packages/jobs (privat) | Job Scheduler, Zustandsmaschine spec §11.1, Cancellation (AbortSignal), Progress Events, Checkpoint Store, Resume-Planung, bounded Queues/Backpressure | spec §11, §12.2; arch §2.2, §6.14, §13.2–13.3, §21 | WP-01, WP-03, WP-12 | L | Alle Job-Events arch §2.2 typisiert emittiert; Cancel zwischen Batchgrenzen ⇒ Checkpoint gespeichert + Status `cancelled`; Resume setzt exakt am letzten bestätigten Checkpoint auf (Test mit simuliertem Abbruch); volle Queue pausiert vorherige Stage (Backpressure-Test); Checkpoint-Shape `IndexCheckpointV1` arch §13.3 |
| WP-14 | packages/watcher (privat) | Nativer rekursiver Watcher, Debounce (Default 2000 ms), Koaleszierung, periodische Reconciliation, Fehlerisolierung | spec §12.3 | WP-01, WP-05 | M | Mehrere Events derselben Datei ⇒ ein koaleszierter Change (Fake-Timer-Test); Watcherfehler beendet Prozess nicht; Reconciliation findet künstlich „verlorenes" Event; Debounce konfigurierbar |
| WP-15 | packages/context-artifacts (privat) | `ArtifactAdapter`-Registry: Markdown/ADR, SQL, OpenAPI/AsyncAPI, Protobuf, Terraform, Kubernetes, Docker/Compose, Text-Fallback; Staleness über Config+Inhaltshash | spec §19; arch §20 | WP-01, WP-02 | M | Eindeutigkeit des Artefaktnamens erzwungen; SQL/OpenAPI/Markdown chunken semantisch (Abschnittstest, nicht Zeilenfenster); unbekanntes Format ⇒ sicherer Textfallback; Rohinhalt + Source Range erhalten; Links als Heuristik markiert |
| WP-16 | fixtures/ (privat, kein npm-Package im Buildgraph nötig; eigenes `package.json` mit `private: true`) | Alle Pflicht-Fixtures aus spec §27.2 (10) und portfolio §16.2 (10) + Retrieval-Ground-Truth-Dateien | spec §27.2–27.3; portfolio §16.2 | — (nur WP-00) | L | Verzeichnis pro Fixture mit `fixture.json` (Name, Zweck, erwartete Eigenschaften); Retrieval-Cases als `RetrievalCase[]`-JSON je Fixture; jede Fixture per Skript syntaktisch selbstkonsistent (z. B. TS-Fixture parsebar) — Detailliste in Abschnitt 5 |

### Welle 2

| ID | Package / npm-Name | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-17 | packages/file-graph (privat) | Import-Extraktion→Resolver-Pipeline (relative, TS paths/baseUrl, Node exports, npm/pnpm/yarn Workspaces, Python, konfigurierbare Aliases), Cross-Repo Package Registry, Reverse Edges, SCC/Zyklen, Graphmetriken, Persistenz via `GraphStore` | spec §14; arch §6.11, §16 | WP-01, WP-05, WP-06, WP-09 | L | Resolver-Reihenfolge arch §16.2 getestet; unaufgelöste Imports gezählt und sichtbar; Zyklen-Fixture (WP-16 Nr. 4) liefert exakt die konstruierten Zyklen; Cross-Repo-Kante über Package-Katalog (npm-Name + Python-Package) nachgewiesen; Kanten referenzieren Quellpositionen |
| WP-18 | packages/symbol-graph (privat) | Symbolknoten, Call-Kanten mit Confidence (local/unique/ambiguous/external/unresolved), Name-/Reverse-Indizes, Shard-Persistenz, LRU-Cache, Traversal mit Limits | spec §15; arch §6.11, §17 | WP-01, WP-06, WP-09 | L | `ambiguous` wird nie als sichere Kante behandelt (Test mit zwei Kandidaten); Traversal respektiert maxDepth/maxNodes/maxEdges/maxWallTimeMs und liefert `truncated=true` mit Grund; Impact rückwärts + Flow vorwärts auf Fixture korrekt; Zyklenschutz terminiert |
| WP-19 | packages/search (privat) | Query-Pipeline spec §13.2: Validierung, Profilgruppen, Query-Embedding-Reuse, Hybrid Query via `VectorStore`-Port, RRF-Regeln, Dedupe (`repo_id+ref_id+metrics_scope_id`), Boosts mit Score-Breakdown, MMR-Diversifizierung, Graph-Context-Expansion (via Port) | spec §13; arch §6.10, §18 | WP-01, WP-04 (Fake Embedder/InMemory VectorStore) | L | Ein Query-Embedding pro Profilgruppe (Spy-Test); RRF-Werte verschiedener Collections werden nie direkt sortiert (Test: getrennte Gruppen im Ergebnis); Boosts überstimmen Basis-Hybrid nicht vollständig (Clamp-Test); jedes `SearchResultV1` enthält Score-Komponenten, Provenienz, `parseQuality`, `indexGeneration`; Dedupe hängt Fragmente als `relatedFragments` an |
| WP-20 | packages/plugin-sdk `@untangle-code/plugin-sdk` (öffentlich) | Engine-Compatibility-Check, host-neutraler Command Contract, Result-Schema-Typen, Launcher für `npx @untangle-code/cli mcp --stdio`, Status-/Error-Mapping; keine Parser-/Storage-Abhängigkeiten | spec §2.4; arch §7.4, §9; product §7 | WP-01, WP-02 | M | Compatibility-Check lehnt Engine außerhalb `engineRange` mit verständlicher Meldung ab (Test); Manifest-Shape spec §2.4 validierbar; Package importiert nachweislich weder parser-registry noch storage-* (dependency-Test im CI-Script); Launcher startet konfigurierbaren Befehl ohne Shell-Injection (Argument-Array, kein String-Interpolat) |

### Welle 3

| ID | Package / npm-Name | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-21 | packages/change-engine (privat) | `RevisionProvider` (Git CLI, Filesystem+Git-Base, gespeicherte Generationen), Symbol-Matching-Kaskade spec §17.3, Text-/AST-/Complexity-/Graph-Delta, Blast Radius, Risk Score `untangle-risk-v1`, Change-Event-Persistenz + Change-Suchtexte, Quality-Gate-Evaluator | spec §17, §18; arch §19 | WP-01, WP-06, WP-08, WP-09, WP-17, WP-18 | XL | Matching-Reihenfolge spec §17.3 als Kaskade getestet (Fixture WP-16 Nr. 6 Rename/Move ⇒ Kandidat mit Confidence + Signalen); bipartit ohne Doppelzuordnung; Risk Score nie ohne `components` + `caveats` (Typ- und Laufzeittest); neue/gelöschte Symbole nicht als unendliches relatives Delta; `evaluateQualityGate(report, policy)` ist pure Function; `ignoreExistingViolations=true` bewertet nur neue/verschärfte Verstöße; Exit-Code-Mapping spec §18.3 als Konstante exportiert |
| WP-22 | packages/portfolio (privat) | Portfolio-Pipeline portfolio §9.1: Manifest-Detektoren §6.3, Alias-/Domain-Tabellen (`portfolio-alias-v1`, `portfolio-domain-map-v1` als versionierte Datenartefakte), Record-Merge, Versionsnormalisierung, Profiles, Konventions-Detektoren §8.1, Archetyp-Klassifikator `untangle-archetype-v1`, Stack Matrix, Radar `untangle-radar-v1`, Blueprint-Advisor `untangle-blueprint-v1`, Scaffolding-Writer §11.2 | portfolio §5–§13, §15–§17; spec §5, §10.6 | WP-01, WP-02, WP-05, WP-08, WP-17, WP-18 (Change-History nur via Domain-Read-Model/`MetadataStore`-Port, KEIN Import von change-engine) | XL | Determinismus: Doppel-Scan identischer Fixtures ⇒ identische IDs/Records bis auf `generatedAt` (Test); jeder Record hat ≥ 1 Provenienz; Konfidenzformel §7.4 exakt; Merge-Vorrang lockfile > manifest; Archetyp < 0.30 ⇒ `unclassified`, Signale immer vollständig; Radar-Prüfreihenfolge R4→R3→R1→R2, ohne Historie kein R4/kein Trend; `fitScore` nie ohne 4 Komponenten; leeres Portfolio ⇒ `BLUEPRINT_EVIDENCE_INSUFFICIENT`; Scaffolding: Dry-Run-Default, nicht-leeres Ziel ⇒ `BLUEPRINT_TARGET_NOT_EMPTY`, Symlink-Escape ⇒ `BLUEPRINT_TARGET_OUTSIDE_ALLOWED`, kein Überschreiben, temp+rename, `.untangle-blueprint.json`-Manifest, Aufräumen nach injiziertem Schreibfehler (alle als Tests) |

### Welle 4

| ID | Package / npm-Name | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-23 | packages/core `@untangle-code/core` (öffentlich) | Kompositionsfreie Engine-Fassade: `createUntangleEngine(options)` mit injizierten Ports; Use Cases IndexWorkspace, UpdateWorkspace, SearchCode, BuildGraphs, GetSymbolContext, AnalyzeImpact, ComputeComplexity, AnalyzeChanges, EvaluateQualityGate, IndexContextArtifacts + Portfolio-Methoden; Generation Commit, Transaktionsgrenzen, Fehlersemantik | spec §3.3, §11, §12.2, §22; arch §6.2, §7.1, §13; portfolio §14.3 | WP-01…WP-15, WP-17…WP-19, WP-21, WP-22 (alle Engine-Packages; KEINE CLI-/MCP-Abhängigkeit) | XL | `UntangleEngine`-Interface spec §22 + portfolio §14.3 vollständig; alle Methoden akzeptieren `AbortSignal`; Update-Ablauf spec §12.2 Schritte 1–10 in Reihenfolge (Integrationstest mit In-Memory-Ports); Generation erst `completed` nach arch §13.4-Bedingungen; Library Mode ohne CLI-Parsing nutzbar (Test instanziiert Engine nur mit Testkit-Ports); Crash-Simulationstests aus Abschnitt 5.5 bestehen |

### Welle 5

| ID | Package / npm-Name | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-24 | apps/mcp-server (privat) + `apps/cli/src/mcp` | Die öffentliche CLI besitzt MCP-Runtime und stdio-Transport: alle Toolnamen spec §21.1 + portfolio §14.2, werkzeugspezifische Input-/Output-Verträge, `ToolResponseEnvelopeV1`, Pfadvalidierung gegen Workspace-Roots, mutierende Tools mit explizitem Scope/Ziel. `apps/mcp-server` ist ausschließlich ein privater Kompatibilitäts-Wrapper, der `@untangle-code/cli/mcp` reexportiert | spec §21; portfolio §14.2; arch §8 | WP-23, WP-02, WP-03, WP-26 | L | Contract-Test je Tool: Input-, Erfolgsdaten- und Envelope-Shape, `ok/error.code/retryable`; Pfad außerhalb Root ⇒ `PATH_OUTSIDE_WORKSPACE`; `untangle_blueprint` mit `apply:true` nennt Zielverzeichnis im Textsegment; Remove-Operationen verlangen explizites Ziel; kein Tool führt externe Befehle aus (Code-Review-Kriterium + Test der Toolliste); echtes gebaute CLI-Binary spricht beide unterstützten Protokollgenerationen |
| WP-25 | benchmarks/ (privat) | Retrieval-Benchmark (Recall@5/@10, MRR, Repository-Diversity) über Fixture-Ground-Truth mit Fake Embedder + In-Memory Store; Index-Durchsatz-Microbench; Regressionsschwellen als JSON | spec §26, §27.3; arch §27.4 | WP-04, WP-16, WP-23 | M | `pnpm --filter benchmarks run eval` schreibt Report mit Recall@5/@10, MRR, Diversity je Fixture; Schwellenverletzung ⇒ Exit ≠ 0; Lauf ist ohne Netzwerk deterministisch |

### Welle 6

| ID | Package / npm-Name | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-26 | apps/cli `@untangle-code/cli` (öffentlich) | Kompositionswurzel: Config laden, Adapter erzeugen, Managed Infrastructure (Qdrant-/Ollama-Container, Ports spec §3.1), alle Befehle spec §20.2 + `untangle portfolio …` portfolio §14.1, Formatter text/json/jsonl/markdown, eigener öffentlicher Export `./mcp` samt `untangle mcp --stdio`, Exit Codes, Binary `untangle`; besitzt `docker/` | spec §2, §3, §20; product §6.3, §10; portfolio §14.1; arch §7.2, §26.1 | WP-23, WP-02, WP-03, WP-20 (nur Schemas/Kompatibilität) | XL | `--format json` schreibt ausschließlich valides JSON auf stdout, Logs auf stderr (Snapshot-Test); Exit Codes spec §18.3 + portfolio §14.1; `bin.untangle = dist/bin/untangle.js`, exports `./mcp`, `./schema` (product §6.3); CLI-Snapshot-Tests für search/status/gate/portfolio-Befehle in text und json; `untangle doctor` prüft Health-Komponenten spec §23.1; Managed Mode löscht nie Container ohne expliziten Remove-Befehl |
| WP-27 | apps/vscode-extension (privat) | Thin Extension: MCP-Registrierung (`McpServerDefinitionProvider`), Statusbar, Tree View, Webview (Graph/Hotspots) mit CSP, CodeLens (Complexity), Diagnostics (Gates), Output Channel; keine Engine im Extension Host | arch §9.4, §23.4; product §4.6 | WP-20 | L | Extension importiert keine Engine-/Indexer-Packages (dependency-Test); Webview ohne Remote Scripts (CSP-Assertion); Aktivierung startet Engine via Launcher, nicht in-process; VSIX-Build (`vsce package`-Äquivalent) läuft |
| WP-28 | apps/github-action (privat) | Action-Wrapper: checkout base/head, Qdrant Service Container, `untangle changes analyze` + `untangle gate`, JSON/Markdown-Report als PR-Kommentar-Artefakt | arch §25.4; product §5, §13.2 | WP-26 (funktional, kein Import — ruft CLI via `npx` auf) | M | `action.yml` mit Inputs (base, head, config, gate-mode); lokaler Testlauf via `act` oder Skript-Simulation dokumentiert; Gate-Exit-Code wird als Action-Failure durchgereicht |
| WP-29 | plugins/claude-code (privat) | Manifest, Skills, Commands, MCP-Launch-Config, `compatibility.json` | arch §9.1–9.3, §9.5; product §7; spec §2.4 | WP-20 | S | Manifest deklariert `enginePackage`, `engineRange`, `toolSchemaVersion`, `resultSchemaVersion` (spec §2.4); enthält nachweislich keinen Engine-Code (nur Konfiguration/Prompts); Kompatibilitätstest gegen plugin-sdk-Checker |
| WP-30 | plugins/cursor (privat) | wie WP-29 für Cursor | wie WP-29 | WP-20 | S | wie WP-29 |
| WP-31 | plugins/codex (privat) | wie WP-29 für Codex (MCP-Konfiguration + Skills) | wie WP-29 | WP-20 | S | wie WP-29 |
| WP-32 | plugins/gemini (privat) | wie WP-29 für Gemini CLI (`gemini-extension.json`) | wie WP-29; product §7.2 | WP-20 | S | wie WP-29 |

---

## 2. Bauwellen

Topologische Ordnung; innerhalb einer Welle sind alle WPs paarweise verzeichnisdisjunkt und importieren einander nicht (Ausnahme WP-09, siehe Fußnote). Eine Welle startet erst, wenn die DoD der Vorwelle (Abschnitt 6) erfüllt ist.

| Welle | WPs (parallel) | Begründung der Schnittkante |
|---|---|---|
| 0 (gebaut/parallel) | WP-00 root-scaffold, WP-01 domain, WP-02 config, WP-03 observability, WP-04 testkit, WP-05 scanner, WP-06 parser-registry (TS/JS/TSX), WP-07 chunker, WP-08 complexity | Fundament: Contracts (WP-01) + reine Analyse ohne Storage |
| 1 | WP-09 parser-python¹, WP-10 embeddings-ollama, WP-11 storage-qdrant, WP-12 storage-local, WP-13 jobs, WP-14 watcher, WP-15 context-artifacts, WP-16 fixtures | Alle hängen nur an Welle 0 (Ports/Typen in domain); keine wechselseitigen Imports |
| 2 | WP-17 file-graph, WP-18 symbol-graph, WP-19 search, WP-20 plugin-sdk | Graphen brauchen Parser inkl. Python (Welle 1); search arbeitet gegen Ports + Testkit; plugin-sdk braucht nur domain+config und wird vorgezogen, damit Welle 6 nicht auf ihn wartet |
| 3 | WP-21 change-engine, WP-22 portfolio | Beide konsumieren Graph-Query-APIs (Welle 2) und Complexity; portfolio importiert change-engine NICHT (Change-History nur über Domain-Typen + `MetadataStore`-Port) — daher konfliktfrei parallel |
| 4 | WP-23 core | Einziger Konsument aller Engine-Packages; bewusst allein, da er die Integrationsklammer ist |
| 5 | WP-25 benchmarks | benchmarks brauchen core+fixtures und bleiben von den Oberflächen unabhängig |
| 6 | WP-26 apps/cli samt MCP-Runtime, WP-24 privater mcp-server-Wrapper, WP-27 apps/vscode-extension, WP-28 apps/github-action, WP-29–WP-32 plugins/* | `apps/mcp-server` importiert ausschließlich den öffentlichen CLI-Export `@untangle-code/cli/mcp`; die CLI importiert den Wrapper nie. Extension/plugins importieren nur plugin-sdk (Welle 2); github-action ruft cli nur als Prozess auf |

¹ WP-09 schreibt in `packages/parser-registry/src/languages/python/**` sowie genau eine Registrierungsstelle (`src/languages/index.ts`). Zulässig, weil Welle 0 abgeschlossen ist und kein anderes Welle-1-WP dieses Verzeichnis anfasst.

Kritischer Pfad: WP-01 → WP-06 → WP-09/WP-17/WP-18 → WP-21 → WP-23 → WP-26 → WP-24-Wrapper.

---

## 3. Contract-Register (MUSS in `packages/domain` liegen)

Diese Typen/Ports werden in Welle 0 fixiert; spätere Wellen dürfen sie erweitern (additiv, neue Version), aber nicht brechen. Ein WP, das einen dieser Namen lokal dupliziert statt aus domain zu importieren, verletzt den Plan.

### 3.1 Ports (arch §2.1, §7.1, §19.1)

```text
VectorStore            MetadataStore          GraphStore
EmbeddingProvider      ParserRegistry (Port)  FileSystemPort
GitPort (GitProvider)  LockProvider           Clock
LoggerPort             Random                 RevisionProvider
CheckpointStorePort    ArtifactAdapter        ImportResolver
LanguageAdapter
```

### 3.2 Identität und Basistypen (spec §5; portfolio §5)

```text
buildWorkspaceId, buildRepoId, buildRefId, buildFileId, buildSymbolId,
buildChunkId, buildEmbeddingProfileId (SHA256 canonical JSON),
buildTechnologyId, buildTechRecordId, buildRepoProfileId, buildStackMatrixId,
buildConventionId, buildArchetypeId, buildBlueprintId, buildRecommendationId,
buildRadarEntryId
SourceRange, ParseQuality ("complete" | "partial" | "failed"), ChunkKind (spec §8.2)
```

### 3.3 Datenverträge Kern (spec §10.3, §13, §15–§18; arch §10, §13.3)

```text
WorkspaceRecord, RepositoryRecord, RefRecord, FileManifestV1
CodeChunkPayloadV1, EmbeddingProfile
SymbolRecordV1, SymbolNodeV1, CallEdgeV1 (Confidence-Enum)
ComplexityFacts, ComplexityIRNode, CognitiveContributionV1,
ComplexitySnapshotV1, ComplexitySummaryV1, MetricContribution
SearchRequestV1, SearchResultV1, SearchResponseV1
ChangeEventV1, DiffSummaryV1, AstDiffSummaryV1, ComplexityDeltaV1,
GraphDeltaV1, ImpactSummaryV1, RiskScoreV1
QualityGateResultV1, QualityViolationV1, QualityImprovementV1
ContextArtifactConfig, ArtifactDocument, ArtifactChunk, ArtifactLink
JobEvent (JobQueued … JobCancelled, arch §2.2), IndexCheckpointV1
ToolResponseEnvelopeV1, ToolWarningV1
UntangleError, ErrorCode (spec §25.1 + portfolio §15, ein gemeinsames Enum)
CoverageEntry (arch §14.1)
```

### 3.4 Datenverträge Portfolio (portfolio §7, §12.2, §14.2)

```text
PortfolioProvenanceV1, PortfolioConfidenceV1
TechnologyRecordV1, RepositoryProfileV1, RepositoryHealthV1, LanguageShareV1
StackMatrixV1, StackMatrixEntryV1
ConventionV1, ConventionRuleV1, ConventionCounterexampleV1
ArchetypeV1, ArchetypeSignalV1
BlueprintV1, BlueprintRecommendationV1, RecommendationComponentV1,
BlueprintAlternativeV1, BlueprintRiskV1, BlueprintDirectoryEntryV1,
BlueprintDependencyV1, BlueprintFileV1
TechRadarEntryV1, RadarTrendPointV1
PortfolioPointPayloadV1
PortfolioScanInputV1/ResultV1, StackMatrixInputV1, WhoUsesInputV1/ResultV1,
ConventionsInputV1/ResultV1, ArchetypesInputV1/ResultV1,
TechRadarInputV1/ResultV1, BlueprintInputV1/ResultV1
```

Abgrenzung: `UntangleConfigV1` und alle Config-Subtypen (spec §4.2–§4.7, portfolio §14.4) liegen in `packages/config`, nicht in domain — domain bleibt config-frei. Versionskonstanten (`parser_version`, `chunker_version`, `metrics_version`, `untangle-cognitive-v1`, `untangle-risk-v1`, `untangle-archetype-v1`, `untangle-radar-v1`, `untangle-blueprint-v1`, `portfolio-detect-v1`, `portfolio-alias-v1`, `portfolio-domain-map-v1`) werden als String-Literale in domain exportiert.

---

## 4. Dateibesitz-Matrix

Genau ein Besitzer pro Pfad. Andere WPs haben Lesezugriff, aber Schreibverbot. Wer fremde Pfade braucht, meldet es in `openIssues` statt zu schreiben.

| Pfad | Besitzer |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `.npmrc`, `scripts/**` | WP-00 |
| `README.md` (Root), `vision.md`, `product.md`, `spec.md`, `architecture.md`, `portfolio.md` | eingefroren — nur explizit beauftragte Doku-WPs |
| `docs/BUILD_PLAN.md` | Planungs-WP (dieses Dokument) |
| `docs/**` (übrige) | Doku-WPs nach separater Zuweisung |
| `packages/domain/**` | WP-01 |
| `packages/config/**`, `schemas/**` | WP-02 |
| `packages/observability/**` | WP-03 |
| `packages/testkit/**` | WP-04 |
| `packages/scanner/**` | WP-05 |
| `packages/parser-registry/**` außer `src/languages/python/**` | WP-06 |
| `packages/parser-registry/src/languages/python/**` + Registrierungszeile in `src/languages/index.ts` | WP-09 |
| `packages/chunker/**` | WP-07 |
| `packages/complexity/**` | WP-08 |
| `packages/embeddings-ollama/**` | WP-10 |
| `packages/storage-qdrant/**` | WP-11 |
| `packages/storage-local/**` | WP-12 |
| `packages/jobs/**` | WP-13 |
| `packages/watcher/**` | WP-14 |
| `packages/context-artifacts/**` | WP-15 |
| `fixtures/**` | WP-16 |
| `packages/file-graph/**` | WP-17 |
| `packages/symbol-graph/**` | WP-18 |
| `packages/search/**` | WP-19 |
| `packages/plugin-sdk/**` | WP-20 |
| `packages/change-engine/**` | WP-21 |
| `packages/portfolio/**` | WP-22 |
| `packages/core/**` | WP-23 |
| `apps/mcp-server/**` | WP-24 |
| `benchmarks/**` | WP-25 |
| `apps/cli/**`, `docker/**` | WP-26 |
| `apps/vscode-extension/**` | WP-27 |
| `apps/github-action/**` | WP-28 |
| `plugins/claude-code/**` | WP-29 |
| `plugins/cursor/**` | WP-30 |
| `plugins/codex/**` | WP-31 |
| `plugins/gemini/**` | WP-32 |

Regeln:

- Neue Workspace-Einträge in `pnpm-workspace.yaml` sind durch WP-00 vorab als Globs (`packages/*`, `apps/*`, `plugins/*`, `fixtures`, `benchmarks`) abgedeckt — kein WP editiert Root-Dateien.
- Kein WP schreibt in `node_modules`, `.untangle/` oder fremde `dist/`.
- Golden-/Snapshot-Dateien liegen im Besitzverzeichnis des testenden WP, nicht in `fixtures/` (fixtures/ enthält nur Eingabematerial + Ground Truth).

---

## 5. Test- und Fixture-Plan (spec §27, portfolio §16)

### 5.1 Pflicht-Fixtures (WP-16, `fixtures/<nn>-<name>/`)

| Nr | Verzeichnis | Inhalt (spec §27.2 / portfolio §16.2) | Primäre Konsumenten |
|---|---|---|---|
| 01 | `01-ts-monorepo` | TS-Monorepo mit pnpm-Workspaces, ESLint, Vitest, GitHub Actions (deckt zugleich portfolio-Fixture 1) | WP-17, WP-19, WP-22, WP-25 |
| 02 | `02-python-workspace` | Python Multi-Package-Workspace; `pyproject.toml`, Ruff, Pytest, Dockerfile, Compose mit Postgres+Redis (portfolio-Fixture 2) | WP-09, WP-17, WP-22 |
| 03 | `03-mixed-frontend-backend` | Frontend/Backend/Shared-Setup mit Cross-Repo-Imports | WP-17, WP-19, WP-23 |
| 04 | `04-dependency-cycles` | absichtliche Import-Zyklen (Datei- und Package-Ebene) | WP-17, WP-21 |
| 05 | `05-large-function` | eine sehr große Funktion (> maxChunkTokens) für Fragmentierung + Cognitive Contributions | WP-07, WP-08 |
| 06 | `06-rename-move` | base/head-Paare mit Rename, Move, Move+Rename über Dateien | WP-21 |
| 07 | `07-parse-errors` | Syntaxfehler + teilweise gültiger Code (TS und Python) | WP-06, WP-09, WP-07 |
| 08 | `08-minified` | minifizierte JS-Datei | WP-07 |
| 09 | `09-context-artifacts` | SQL-Schema, OpenAPI, ADR-Markdown, Terraform, K8s-YAML | WP-15 |
| 10 | `10-embedding-profiles` | zwei Konfigurationen mit inkompatiblen Embedding-Profilen (Modell/Dimension) | WP-19, WP-23 |
| 11 | `11-go-worker` | Go-Service mit Kafka-Client ohne HTTP-Framework (Worker-Archetyp) | WP-22 |
| 12 | `12-pure-library` | Library-Repo ohne Entrypoints | WP-22 |
| 13 | `13-infra-repo` | nur Terraform + CI | WP-22 |
| 14 | `14-version-divergence` | dieselbe Library in drei Major-Versionen über Repos | WP-22 |
| 15 | `15-competing-domain` | zwei Logging-Libraries derselben problem_domain | WP-22 |
| 16 | `16-phantom-dependency` | Import ohne Deklaration + declared-only Dependency | WP-17, WP-22 |
| 17 | `17-broken-manifest` | Manifest mit Syntaxfehler (Degradationsprüfung) | WP-22 |
| 18 | `18-scaffold-targets` | leeres und nicht-leeres Zielverzeichnis (inkl. verborgener Datei, `.git/`-Fall, Symlink-Escape) | WP-22 |

Jede Fixture 01–04 und 09 trägt zusätzlich `retrieval-cases.json` (`RetrievalCase[]`, spec §27.3) mit mindestens 5 Queries inkl. `expectedFiles`, optional `expectedSymbols`, `forbiddenFiles`.

### 5.2 Golden-Tests je Sprache (WP-06, WP-09; Erweiterung je Metrikfamilie WP-07/WP-08)

Pro Sprache (TS, JS, TSX, Python) kleine Quelldateien mit eingecheckten Erwartungen (arch §27.3):

```text
symbols · imports · calls · cyclomatic (classic+extended) ·
cognitive contributions (Position, Art, Basis, Nesting) ·
Halstead tokens · AST depth · chunks + coverage ledger
```

Golden-Änderung = Review-pflichtig (ändert Algorithmusbedeutung). Ablage: `packages/<pkg>/src/**/__golden__/*.json`.

### 5.3 Contract-Tests der Ports (WP-04 Harness; Adapter-WPs führen aus)

Der Testkit-Harness definiert pro Port eine wiederverwendbare Suite; jede Implementierung muss sie bestehen:

| Port | In-Memory (WP-04) | Realer Adapter | Testinhalt (Auszug) |
|---|---|---|---|
| VectorStore | ja | WP-11 (Testcontainer, separat markiert `@integration`) | idempotente Upserts, Byte-Budget-Flush, Multipart-Konsistenz, Filter, kein Create-als-Seiteneffekt |
| MetadataStore | ja | WP-11 | Generationstatus, Checkpoint-Persistenz, Read-ohne-Create |
| GraphStore | ja | WP-11 | Shard-Write/Read, `write_id`/Checksum-Verifikation |
| EmbeddingProvider | Fake (deterministisch) | WP-10 (HTTP-Mock; live optional) | Readiness, Batch, Retry, Dimension, Truncation-Flag |
| LockProvider | ja | WP-12 (Datei-Locks) | Exklusivität, Stale Detection ohne PID-Reuse-Falle |
| FileSystemPort / GitPort | ja | WP-12 / WP-21 | Pfad-Sandbox, Symlink-Prüfung / Revision-Reads |
| Clock / Random | ja | — | Determinismus in Tests |

Unit-Suiten laufen ausschließlich gegen In-Memory/Fake; `@integration`-Suiten (Qdrant Testcontainer, live Ollama) sind eigene vitest-Projekte und in CI optional.

### 5.4 Retrieval-Benchmark (WP-25)

- Eingabe: Fixtures 01–04, 09 mit `retrieval-cases.json`;
- Pipeline: Index mit Fake Embedder + In-Memory VectorStore (deterministisch), dann `SearchCode` je Query;
- Metriken: Recall@5, Recall@10, MRR, Repository-Diversity (spec §27.3);
- Schwellen in `benchmarks/thresholds.json`; Unterschreitung ⇒ Exit ≠ 0 (CI-Gate, arch §27.4).

### 5.5 Crash-Simulation (WP-13/WP-23; arch §27.5)

Fault Injection über einen Testkit-Hook (`FaultInjector`-Port, nur im Testkit) an genau diesen Punkten:

```text
1 nach Embedding, vor Upsert
2 mitten im Multipart-Upsert
3 nach Upsert, vor Checkpoint
4 während Graphpersistenz
5 nach Checkpoint, vor Generation Commit
6 während Watcher-Update
```

Assertion nach simuliertem Neustart + Resume: keine Generation ist als `completed` markiert, deren Pflichtdaten fehlen; kein Punkt doppelt gezählt; Resume beendet den Lauf erfolgreich. Watcher-Fall: Reconciliation stellt Konsistenz her.

---

## 6. Definition of Done je Welle

Jede Welle gilt erst als abgeschlossen, wenn ALLE Kommandos aus dem Repo-Root grün laufen. „Grün" = Exit 0, keine übersprungenen Pflichttests. (`pnpm -r` läuft rekursiv über alle bis dahin existierenden Packages.)

| Welle | DoD (abgeleitet aus spec §28, arch §31, portfolio §17) | Beweiskommando |
|---|---|---|
| 0 | Contracts aus Abschnitt 3 vollständig in domain; Chunk-Coverage maschinell geprüft; Golden Tests TS/JS/TSX grün; Complexity-Contributions reproduzierbar (arch §31: „Complexity-Werte und Contributions reproduzierbar") | `pnpm install && pnpm -r typecheck && pnpm -r test` |
| 1 | Python-Golden grün (spec §28.4-Vorstufe); Embedding-Cache verhindert Re-Embeds (spec §28.3-Vorstufe); Qdrant-Adapter erfüllt Contract-Suite in-memory-gemockt; Locks + Checkpoints + Resume auf Jobs-Ebene bewiesen; alle 18 Fixtures vorhanden und selbstkonsistent | `pnpm -r typecheck && pnpm -r test && pnpm --filter fixtures run validate` |
| 2 | File-/Symbolgraph persistent + abfragbar via Port (spec §28.7); Impact/Flow/Cycles auf Fixtures korrekt (spec §28.8); Hybrid-Search-Pipeline mit RRF-Regeln und Profiltrennung (spec §28.5/28.6 gegen In-Memory-Store); plugin-sdk-Kompatibilitätscheck funktioniert (spec §28.14-Vorstufe) | `pnpm -r typecheck && pnpm -r test` |
| 3 | Change Reports liefern Deltas + Rename/Move-Kandidaten (spec §28.10); Quality Gate erkennt nur neue Verschlechterungen (spec §28.11); Portfolio-DoD-Punkte 2–9 aus portfolio §17 auf Fixture-Ebene (Determinismus-Doppellauf, Scaffolding-Sicherheitstests) | `pnpm -r typecheck && pnpm -r test` |
| 4 | Ein Use-Case-Kern für alles (arch §31.1): Engine läuft im Library Mode nur mit Testkit-Ports; Vollindex→Stop→Resume→Update konsistent (spec §28.3); Crash-Simulation Abschnitt 5.5 vollständig grün; abgebrochener Index sicher fortsetzbar (arch §31.4) | `pnpm -r typecheck && pnpm -r test && pnpm --filter @untangle-code/core run test:crash` |
| 5 | Alle MCP-Tools (spec §21.1 + portfolio §14.2) bestehen Envelope-Contract-Tests (spec §28.13); Benchmark-Lauf erzeugt Report über allen Ground-Truth-Fixtures und hält Schwellen | `pnpm -r typecheck && pnpm -r test && pnpm --filter benchmarks run eval` |
| 6 | CLI und MCP aus demselben Paket (spec §28.1): `untangle --help`, `untangle mcp --stdio` starten aus dem Build; JSON-Modus schreibt nur JSON auf stdout; CLI-Snapshots grün; Plugins/Extension enthalten keine Engine (arch §31.2, dependency-Tests); Action-Definition validiert | `pnpm -r typecheck && pnpm -r test && pnpm --filter @untangle-code/cli run build && node apps/cli/dist/bin/untangle.js version && node apps/cli/dist/bin/untangle.js search --help` |

Nicht Teil dieses Plans (bewusst nach v1-Code verschoben): spec §28.2 Managed-Container-E2E gegen echtes Docker, spec §28.15 Release-Pipeline mit Signierung/SBOM — beide benötigen CI-Infrastruktur außerhalb des Monorepo-Builds und werden als eigene Betriebs-WPs nach Welle 6 beauftragt.

---

## 7. Risiken und Gegenmaßnahmen

| # | Risiko | Wirkung | Gegenmaßnahme (verbindlich) |
|---|---|---|---|
| R1 | Tree-sitter-Bindings unter Node 22 + ESM: native `node-tree-sitter`-Prebuilds fehlen teils für neue Node-ABIs; CJS-Interop-Probleme | Parser-WPs blockiert; CLI auf Nutzer-Maschinen nicht installierbar | WP-06/WP-09 verwenden `web-tree-sitter` (WASM) als Default-Backend: ABI-unabhängig, ESM-tauglich, keine Build-Toolchain beim Install. Grammatiken als `.wasm` im Package-`assets/`. `LanguageAdapter` kapselt das Backend (arch §6.5: Domain hängt nicht an Node-APIs des Parsers), sodass ein natives Backend später austauschbar ist. Ladezeit-Kosten: lazy load pro Sprache (ADR-005-Konsequenz) |
| R2 | Qdrant Sparse-BM25: serverseitige Text-Inferenz ist nicht in jeder Qdrant-Version/Edition verfügbar; `modifier: idf` erfordert Qdrant ≥ 1.10 | Hybrid Search (spec §28.5) scheitert auf älteren Servern | WP-11 implementiert clientseitige BM25-Term-Gewichtung (Tokenizer + IDF aus eigenem Korpuszähler) und schreibt Sparse-Vektoren selbst; serverseitige Inferenz wird nie vorausgesetzt. `untangle doctor` prüft Qdrant-Version und meldet `QDRANT_SCHEMA_INCOMPATIBLE` mit Handlungshinweis statt Silent-Degrade. Mindestversion wird in WP-11-README dokumentiert und im Provisioning geprüft |
| R3 | Ollama in CI nicht vorhanden | Test-/Benchmark-Läufe schlagen fehl oder werden nichtssagend | Fake Embedder (WP-04) ist Pflicht-Default aller Unit-Tests und des Benchmarks (arch §27.2); Ollama-Contract-Tests laufen gegen HTTP-Mock; Live-Suite ist eigenes vitest-Projekt `@live`, opt-in via `UNTANGLE_TEST_OLLAMA_URL`, niemals CI-Gate |
| R4 | Bytebudget bei Upserts: einzelne Riesenpunkte (große Chunks, Stack Matrix, Blueprints mit Dateilisten) sprengen Request-Limits oder verschwinden still | Datenverlust, spec §10.5-Verstoß | WP-11: Serialisierungsgröße pro Punkt VOR Batch-Aufnahme messen; Flush-Regel arch §11.7; Überschreitung eines Einzelpunkts ⇒ Multipart-Split mit `logical_shard_id/part_index/part_count/write_id/checksum` oder `POINT_TOO_LARGE` mit Identifikation — nie stiller Drop. Contract-Test mit synthetischem 10-MB-Punkt ist Pflichtbestandteil der WP-11-Abnahme |
| R5 | Cross-Repo-Resolver-Lücken (TS paths, pnpm-Workspaces, Python-Namespaces): unaufgelöste Imports verfälschen Graph, Portfolio-Import-Evidenz und Blast Radius | falsche Impact-/Radar-Aussagen | Unresolved ist ein sichtbarer Zustand, nie eine geratene Kante (spec §14.3, arch §17.2); `resolved_import_ratio` als Metrik + Health-Ausgabe; Resolver-Pipeline erweiterbar (`ImportResolver`-Port), Reihenfolge arch §16.2; Fixtures 03/16 messen die Rate; Portfolio kennzeichnet Profile mit `importGraphAvailable=false` als unvollständig statt falsch |
| R6 | Parser-/Grammatik-Lizenzen: Tree-sitter-Grammatiken haben teils uneinheitliche Lizenzen; Clean-room-Grenze arch §2.4 | Release-Blocker bei npm-Publish | WP-06/WP-09 führen `THIRD_PARTY_LICENSES.md` je Package mit Lizenz jeder eingebetteten Grammatik (nur MIT/Apache-2.0/BSD zulässig; GPL-Grammatiken ausgeschlossen); CI-Skript (WP-00 `scripts/check-licenses.mjs`) prüft `license`-Felder aller prod-Dependencies gegen Allowlist; fremder Quellcode wird nicht kopiert (arch §2.4) |
| R7 | Contract-Drift zwischen parallelen Wellen (z. B. WP-19 erwartet anderes `VectorStore`-Query-Shape als WP-11 liefert) | Integrationsbruch in Welle 4 | Abschnitt 3 friert Contracts in Welle 0 ein; Änderungen an domain nach Welle 0 nur additiv und nur durch ein dediziertes Change-Ticket an WP-01-Besitzer; WP-04-Contract-Suites sind die gemeinsame Wahrheit (Adapter UND Konsumenten testen gegen dieselbe Suite) |
| R8 | `pnpm-workspace`-/Root-Konflikte bei paralleler Arbeit | Merge-Konflikte, kaputter Install | Root-Dateien haben genau einen Besitzer (WP-00) und decken alle künftigen Packages per Glob ab; kein anderes WP editiert Root (Abschnitt 4) |

---

## 8. Entscheidungen dieses Plans (offen Gelassenes aus den Quelldokumenten)

1. **watcher-Welle:** `packages/watcher` fehlt in der vorgegebenen Wellenliste, ist aber Teil von arch §5. Entscheidung: eigenes WP-14 in Welle 1 (hängt nur an scanner/domain). Begründung: Jobs (WP-13) und core (WP-23) konsumieren ihn, also muss er vor Welle 4 existieren.
2. **apps/mcp-server vs. ADR-005:** spec §2.2 legt die MCP-Runtime in `@untangle-code/cli`; arch §5 führt `apps/mcp-server` als eigenes Verzeichnis. Entscheidung: `@untangle-code/cli` besitzt Tool-Handler, Envelope, Transport und den öffentlichen Export `./mcp`. `apps/mcp-server` ist ein privater, einseitiger Kompatibilitäts-Wrapper und importiert diesen Export; die CLI importiert den Wrapper nie. So gibt es genau eine MCP-Implementierung und eine öffentliche Distribution.
3. **plugin-sdk vorgezogen:** in der Auftragsliste nach den Apps genannt, benötigt aber nur domain+config (arch §7.4). Entscheidung: Welle 2, damit Welle 6 (Extension + 4 Plugins) nicht serialisiert wird.
4. **Portfolio ohne change-engine-Import:** portfolio.md §2.3 nennt Change Intelligence als Quelle. Entscheidung: Kopplung ausschließlich über Domain-Typen (`ChangeEventV1`) und `MetadataStore`-Reads, damit WP-21 und WP-22 in derselben Welle parallel laufen können; fehlende Historie ⇒ dokumentiertes Degradationsverhalten (`trend: "unknown"`, leere `firstSeenAt`).
5. **Fixtures konsolidiert:** spec §27.2 Nr. 1 und portfolio §16.2 Nr. 1 (TS-Monorepo) sowie spec Nr. 2 und portfolio Nr. 2 (Python) werden je in einer Fixture zusammengeführt (18 statt 20 Verzeichnisse), Anforderungen beider Listen bleiben vollständig abgedeckt.
6. **Config-Typen in packages/config:** domain bleibt frei von Konfigurationsschemata; Engine-Packages erhalten validierte, bereits aufgelöste Options-Objekte (arch §6.3 „kanonische Effective Config").
7. **BM25 clientseitig:** siehe R2 — normativ für WP-11, da spec §10.2 nur das Sparse-Schema, nicht den Erzeugungsort festlegt.
8. **schemas/-Besitz:** arch §5 führt `schemas/` als Top-Level; Besitzer ist WP-02 (config), da die JSON-Schemas dort erzeugt und getestet werden; apps/cli kopiert sie beim Build in sein `files`-Set (product §6.3).

---

## 9. Nachgetragene Arbeitspakete A3/A4 (Anforderungen aus dem Auftrag, nach `build-plan-v1` ergänzt)

Diese Arbeitspakete stammen aus zwei nachgereichten Anforderungen. Sie sind **additiv**: sie ändern
weder das Identitätsmodell aus `spec.md` §5 noch bereits gebaute Verträge in `packages/domain`.

### A3 — Monorepo- und Service-Topologie

**Neue erstklassige Entität `Project`** zwischen `Repository` und `File`. `project_id` ist ein
**Attribut** von Datei-, Symbol- und Chunk-Payloads, **nicht** Bestandteil der Id-Ableitung
(`spec.md` §5.4/§5.5 bleiben wortgleich gültig — dadurch ist die Erweiterung nicht brechend).
Projektarten: `app`, `service`, `worker`, `library`, `cli`, `infra`, `e2e`, `docs`.

| ID | Package / Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-40 | `monorepo.md` (Dokument, `monorepo-v1`) | Normative Spec: `Project`-Entität, Erkennungsregeln, interne Verlinkung, Deployment-Topologie, Wirkung auf Search/Impact/Gate/Portfolio; Abschnitt „Integration in bestehende Dokumente" | spec §5, §14, §27.2; arch §16.3; portfolio §6–§11 | — | M | Dokument existiert mit normativer Sprache; definiert `ProjectRecordV1`, `ProjectEdgeV1`, `ServiceRecordV1`, `TopologyV1`, `RuntimeEdgeV1` mit `schemaVersion` + Provenienz + Konfidenz; nennt je Manifesttyp die Erkennungsregel |
| WP-41 | `packages/project-graph` (privat) | Projekt-Detektion und interner Projektgraph: pnpm/npm/yarn workspaces, turbo/nx, tsconfig `references`/`paths`, go.work, cargo members, maven/gradle, dotnet `.sln`, pyproject/uv, composer path-repos; Kanten aus `workspace:*`, `file:`-Deps, Projektreferenzen, Aliassen; SCC/Zyklen auf Projektebene | WP-40; spec §14.3; arch §16.3 | WP-01, WP-05, WP-17 | L | Fixture-Monorepo mit 4 Projekten liefert exakt 4 `ProjectRecordV1` mit korrekter Art; `workspace:*`-Kante wird mit Confidence `unique` erkannt; Projektzyklus wird gefunden; unaufgelöste interne Deps werden gezählt |
| WP-42 | `packages/deploy-topology` (privat) | Deployment-Topologie: docker-compose (Services, `build.context` → Projekt, `depends_on`, Ports, Netzwerke, Volumes), Dockerfile-Stages, k8s-Manifeste, Helm-Charts, Procfile; Laufzeitkanten (Service→Service über Env-URLs, Queue-/Topic-Namen, HTTP-Clients) **ausdrücklich als Heuristik markiert** | WP-40; spec §19; arch §20 | WP-01, WP-15, WP-41 | L | compose mit `frontend`/`backend`/`worker` ergibt 3 `ServiceRecordV1`, jeder mit aufgelöstem `projectId`; `depends_on` erzeugt gerichtete Kanten; **Env-Werte werden nie persistiert**, nur Schlüsselnamen; Heuristikkanten tragen `confidence` < `unique` |
| WP-43 | Integration `--project` | Projektfilter und -aggregation in Search, Impact, Complexity, Hotspots, Changes, Gate; Blast Radius bis auf Service-Ebene („Änderung trifft `worker` und `frontend`"); Quality Gates pro Projekt | spec §13.1, §15.3, §16.10, §18 | WP-19, WP-21, WP-41, WP-42 | M | `untangle query … --project backend` filtert nachweislich; `untangle impact <symbol>` nennt betroffene Services namentlich; Gate-Ergebnis ist pro Projekt gruppierbar |
| WP-44 | Fixture `monorepo-multi-service` | pnpm-Monorepo: `frontend` + `backend` + `worker` + `shared` lib, verbunden per `workspace:*`, dazu `docker-compose.yml` mit drei Services und `depends_on`; ergänzt die Pflicht-Fixtures | spec §27.2 | WP-16 | S | Fixture wird von WP-41 und WP-42 in Tests verwendet; Ground-Truth-Datei nennt erwartete Projekte, Kanten und Services |

**Wirkung auf `portfolio.md` (WP-22):** Archetypen und Blueprints werden auf **Projekt**-Ebene
klassifiziert, nicht nur auf Repo-Ebene. Neues Blueprint-Kind `monorepo-multi-service` mit
Compose-Skelett für `frontend`/`backend`/`worker`.

### A4 — `untangle query`: vereinheitlichte Retrieval-Oberfläche

Zielmarke ist der Funktionsumfang moderner lokaler Hybrid-Suchwerkzeuge; die Umsetzung ist
Clean Room nach `vision.md` §14 (eigene Implementierung, eigene Tool- und Flagnamen, keine
Codeübernahme).

| ID | Package / Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-45 | `query.md` (Dokument, `query-v1`) | Normative Spec der Query-Oberfläche: Routen, Flags, Filter, Preview-Politik, Freshness-Semantik, Fusion, Antwortschema `QueryResponseV1` | spec §13, §20, §21 | — | M | Dokument definiert alle Routen und Flags normativ; `QueryResponseV1` mit `freshness`, `skipped[]`, `scoreComponents`, `routes[]`; Abschnitt „Integration in bestehende Dokumente" |
| WP-46 | `packages/query` (privat) | Routen-Orchestrator über WP-19: `--hybrid` (Default), `--fts`, `--vector`, `--rg`, `--fuse` (Multi-Query mit dokumentierter RRF-Variante); Route-Auswahl, Score-Breakdown je Route | WP-45; spec §13.2–§13.5 | WP-19 | L | Jede Route einzeln testbar; `--fuse` mit drei Teilqueries erzeugt eine Rangfolge mit nachvollziehbaren Beiträgen je Teilquery; Routenwahl erscheint in der Antwort |
| WP-47 | `packages/literal-search` (privat) | `--rg`-Route: verwaltete, sandboxed Literal-/Regex-Suche **ohne Index**; nutzt vorhandenes ripgrep, sonst eigener Walker mit identischer Ergebnisform; Pfad-Sandbox wie WP-01 | WP-45; arch §23.1 | WP-01, WP-05 | M | Ergebnisse identisch (Form und Reihenfolge) mit und ohne installiertes ripgrep; funktioniert **vor** dem ersten Index; kein Shell-Injection-Pfad (Argumentliste, keine Shell) |
| WP-48 | Query-Filter-Erweiterung | Scope `-g/--glob`, `--iglob`, `-t/--type`, `-T/--type-not` (eigenes Typ-Set), `--repo/--ref/--project`; `--prefer-symbol`, `--symbol-type`; `--modified-after/--modified-before`; analytische Filter `--cognitive-min`, `--cyclomatic-min`, `--risk-min`, `--mi-max`, `--changed-since`, `--impacts`, `--called-by`, `--in-cycle`, `--hotspot`, `--uses <technology>` | WP-45; spec §13.1, §16, §17; portfolio §7 | WP-46, WP-21, WP-22, WP-43 | L | Jeder Filter hat einen Test mit Fixture-Ground-Truth; analytische Filter werden als Qdrant-Payloadfilter ausgeführt, nicht nachträglich im Speicher |
| WP-49 | Preview-, Freshness- und Skip-Politik | Default **ohne** Chunk-Inhalt (tokenarm für Agents), `--preview none\|short\|full`, `--human`; Antwort-Freshness `fresh\|possibly_stale\|incomplete` **mit Grund**, `--refresh`; **Skip-Ledger**: jede übersprungene Datei mit Grund in Antwort und `status` | WP-45; vision §8.4; spec §11.2, §12 | WP-46, WP-13 | M | Default-Antwort enthält keinen Quelltext; `possibly_stale` nennt die Ursache; eine übergroße Datei erscheint nachweislich im Skip-Ledger statt still zu verschwinden |
| WP-50 | `packages/server` + `untangle server` | Geteilter Daemon: `on\|off\|status\|run`, loopback-only, Bearer-Token, Streamable-HTTP-MCP **zusätzlich** zu stdio; ein Watcher und ein Modellpool je Workspace. Hebt arch §4.2 von „später optional" auf Version 1 | WP-45; arch §4.2, §21; spec §21.3 | WP-23, WP-24, WP-13 | L | Zwei Clients teilen nachweislich einen Index und einen Watcher; Bindung ausschließlich an 127.0.0.1; Anfrage ohne Token wird abgelehnt; `off` beendet sauber ohne verwaiste Locks |
| WP-51 | MCP-Toolsets + `untangle install` | Toolsets `agent` (nur `untangle_query`) und `full`; `untangle install\|uninstall --target claude\|cursor\|codex\|vscode\|opencode\|all\|auto` schreibt Host-Konfiguration idempotent und reversibel | WP-45; product §7.2; spec §21 | WP-24, WP-20 | M | `install` zweimal ausgeführt erzeugt keine Duplikate; `uninstall` stellt den Ausgangszustand her; Toolset `agent` exponiert genau ein Tool |
| WP-52 | `packages/embeddings-static` (privat) | Zweiter `EmbeddingProvider` neben Ollama: lokales statisches Kleinmodell **ohne Serverzwang**, damit `npx untangle index` ohne Vorinstallation läuft. Profil-Trennung nach spec §5.7 unverändert | WP-45; spec §9, §5.7; arch ADR-002 | WP-01, WP-10 | L | Index und Suche laufen vollständig ohne Ollama und ohne Netzwerk; erzeugtes `embedding_profile_id` unterscheidet sich vom Ollama-Profil; Kollektionen werden **nicht** vermischt (spec §13.4) |
| WP-53 | `untangle config` / `untangle auth` | Provider-Credentials und explizite Freigabe für Remote-Embeddings; Secrets nur aus Env/Secret-Store, nie in Projektconfig oder Dumps | WP-45; spec §24; arch §23.2 | WP-02, WP-03 | S | Kein Secret erscheint in `config show`, Logs oder Crash-Reports (Test); Remote-Nutzung erfordert eine explizite, persistierte Zustimmung |

**Rückwärtskompatibilität:** `untangle search <query>` bleibt bestehen und ist ein Alias auf
`untangle query --hybrid`. `spec.md` §20.2 und §21.1 werden entsprechend erweitert, nicht ersetzt.

### Einordnung in die Bauwellen

- WP-40 und WP-45 (beide Dokumente) laufen **vor** Welle 1 als Design-Stufe.
- WP-52 gehört in dieselbe Welle wie WP-10 (Embeddings).
- WP-41/WP-42/WP-44 gehören in die Welle von WP-17 (file-graph), da sie dieselben Manifest-Parser nutzen.
- WP-46–WP-49 gehören in die Welle **nach** WP-19 (search).
- WP-50/WP-51/WP-53 gehören in die Welle von WP-26 (apps/cli) bzw. WP-24 (mcp-server).
- WP-43 ist die letzte Integrationsstufe vor den Plugin-Wellen.

---

## 10. Nachgetragene Arbeitspakete A5 (Distribution und funktionale Abnahme)

### Verifizierte lokale Umgebung (Stand 2026-09-03, auf der Entwicklungsmaschine gemessen)

| Komponente | Befund | Konsequenz |
|---|---|---|
| Repository | `https://github.com/lboel/untangle.git` | kanonische URL für Installer und Manifeste |
| Lizenz | AGPL-3.0-only | Daemon braucht §13-„Source"-Hinweis (WP-50) |
| Ollama | 0.33.2, nativ auf `127.0.0.1:11434` | `mode: "auto"` findet es ohne Container |
| Embedding-Modell | `qwen3-embedding:0.6b`, **1024 Dimensionen**, Kontext 32768, Q8_0 | Abnahmeprofil; `nomic-embed-text`/768 bleibt Default der Spec |
| Qdrant | 1.18.0 erreichbar auf `127.0.0.1:6333` (fremde Instanz) | Abnahme startet **eigene** Instanz auf 16333 gemäß spec §3.1; fremde Instanz wird nicht angefasst (spec §3.2) |
| Docker | 29.5.2 | `docker/docker-compose.yml` ist real testbar |

### Arbeitspakete

| ID | Package / Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-54 | `install.sh` (Repo-Root) + `scripts/install/` | **One-Line-Install über bash**: `curl -fsSL https://raw.githubusercontent.com/lboel/untangle/main/install.sh \| sh`. Erkennt OS/Arch, prüft Node `>=22.12`, installiert `@untangle-code/cli` global oder legt einen `~/.local/bin/untangle`-Shim an, prüft Ollama/Qdrant und meldet fehlende Voraussetzungen mit konkreter Abhilfe. `--target <host>` reicht an WP-51 durch. POSIX-`sh`, kein bashism, `set -eu`, idempotent, `--dry-run`, `--uninstall` | product §6.4; WP-51 | WP-51 | M | Skript läuft unter `sh` und `bash` auf macOS und Linux; zweimaliges Ausführen erzeugt keinen zweiten Eintrag; `--dry-run` schreibt nichts; `shellcheck` ohne Fehler; ohne Node bricht es mit verständlicher Anleitung ab statt still zu scheitern |
| WP-55 | One-Line-Installs je Host | Für **jeden** unterstützten Host genau ein Kommando, dokumentiert in README und `docs/install.md`: `npx -y @untangle-code/cli install --target claude` (Claude Code), `--target codex` (Codex), ferner `cursor`, `vscode`, `opencode`, `qwen`, `gemini`, `all`, `auto`. Schreibt die Host-Konfiguration **idempotent und reversibel**, legt Backups an, meldet den geschriebenen Pfad | product §7.2; spec §21; WP-51 | WP-51, WP-24 | M | Je Host ein Test, der die erzeugte Konfigurationsdatei gegen ein Golden vergleicht; `uninstall` stellt Byte-Identität mit dem Backup her; ein bereits vorhandener fremder MCP-Eintrag wird nicht überschrieben |
| WP-56 | README-Abschnitt „Installation" | Genau ein sichtbarer Ein-Zeiler je Weg: bash-Installer, `npx`, global npm, projektlokal, plus je Host eine Zeile. Kein Weg wird beworben, der nicht implementiert ist; nicht veröffentlichte Pakete sind ausdrücklich als solche markiert | product §6.4 | WP-54, WP-55 | S | Jeder in der README gezeigte Befehl existiert entweder als Test oder ist explizit als „noch nicht veröffentlicht" gekennzeichnet |
| WP-57 | `packages/testkit/acceptance` + `scripts/acceptance/dogfood.mjs` | **Funktionale Abnahme auf dem Untangle-Repo selbst** (Dogfooding) mit **lokalem Ollama und `qwen3-embedding:0.6b`**: eigene Qdrant-Instanz auf 16333 hochfahren, `.untangle.acceptance.json` mit Profil `ollama/qwen3-embedding:0.6b/1024` erzeugen, das Repository vollständig indexieren, dann eine feste Ground-Truth-Fragenliste ausführen und Recall@5/@10 und MRR gegen Schwellen prüfen. Danach: inkrementelles Update ohne Änderung darf **null** Embedding-Aufrufe erzeugen; eine Dateiänderung muss innerhalb der Zielzeit sichtbar werden; `changes analyze` und `gate` gegen `HEAD~1` laufen lassen; Skip-Ledger und Coverage-Invariante prüfen. Am Ende Container und Collections wieder entfernen | spec §26, §27.3, §28; vision §11.2, §11.3 | WP-26, WP-19, WP-10, WP-11, WP-21 | L | Lauf ist ein einziges Kommando `pnpm acceptance:dogfood`; er endet mit Exit 0 nur bei erfüllten Schwellen; Bericht als JSON + Markdown mit gemessenen Werten (Indexdauer, Embedding-Aufrufe, Recall@5/@10, MRR, P95-Suchlatenz, Parse-Failure-Quote, Import-Resolution-Rate); der Lauf ist **nicht** Voraussetzung für die schnellen Unit-Suites |
| WP-58 | Ground-Truth `fixtures/acceptance/untangle-selfindex.json` | Mindestens 25 Fragen an die eigene Codebasis mit erwarteten Dateien/Symbolen und verbotenen Treffern, z. B. „wo wird die Cognitive-Komplexität berechnet", „wo wird das Embedding-Profil gehasht", „wo wird die Coverage-Invariante erzwungen", „welcher Code startet den verwalteten Qdrant-Container" | spec §27.3 | WP-57 | M | Fragen decken alle Hauptpakete ab; jede Frage hat mindestens eine erwartete Datei; die Datei wird bei Umbenennungen im CI-Lauf als veraltet erkannt |
| WP-59 | AGPL-§13-Quelltexthinweis | Der Daemon-/Server-Modus (WP-50) und die MCP-`untangle_about`-Antwort nennen Lizenz, Version, Commit und die URL des Quelltexts | LICENSE; arch §4.2 | WP-50, WP-24 | S | `untangle server status` und `untangle_about` enthalten nachweislich Lizenz und Quelltext-URL |

### Einordnung

- WP-54–WP-56 laufen in derselben Welle wie WP-51 (`apps/cli`).
- WP-57/WP-58 sind die **letzte** Welle vor dem ersten Release-Kandidaten; sie sind die
  eigentliche Antwort auf „funktioniert es wirklich" und ersetzen keine Unit-Tests.
- WP-59 hängt an WP-50 und ist Lizenzpflicht, nicht Kür.

---

## 11. Nachgetragenes Arbeitspaket A6 (Branch- und Worktree-Bewusstsein)

Anforderung: Suche und Analyse müssen **branch- und worktree-aware** sein. Menschen und
besonders Agents arbeiten parallel in mehreren Branches und in mehreren `git worktree`-
Auschecks desselben Repositories. `spec.md` §5.3 kennt `ref_id` bereits, aber nirgends ist
festgelegt, wie ein Worktree auf Repository- und Ref-Identität abgebildet wird. Ohne diese
Regel entstehen doppelte `repo_id`, doppelte Embedding-Kosten und getrennte Graphen für
dasselbe Repository.

| ID | Package / Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-60 | `packages/git-topology` (privat) + Spec-Ergänzung in `monorepo.md` | Repository- und Ref-Auflösung: erkennt Haupt-Checkout und Linked Worktrees (`.git`-Datei mit `gdir`-Verweis, `git worktree list --porcelain`), bildet **einen** `repo_id` je Repository (über kanonische Remote-URL bzw. gemeinsames Git-Verzeichnis) und **je Worktree einen eigenen** `ref_id`; liefert Branch, Commit, Dirty-Status, Detached-Head und Bare-Repos; erkennt Submodule und meldet sie explizit statt sie stillschweigend mitzuindexieren | spec §5.2, §5.3, §12; arch §19.1 | WP-01, WP-05 | M | Zwei Worktrees desselben Repos ergeben denselben `repo_id` und zwei verschiedene `ref_id`; ein Worktree auf `detached HEAD` wird korrekt als Commit-Ref geführt; ein Submodul wird gemeldet und nicht als Teil des Elternrepos indexiert |
| WP-61 | Ref-Sharing im Index | Mehrere Refs desselben Repos teilen Embedding-Cache und Paketidentität: eine Datei mit identischem `content_hash` in zwei Refs erzeugt **keinen** zweiten Embedding-Aufruf; Punkte werden je `ref_id` upsertet, der Cache greift über den Ref hinweg | spec §9.4, §12.1; vision §8.3 | WP-60, WP-10, WP-11 | M | Index von Worktree B nach Worktree A erzeugt für unveränderte Dateien **null** Embedding-Aufrufe (Zähler `embeddings_requested` aus spec §23.3 wird geprüft) |
| WP-62 | Ref-Scope in Query und Analyse | `--ref` und `--all-refs` in `untangle query`; jedes Ergebnis weist seinen Ref aus; Dedupe berücksichtigt `ref_id` (arch §18.4); `changes analyze --base <ref> --head <ref>` funktioniert über Worktree-Grenzen hinweg; Watcher und Locks arbeiten je `repo_id:ref_id` und blockieren sich nicht gegenseitig | spec §13.1, §17.1, §12.3; arch §21.1 | WP-60, WP-46, WP-21 | M | Suche über zwei Refs liefert beide Treffer mit korrekter Ref-Kennzeichnung; gleichzeitige Updates zweier Worktrees laufen ohne Lock-Konflikt; ein Diff zwischen zwei Worktrees liefert korrekte Complexity-Deltas |
| WP-63 | Fixture `multi-worktree` | Ein Fixture-Repo mit Haupt-Checkout plus zwei Linked Worktrees auf unterschiedlichen Branches, davon einer mit `detached HEAD`, plus ein Submodul | spec §27.2 | WP-16 | S | Wird von WP-60 bis WP-62 in Tests genutzt; Ground Truth nennt erwartete `repo_id`/`ref_id`-Paare |

### Einordnung

WP-60 gehört in die Welle von WP-17 (file-graph), da es dieselbe Git- und Manifestschicht nutzt.
WP-61 hängt an den Adaptern (WP-10/WP-11), WP-62 an der Query-Welle. WP-63 zieht mit WP-16.

**Nachtrag in `docs/PARITY.md`:** Zeile B20 verweist auf WP-60.

---

## 12. Unveränderliche Projektentscheidungen

Diese Punkte sind vom Projektinhaber ausdrücklich angewiesen. Kein Agent und kein
Werkzeug darf sie ohne erneute ausdrückliche Anweisung ändern. Wer sie in einer
Datei abweichend vorfindet, korrigiert die Datei — nicht die Entscheidung.

| # | Entscheidung | Wo sie steht |
|---|---|---|
| E1 | **Lizenz: `AGPL-3.0-only`.** Volltext in `LICENSE`, Begründung in `NOTICE`, `"license": "AGPL-3.0-only"` in **jeder** `package.json` des Workspace. Nicht Apache-2.0, nicht MIT. Die Allowlist in `scripts/check-licenses.mjs` gilt nur für Abhängigkeiten Dritter, nicht für die eigenen Pakete. | `LICENSE`, `NOTICE`, alle `package.json` |
| E2 | **Keine Fremdproduktnamen im Repository.** Zielmarken werden funktional beschrieben, nie namentlich. Clean Room nach `vision.md` §14. | alle Dateien |
| E3 | **Dokumentation Deutsch, Code Englisch.** Markdown auf Deutsch mit englischen Fachbegriffen; Bezeichner, Code-Kommentare, Fehlermeldungen, Log-Events und Testnamen auf Englisch. | alle Dateien |
| E4 | **Kein stilles Überspringen von Inhalt.** Übersprungene Dateien und Bereiche kommen mit Grund in ein Skip-Ledger und erscheinen in `query`- und `status`-Ausgaben (`vision.md` §8.4). | WP-07, WP-49 |
| E5 | **Kein Agentenbericht ersetzt einen Testlauf.** `verifiziert` in `docs/PARITY.md` wird nur vergeben, wenn der Lauf tatsächlich ausgeführt und die Ausgabe gelesen wurde. | `docs/PARITY.md` |

### Nachtrag zu A6 — aus der Gegenprüfung von Welle 1b

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien |
|---|---|---|---|---|---|---|
| WP-64 | `packages/scanner/src/discovery.ts` | `decodeSampleText()` dekodiert die Inhaltsprobe **immer als UTF-8**, unabhängig vom durch `classifyBinarySample` erkannten `encoding` (`utf16le`/`utf16be`). Für BOM-lose UTF-16-Dateien entsteht Mojibake im `sampleText`; erweiterungslose Skripte mit Shebang werden dadurch falsch klassifiziert. Fix: Dekodierung nach erkanntem Encoding, Fallback UTF-8. | spec.md §6.1; E4 | WP-05 | S | Erweiterungsloses Shebang-Skript als UTF-16LE **ohne** BOM wird korrekt als dessen Sprache erkannt; UTF-8-Verhalten unverändert; Regressionstest für beide Fälle |
| WP-65 | Migrationsnotiz `chunkerVersion` | `property_group`-Chunks tragen seit Welle 1b `metricsScope: "symbol"` statt `"chunk"` — das ändert den Dedupe-Schlüssel (`architecture.md` §18.4). Bestehende Indizes brauchen nach `chunkerVersion`-Bump eine Neuindexierung. | arch §18.4, §2.3 | WP-07 | S | `chunkerVersion` ist gebumpt; Migrationsnotiz in `docs/` und in der Package-README; Test, dass alter und neuer Dedupe-Schlüssel unterscheidbar sind |

---

## 13. Nachgetragene Arbeitspakete A7 — Analyzer-Extensions (externe Werkzeuge als Evidenzquelle)

Anforderung: Untangle soll optional externe Analysewerkzeuge über Docker mit hochfahren und auf
ihnen aufbauen können — SonarQube, Semgrep und weitere — um Tiefenanalysen zu fahren, die über
das hinausgehen, was Untangle selbst deterministisch erhebt.

### Leitentscheidungen (verbindlich, gehören nach `extensions.md`)

| # | Entscheidung | Begründung |
|---|---|---|
| X1 | **Extensions sind strikt opt-in.** Kein Container wird ohne ausdrückliche Nutzeranweisung gestartet. `untangle index` ohne Extension-Konfiguration verhält sich exakt wie heute. | Local-first (`vision.md` §7.4); Extensions kosten RAM, CPU und Startzeit. SonarQube allein braucht ~2 GB. |
| X2 | **Untangle bleibt ohne jede Extension voll funktionsfähig.** Keine Kernfunktion darf eine Extension voraussetzen. Fehlt eine, degradiert das Ergebnis sichtbar (`extensionsUnavailable[]`), es bricht nicht ab. | `spec.md` §25.2: Read-Operationen degradieren kontrolliert. |
| X3 | **Externe Befunde sind `ExternalFindingV1`, niemals Untangle-Metriken.** Sie werden getrennt geführt, tragen `tool`, `toolVersion`, `ruleId`, `ruleset`, `rulesetVersion` und `confidence` und erscheinen nie in `ComplexitySnapshotV1`. | `vision.md` §10 verbietet wörtlich nur „rohe **LLM**-Bewertungen als objektive Qualitätsmetriken" — die Analogie auf Werkzeugbefunde ist eine **Erweiterung**, keine Ableitung, und wird hier ausdrücklich als solche getroffen. Der tragende Grund ist ein anderer und stärker: Untangles Complexity-Werte sind deterministisch, versioniert und golden-getestet (`architecture.md` §2.3, §15.2). Ein Fremdwert wäre keines davon — er hängt an Werkzeugversion und Regelsatz. Beides zu mischen würde die Reproduzierbarkeit der eigenen Zahlen und die delta-first-Quality-Gates (`spec.md` §18.1) zerstören. |
| X4 | **Aufruf ausschließlich über Prozess- oder HTTP-Grenze.** Kein Vendoring, kein Linken, kein Einbetten fremden Codes. Images werden gezogen, nicht mitgeliefert. | Hält die AGPL-Grenze sauber (E1, `vision.md` §14): der Aufruf eines eigenständigen Prozesses ist Aggregation, kein kombiniertes Werk. **Korrektur 2026-09-04:** die ursprüngliche Angabe „SonarQube Community ist LGPL-3.0" war falsch. Nur der **Kern** ist LGPL-3.0; die gebündelten **Analyzer** — also die eigentliche Scan-Engine — stehen seit 29.11.2024 unter der *Sonar Source-Available License v1.0*, einer nicht-OSI-Lizenz. SonarQube ist damit ein **Pflichtfall für das Lizenz-Gate nach X5**, gleichrangig mit CodeQL. Ebenso stehen die Semgrep-**Registry-Regelsätze** (einschließlich des Defaults `p/ci`) unter der *Semgrep Rules License v1.0* mit eigenen Beschränkungen — die Engine-Lizenz allein genügt hier nicht, das Gate greift über den Regelsatz. Alle Lizenzangaben sind Recherchestand und vor Nutzung zu verifizieren; die maßgebliche Fassung steht in `extensions.md` §9 und §12. |
| X5 | **Lizenz-Gate vor dem ersten Lauf.** Jedes Extension-Manifest deklariert Lizenz und Nutzungsbeschränkung. Werkzeuge mit einschränkenden Bedingungen (etwa CodeQL, dessen Nutzung außerhalb bestimmter Fälle beschränkt ist) verlangen eine ausdrückliche, persistierte Bestätigung, bevor sie erstmals laufen. | Nutzer sollen nicht unwissentlich Lizenzbedingungen verletzen. |
| X6 | **Gepinnte Image-Digests, keine `latest`-Tags.** Reproduzierbarkeit und Supply-Chain-Sicherheit wie bei Qdrant/Ollama (`architecture.md` §23.3). | Ein wanderndes Image ändert stillschweigend Befunde. |
| X7 | **Externe Befunde sind erstklassige Filter- und Change-Dimension.** `untangle query --finding semgrep:<rule>`, `--severity high`, und in der Change-Analyse „diese Änderung erzeugt N neue Befunde". | Das ist der eigentliche Mehrwert: Untangle verbindet fremde Befunde mit Symbol, Graph, Blast Radius und Historie — das kann keines der Werkzeuge für sich. |
| X8 | **Cross-Validierung statt Doppelung.** Wo ein externes Werkzeug dieselbe Größe misst wie wir (Sonar/lizard/radon: cyclomatic complexity), wird es in der Benchmark-Suite als **Gegenprobe** unserer eigenen Zahlen genutzt, nicht als Ersatz. Systematische Abweichungen sind ein Testbefund. | Härtet `packages/complexity` gegen stille Rechenfehler — genau die Fehlerklasse, die in Welle 1 nur durch adversariale Prüfung auffiel. |

### Arbeitspakete

| ID | Package / Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-66 | `extensions.md` (Dokument, `extensions-v1`) | Normative Spec: Extension-Manifest, Lebenszyklus, `ExternalFindingV1`, Normalisierung auf Datei/Symbol/Range, Provenienz und Confidence, Lizenz-Gate, Ressourcenpolitik, Sicherheitsgrenzen, CLI-/MCP-Oberfläche, Nicht-Ziele. Enthält Abschnitt „Integration in bestehende Dokumente" | spec.md §3, §19, §24, §25; arch §20, §23.3; vision §7.1, §10 | — | M | Dokument definiert `ExtensionManifestV1`, `ExternalFindingV1`, `ExtensionRunV1`, `ExtensionHealthV1` mit `schemaVersion`, Provenienz und Confidence; Leitentscheidungen X1–X8 sind normativ formuliert |
| WP-67 | `packages/extensions` (privat) | Extension-Runtime: Manifest-Laden und -Validieren, Fähigkeits- und Verfügbarkeitsprüfung (Binary im PATH vs. Container), Lebenszyklus `detect → provision → health → run → collect → normalize → teardown`, Ergebnis-Normalisierung auf Untangle-Entitäten, Fehler als `EXTENSION_UNAVAILABLE` / `EXTENSION_FAILED` / `EXTENSION_LICENSE_UNACKNOWLEDGED`, Zeit- und Speicherbudget je Lauf, Abbruch über `AbortSignal` | WP-66; spec.md §22, §25.1 | WP-01, WP-03, WP-12 | L | Ein Fake-Extension-Adapter durchläuft den vollen Lebenszyklus im Test ohne Docker; fehlende Extension erzeugt `EXTENSION_UNAVAILABLE` und degradiert das Gesamtergebnis sichtbar statt abzubrechen; Budgetüberschreitung bricht sauber ab |
| WP-68 | `packages/extensions/src/adapters/semgrep` | Semgrep-Adapter: Ausführung als CLI (falls im PATH) oder Container, Regelsatz konfigurierbar (`p/ci`, eigene Regeln), JSON-Ausgabe → `ExternalFindingV1` mit Datei, Zeilenbereich, `ruleId`, Severity; Zuordnung zum umschließenden **Symbol** über den Symbolindex, nicht nur zur Datei | WP-66, WP-67 | WP-67, WP-18 | M | Golden-Test mit echter Semgrep-JSON-Ausgabe → erwartete Findings mit korrektem Symbolbezug; unbekannte Felder brechen nicht; Semgrep-Abwesenheit überspringt den Test sauber |
| WP-69 | `packages/extensions/src/adapters/sonarqube` | SonarQube-Adapter: verwalteter Container mit gepinntem Digest, Healthcheck, persistentem Volume, Scanner-Lauf, Ergebnisabruf über Web-API, Quality-Gate-Status → `ExternalFindingV1` plus `ExtensionRunV1`; Token kommt aus Env/Secret-Store, nie aus der Projektconfig | WP-66, WP-67; spec.md §24 | WP-67 | L | Compose-Fragment startet SonarQube auf einem Loopback-Port mit Label `dev.untangle.managed=true`; Integrationstest überspringt sich ohne Docker; kein Token in `config show`, Logs oder Crash-Report |
| WP-70 | Weitere Adapter (Auswahl nach Bedarf) | Ruff und Bandit (Python), ESLint (bestehende Projektkonfiguration wiederverwenden), jscpd (Duplikate), OSV-Scanner und Trivy (Abhängigkeits-CVEs), Syft (SBOM), lizard bzw. radon (Complexity-**Gegenprobe** nach X8) | WP-66, WP-67 | WP-67 | L | Je Adapter ein Golden-Test gegen echte Werkzeugausgabe; der Complexity-Gegenproben-Adapter meldet systematische Abweichungen zu `packages/complexity` als Testbefund |
| WP-71 | Docker-Integration und `untangle extensions` | `docker/extensions/*.yml` als eigenständige, zuschaltbare Compose-Fragmente; CLI `untangle extensions list\|enable <id>\|disable <id>\|status\|run <id>\|logs <id>`; MCP-Tools `untangle_extensions` und `untangle_extension_run`; Ressourcenhinweise (RAM/CPU) werden **vor** dem Start angezeigt | WP-66; product.md §5; spec.md §3.1, §21 | WP-67, WP-26, WP-24 | M | `enable` startet nichts ohne Bestätigung; `status` zeigt Endpunkte, Image-Digest, Lizenz und Gate-Status; `disable` entfernt nur eigene Container (Label-geprüft), niemals fremde |
| WP-72 | Integration in Query, Change und Portfolio | `untangle query --finding <tool>:<rule>`, `--severity`, `--has-findings`; Change-Analyse weist **neue** und **entfallene** externe Befunde je Symbol aus; Quality Gate kann externe Befunde als Regel führen; Portfolio-Harness erfasst, welches Projekt welche Qualitätswerkzeuge einsetzt | WP-66; spec.md §13.1, §17, §18; portfolio.md §6–§8 | WP-67, WP-19, WP-21, WP-22 | M | Filter läuft als Payloadfilter im Store, nicht nachträglich im Speicher; Change-Report nennt neue Befunde mit Symbolbezug; Gate-Verstoß aus externem Befund trägt Werkzeug und Regel-ID |

### Einordnung

WP-66 ist eine Design-Stufe und läuft **vor** der Umsetzung. WP-67 gehört in die Welle nach `core`,
da es `storage-local` und `observability` braucht. WP-68/69/70 sind additiv und können einzeln
nachgezogen werden. WP-71 zieht mit `apps/cli`, WP-72 ist die letzte Integrationsstufe.

**Nachtrag `docs/PARITY.md`:** neue Zeilen B26–B29 für die Überlegenheitsspalte.

### Korrektur an Abschnitt 13 (2026-09-04)

Die ursprüngliche Begründung zu **X3** enthielt ein **Fehlzitat**: `vision.md` §10 untersagt wörtlich
„rohe **LLM**-Bewertungen als objektive Qualitätsmetriken", nicht „Bewertungen Dritter". Gefunden hat
das der Kritiker der A7-Spec. Die Entscheidung X3 selbst bleibt unverändert gültig, ihre Begründung ist
oben korrigiert und steht jetzt auf dem tragfähigeren Argument (Determinismus, Versionierung,
Golden-Tests, delta-first-Gates). `extensions.md` §7.5 übernimmt die korrigierte Fassung.

### Nachtrag aus dem SonarQube-Baseline-Lauf (2026-09-04)

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien |
|---|---|---|---|---|---|---|
| WP-73 | `packages/parser-registry/src/languages/shared/chunks.ts` | `ranges.reduce((acc, r) => unionRange(acc, r))` in Zeile 129 läuft **ohne Startwert**. Bei leerer `properties`-Liste wirft `reduce` einen `TypeError` mitten im Chunker. Die Nicht-Leerheit ist heute nur implizite Vorbedingung des Aufrufers. Von SonarQube gefunden, von den über 1.000 eigenen Tests **nicht**. Fix: expliziter Guard oder Startwert, mit klarer Fehlermeldung falls der Fall wirklich unmöglich sein soll. | `docs/SONAR.md`; spec.md §8.3 | WP-06 | S | Regressionstest mit leerer Property-Liste; entweder definiertes Verhalten oder `UntangleError` mit aussagekräftiger Meldung statt `TypeError` |
| WP-74 | SonarQube-Regelprofil | Die 16 `localeCompare`-Befunde und die UUIDv5-`weak hash`-Regel sind im Untangle-Kontext **Falsch-Positive** (Determinismus bzw. RFC 4122) und müssen im Projektprofil als „Won't fix" mit Begründung markiert werden — sonst verdecken sie in jedem Folgelauf echte Befunde und halten Reliability/Security künstlich auf D. | `docs/SONAR.md` | WP-69 | S | Nach der Markierung erneuter Lauf; Reliability und Security spiegeln nur noch echte Befunde |

### Nachtrag aus der eigenen Verifikation nach Welle 2 (2026-09-04)

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien |
|---|---|---|---|---|---|---|
| WP-75 | `packages/storage-qdrant/src/qdrant.integration.test.ts` | Der Test nutzt als **Default** `http://127.0.0.1:6333`. Auf einer Entwicklermaschine ist das typischerweise eine **fremde** Qdrant-Instanz (hier: `rag_qdrant`, ein anderes Projekt). Der Lauf schreibt Test-Collections dort hinein und schlug dabei fehl (3 rote Tests im Gesamtlauf, während der Einzellauf sich übersprang — die Erreichbarkeitsprobe ist unter Parallellast wackelig). Verstoß gegen `spec.md` §3.2 („DARF in diesem Modus keine fremden Prozesse oder Container verändern"). Ein Testpräfix schützt nicht davor, in eine fremde Datenbank zu schreiben. **Fix:** kein Default-Endpunkt mehr. Der Test läuft **nur**, wenn `UNTANGLE_QDRANT_INTEGRATION_URL` ausdrücklich gesetzt ist, und überspringt sich sonst bedingungslos — dasselbe Prinzip, nach dem die SonarQube-Extension auf Port 19001 statt 19000 ausweicht. Zusätzlich: Probe mit ausreichendem Timeout, damit „erreichbar" nicht von der Parallellast abhängt. | spec.md §3.2; docs/SONAR.md | WP-11 | S | Ohne gesetzte Variable: `skipped`, unabhängig davon, ob auf 6333 etwas läuft. Mit gesetzter Variable auf eine eigene Instanz: grün. Kein Lauf schreibt je in eine nicht ausdrücklich benannte Instanz. |

---

## 14. Nachtrag A8 — Dogfooding und Gleichstandslücken aus der Referenzrecherche (2026-09-04)

### Aus dem ersten Selbstanalyse-Lauf (Untangle auf Untangle)

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien |
|---|---|---|---|---|---|---|
| WP-82 | `packages/complexity` — Aggregation ohne Doppelzählung | Der erste Selbstlauf über 407 Dateien und 4.972 Scopes ergab cognitive **17.365** gegenüber **4.284** bei SonarQube. Ursache ist keine Fehlrechnung, sondern **Doppelzählung**: ein `file`-Scope trägt per dokumentiertem Nesting-Kontext den Kontrollfluss *aller* Kind-Scopes, und das naive Summieren zählt denselben Code mehrfach. `spec.md` §16.10 verlangt Deduplizierung über `metrics_scope_id`, es existiert aber **keine Aggregatsfunktion**, die das umsetzt. Ohne sie ist jede Datei-, Repo- oder Workspace-Summe bedeutungslos — und damit auch jeder Hotspot-Vergleich und jedes Quality Gate auf Aggregatsebene. | spec.md §16.10; docs/SONAR.md | WP-08 | M | `aggregate()` liefert Summen ohne Doppelzählung; Gegenprobe gegen SonarQube liegt in derselben Größenordnung (X8); Test mit verschachtelten Scopes belegt, dass innerer Kontrollfluss genau einmal zählt |
| WP-83 | `scripts/complexity-report.mjs` | Der Selbstanalyse-Lauf als reproduzierbares Repo-Skript (`pnpm complexity:report`): Hotspot-Liste, Summen je Package, Invariantenprüfung über alle Scopes, Gegenüberstellung mit dem letzten Sonar-Lauf. Der erste Lauf hat die Cognitive-Invariante auf **4.972 echten Scopes** bestätigt — bisher war sie nur an Fixtures belegt. Das gehört in die Regressionsabsicherung, nicht in ein Wegwerfskript. | spec.md §16.10; vision.md §11.2 | WP-08, WP-82 | S | Ein Kommando; bricht ab, wenn irgendein Scope die Invariante verletzt; Ausgabe ist zwischen Läufen vergleichbar |
| WP-84 | Zwei nicht parsbare Eigen-Dateien | Im Selbstlauf schlugen **2 von 409** Dateien beim Parsen fehl und 4 kamen nur als `partial` durch. Welche das sind und warum, ist zu klären — an der eigenen Codebasis darf der eigene Parser nicht scheitern. | spec.md §7.3 | WP-06 | S | Beide Dateien benannt und Ursache dokumentiert; entweder behoben oder als begründete Grenze im Skip-Ledger geführt |

### Gleichstandslücken gegenüber ausgereiften lokalen Code-Intelligence-Werkzeugen

Recherchestand 2026-09-04, ermittelt aus öffentlicher Dokumentation. Clean Room: nur
beobachtbarer Funktionsumfang, kein Quelltext, keine Produktnamen im Repository.
**Ausdrücklich bestätigt: die Referenz bietet keine Complexity-Metriken, keine
Change-Analyse, keine Quality Gates und keine Historien-Intelligenz** — der Kern
unserer Differenzierung bleibt unbesetzt.

| ID | Fähigkeit | Warum relevant | Größe |
|---|---|---|---|
| WP-85 | **Weitere Embedding-Provider**: OpenAI, Google Gemini, LM Studio, LiteLLM-Proxy neben Ollama und dem statischen Kleinmodell | Reale Adoptionshürde: wer bereits einen Provider betreibt, will ihn nutzen. Der `EmbeddingProvider`-Port existiert bereits, es fehlen die Adapter. Profil-Trennung nach `spec.md` §5.7 gilt unverändert. | M |
| WP-86 | **Sprachbreite**: Java, Kotlin, Scala, C, C++, C#, Go, Rust, Ruby, PHP, Swift, Dart, Elixir, Bash, HTML, CSS/SCSS, Svelte, Vue | Die Referenz deckt 21 Sprachen voll ab, wir fünf. Für Cross-Repo-Landschaften ist Breite kein Luxus, sondern Voraussetzung. Reihenfolge nach Verbreitung. | XL |
| WP-87 | **Interaktiver Graph-Explorer** als eigenständige HTML-Seite, offline-tauglich (keine Remote-Skripte, CSP-konform) — Datei-/Symbol-Umschaltung, Rückwärts-transitive Hervorhebung, Suche, mehrere Layouts, PNG-Export | `product.md` nennt Visualisierung, `spec.md` §20.2 `graph visualize`; die Referenz zeigt, welcher Funktionsumfang erwartet wird. | L |
| WP-88 | **Entry-Point-Erkennung** für Call Flow: Orphans, konventionelle Namen (`main`), Framework-Routen, Tests | `spec.md` §14.4 nennt Entry-Point-Erkennung; ohne Heuristiken bleibt `untangle flow` ohne Startpunkte unbrauchbar. | M |
| WP-89 | **Mehr-Agenten-Betrieb auf einem Index**: mehrere Agents teilen einen Index, ein Watcher je Projekt, Lock-Übernahme bei verwaisten Locks, laufende Indexierung liefert Fortschritt statt Doppelstart | Genau der Betriebsfall dieses Projekts. `packages/storage-local` hat die Locks, es fehlt die Zusammenführung auf Job-Ebene. | M |

---

## 15. Nachtrag A9 — Die Kernthese umsetzbar machen (`vision.md` §1b)

Eine Produktthese, die nichts am Bau ändert, ist Dekoration. Aus §1b folgen fünf
konkrete Arbeitspakete. Sie sind **nicht** optional: ohne sie misst Untangle
Komplexität, wickelt sie aber nicht auf.

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-90 | `packages/change-engine` — **Funktionale Äquivalenz** | Operationale Prüfung von „derselbe Funktionsumfang" nach `vision.md` §1b: (a) öffentliche Symboloberfläche unverändert — Signaturen, Exporte, Sichtbarkeit über den Symbolgraphen; (b) Testergebnisse unverändert — gleiche Anzahl, gleiches Ergebnis, keine entfernten oder neu übersprungenen Tests; (c) Abhängigkeitskanten nicht erweitert, keine neuen Zyklen. Ergebnis ist ein `FunctionalEquivalenceV1` mit den drei Teilurteilen, einem Gesamturteil und **ausdrücklichen Caveats**. Identisches Laufzeitverhalten wird **nicht** behauptet. | vision.md §1b; spec.md §17, §15 | WP-21, WP-18 | M | Refactor ohne Oberflächenänderung → `equivalent: true` mit allen drei Teilurteilen; entfernter Test, geänderte Signatur oder neue Kante → jeweils `false` mit benanntem Grund; das Ergebnis enthält nie eine Aussage über Laufzeitverhalten |
| WP-91 | Quality Gate — **Komplexitäts-Ratsche** | Neuer Gate-Modus `ratchet`: bei funktionaler Äquivalenz (WP-90) darf Komplexität **nicht steigen**. Delta-first (`spec.md` §18.1) — Altlasten blockieren nicht. Umgekehrt wird eine Senkung ohne Oberflächen-, Test- oder Kantenänderung als **`QualityImprovementV1`** ausgewiesen, nicht stillschweigend hingenommen. Verschlechterungen tragen ihre Beitragsstellen (Zeile, Konstrukt, Nesting-Anteil). | vision.md §1b; spec.md §18 | WP-21, WP-90, WP-82 | M | Ein Commit, der cognitive senkt und sonst nichts ändert, erscheint als Verbesserung im Report; ein Commit, der sie bei gleicher Oberfläche erhöht, lässt das Gate im `ratchet`-Modus fehlschlagen und benennt die Beitragsstellen; bestehende Altlast allein lässt es nie fehlschlagen |
| WP-92 | `packages/testkit/src/retrieval` — **Wegkürze als Metrik** | `vision.md` §1b definiert Wegkürze als Anzahl der Untangle-Aufrufe plus danach geöffneter Dateien bis zur Ground-Truth-Stelle. Umsetzung als messbare Größe über die Fixture-Ground-Truth (`spec.md` §27.3), reproduzierbar und **über Versionen vergleichbar**. Ergänzt die North-Star-Metrik aus `vision.md` §11.5, die bisher nur *ob* misst, nicht *wie schlank*. | vision.md §1b, §11.5; spec.md §27.3 | WP-04, WP-19 | M | `evaluate()` liefert neben Recall@k und MRR auch `hopsToTarget` je Fall und als Verteilung; zwei Läufe derselben Version ergeben denselben Wert; eine Verschlechterung zwischen Versionen ist als solche erkennbar |
| WP-93 | `packages/search` — **Komplexitätsbewusstes Ranking** | Direkte Anwendung der These auf die Suche: stehen zwei Treffer in der Relevanz gleichauf, wird der **einfachere** bevorzugt. Als eigene, abschaltbare Score-Komponente mit sichtbarem Beitrag (`spec.md` §13.3), die dense/BM25 **nicht** überstimmen darf. Standardmäßig aus, bis der Nutzen an den Fixtures belegt ist. | vision.md §1b; spec.md §13.3 | WP-19, WP-82 | S | Komponente erscheint im Score-Breakdown; bei deutlichem Relevanzunterschied ändert sie die Reihenfolge nicht; Wirkung an der Retrieval-Suite gemessen und dokumentiert, bevor sie als Default vorgeschlagen wird |
| WP-94 | `docs/SELF.md` — **Die Hypothese am eigenen Repo messen** | §1b behauptet, dass sinkende Komplexität zu kürzeren Wegen führt. Das ist eine **Arbeitshypothese**, keine Voraussetzung. Über die Wellen hinweg werden je Stand festgehalten: Cognitive-Summe (dedupliziert, WP-82), Hotspot-Liste, Wegkürze-Verteilung (WP-92), Anzahl Graphzyklen. Bestätigt sich die Kopplung nicht, ist das ein **Befund** — und kein Grund, die Messung anzupassen. | vision.md §1b, §11.5 | WP-82, WP-83, WP-92 | S | Je Welle ein Datenpunkt; die Zeitreihe zeigt Komplexität und Wegkürze nebeneinander; ein ausbleibender Zusammenhang wird ausdrücklich als solcher berichtet |

---

## 16. Nachtrag A10 — Performance, gemessen statt vermutet (`docs/PERFORMANCE.md`)

Gemessener Ist-Zustand: **6,4 kLOC/s** über die volle Pipeline. Davon entfallen
**86,6 %** auf den AST-Walk und nur **12,5 %** auf das Parsen. Der Parser ist
nicht der Engpass — die JS↔C-Grenzüberquerung ist es.

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-95 | `packages/parser-registry/src/languages/shared` — **Cursor-Traversierung** | Der vereinheitlichte Walk navigiert über `node.children`. Jeder Zugriff erzeugt JS-Wrapper und überquert die Grenze zur nativen Bibliothek einmal pro Knoten. Gemessen an einer echten Datei (6.682 Knoten): `.children` 1,39 µs/Knoten gegenüber Cursor-API **0,21 µs/Knoten — 6,5× schneller**, und `.children` kostet allein **1,4× die Parsezeit**. Umstellung auf `walk()`/`gotoFirstChild`/`gotoNextSibling`/`gotoParent`. Reiner Gewinn: gleiche Sprache, gleiches Design, keine neue Toolchain. | docs/PERFORMANCE.md §2; arch §13.1 | WP-06 | M | Benchmark vor/nach im Repo; Gesamtpipeline mindestens **2×** schneller; **alle** bestehenden Golden-Tests unverändert grün — die Umstellung darf kein einziges Fakt verändern |
| WP-96 | `packages/jobs` — **Worker-Parallelisierung der Analysestufe** | `architecture.md` §13.1 sieht Parser-Worker vor, sie sind nicht gebaut. Dateiweise Analyse ist beschämend parallel; nach WP-95 ist das der nächste Hebel und kostet keine neue Sprache. Bounded Worker Pool, Backpressure aus WP-79 bleibt wirksam, Ergebnisreihenfolge bleibt deterministisch. | arch §13.1, §21.4 | WP-13, WP-95 | L | Durchsatz skaliert messbar mit der Workerzahl; Determinismus der Ergebnisse unverändert; Speicherbudget wird weiterhin eingehalten |
| WP-97 | `packages/embeddings-ollama` — **Batchgröße als Erstklassthema** | Messung: Batch 1 → 0,3 Chunks/s, Batch 8 → 38,3, Batch 32 → **93,3**. Faktor **300** allein durch Batching. Bei jedem Maßstab ab 100 kLOC dominieren Embeddings die Gesamtzeit, nicht die Analyse. Automatische Batchgrößen-Ermittlung beim Readiness-Check statt festem Default, plus Warnung, wenn effektiv mit Batch 1 gefahren wird. | docs/PERFORMANCE.md §3; spec.md §9.2 | WP-10 | S | Readiness ermittelt eine sinnvolle Batchgröße; ein Lauf mit effektiver Batchgröße 1 erzeugt eine sichtbare Warnung mit gemessenem Vergleichswert |
| WP-98 | Durchsatz-Benchmark im Repo | `docs/PERFORMANCE.md` beruht auf Wegwerfskripten. Als `pnpm bench:throughput` verankern: Pipeline-Durchsatz je Stufe, Traversierungsvergleich, Embedding-Batchkurve. Ergebnisse je Welle in `docs/SELF.md` (WP-94) fortschreiben, damit Regressionen auffallen. | docs/PERFORMANCE.md | WP-25 | S | Ein Kommando; Zahlen zwischen Läufen vergleichbar; eine Verschlechterung um mehr als 20 % ist als solche erkennbar |
| WP-99 | Python-Adapter-Durchsatz messen | Im eigenen Repo liegen keine `.py`-Dateien außerhalb der Fixtures, deshalb fehlt die Zahl. Der handgeschriebene Parser ist zugleich Complexity-Spitzenreiter (679) und Fundort des schwersten Defekts (WP-76) — sein Durchsatz gegenüber tree-sitter ist ein **Entscheidungskriterium** für die offene Frage, ob Python auf tree-sitter umgestellt wird. | docs/PERFORMANCE.md §6 | WP-09, WP-98 | S | Durchsatz an einem realen Python-Korpus gemessen und dem tree-sitter-Wert gegenübergestellt |

**Zur Rust-Frage, entschieden:** heute **nein**, und zwar messbar begründet — der
Parser ist bereits nativ und braucht 12,5 % der Zeit; der eigentliche Engpass hat
mit der Cursor-API eine Lösung in JavaScript; danach dominieren Embeddings, die
GPU-gebunden sind. Rust würde erst interessant, wenn nach WP-95 **und** WP-96 die
Analyse bei Millionen Zeilen weiterhin der Engpass ist. Der dann richtige Zuschnitt
wäre ein schmales natives Modul für den Walk mit **einer** Grenzüberquerung — nicht
eine Neuschreibung. Der Preis (zweite Build-Toolchain, Prebuilds je Plattform,
`npx`-Start mit Binärartefakten, höhere Beitragshürde gegen `spec.md` §2.3) ist
erst dann gerechtfertigt. Vollständige Begründung: `docs/PERFORMANCE.md` §5.

---

## 17. Nachtrag A11 — Index-Teilung über Worktrees und Branches (`docs/INDEX-SHARING.md`)

Gemessen: **57,8 Chunks je kLOC**, ~5,0 KB je Punkt. Ein 2,45-MLOC-Repo kostet
**141.666 Punkte und 0,68 GB je Ref**. Bei zehn Agenten-Worktrees mit ~1 % echtem
Unterschied sind das 6,8 GB und 1,4 Mio Punkte. Der Embedding-Cache
(`spec.md` §9.4) verhindert bereits das Neu-Einbetten — aber **nicht** die Upsert-
und Speicherverdopplung, weil `chunk_id` heute ref-gebunden ist (§5.6).

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-100 | Inhaltsadressierte Caches für Parse, Chunk und Complexity | Analog zum Embedding-Cache, Schlüssel `content_hash + parser_version` bzw. `+ chunker_version` / `+ metrics_version`. Ein zweiter Worktree überspringt damit **99 % der Analysezeit** für unveränderte Dateien (gemessen: Parse 12,5 % + Facts 86,6 %). **Kein Spec-Bruch**, kein Risiko, sofort machbar. | docs/INDEX-SHARING.md §5; spec.md §9.4, §12.1 | WP-06, WP-07, WP-08, WP-12 | M | Zweiter Lauf über unveränderten Inhalt erzeugt **null** Parse-, Chunk- und Metrikaufrufe; Cache-Invalidierung greift bei jedem Versionswechsel; Determinismus unverändert |
| WP-101 | Messung: Kosten eines zweiten Worktrees | Nach WP-100 belastbar messen, was ein zweiter Worktree wirklich kostet — Zeit, Punkte, Speicher. **Diese Zahl entscheidet**, ob die Inhaltsadressierung (WP-102/103) gerechtfertigt ist oder sich erübrigt. | docs/INDEX-SHARING.md §6 | WP-100, WP-98 | S | Zahl liegt vor und ist in `docs/SELF.md` festgehalten; die Entscheidung über WP-102 wird ausdrücklich darauf gestützt |
| WP-102 | Prototyp: Vektor einmal, Vorkommen mehrfach | Entwurf aus `docs/INDEX-SHARING.md` §3: `ChunkVectorPointV1` inhaltsadressiert, `ChunkOccurrenceV1` als Payload-Array. Der Prototyp MUSS die drei realen Risiken **messen**, nicht abschätzen: (a) Payload-Hotspots bei trivialen, überall gleichen Chunks; (b) Latenz verschachtelter Array-Filter gegen die P95-Vorgabe aus `spec.md` §26.2; (c) Dedupe auf Vorkommensebene, damit ein Treffer nicht je Ref einmal erscheint. | docs/INDEX-SHARING.md §3, §4 | WP-101, WP-11 | L | Alle drei Risiken mit Zahlen gegen echtes Qdrant belegt; Ergebnis ist eine begründete Empfehlung für oder gegen die Spec-Änderung |
| WP-103 | Spec-Änderung und Migration `_v2` | **Nur** bei positivem Ergebnis aus WP-102: `spec.md` §5.6 auf inhaltsadressierte `chunk_id` umstellen, neue Collection-Version, Migrationspfad. Bringt: neuer Worktree ~1 % statt 100 % der Punkte, Merge ohne Reindex (Vorkommen umhängen statt neu bauen), geteilte Vektoren für vendored Code über Repos hinweg. | docs/INDEX-SHARING.md §3; spec.md §5.6, §10.1 | WP-102 | L | Migration von `_v1` verlustfrei und wiederaufnehmbar; Merge eines Branch erzeugt **null** neue Embeddings für unveränderten Inhalt; Complexity bleibt ref-gebunden und wird **nicht** mitdedupliziert |

**Reihenfolge ist bindend:** erst der billige, bruchfreie Gewinn (WP-100), dann die
Messung (WP-101), dann der Prototyp (WP-102), und die teure Spec-Änderung (WP-103)
**nur**, wenn die Zahlen sie rechtfertigen. Nicht umgekehrt.

---

## 18. Nachtrag A12 — Sentrux als Analyzer-Extension und was wir daraus lernen

Recherchestand 2026-09-04, aus der öffentlichen Dokumentation (`sentrux.dev`,
GitHub `sentrux/sentrux`). Clean Room: nur beobachtbarer Funktionsumfang.

**Was es ist:** ein „architektonischer Sensor" für Agenten — MIT-lizenziert, reines
Rust, Einzelbinary ohne Laufzeitabhängigkeiten, ~36K Zeilen, 52 Sprachen über
tree-sitter-Plugins. Berechnet **fünf graphentheoretische Dimensionen** und
kombiniert sie mit dem **geometrischen Mittel**:

| Dimension | Grundlage |
|---|---|
| Modularity | Newman 2004, Community Detection |
| Acyclicity | Martin 2003 ADP, Tarjan |
| Depth | Lakos 1996, Levelization |
| Equality | Gini 1912, Verteilung der Komplexität |
| Redundancy | Kolmogorov 1963, toter und doppelter Code |

MCP: `scan(path)`, `session_start()`, `session_end()`. CLI: `sentrux check .`
mit Exit 0/1 als CI-Gate. Konfiguration: `.sentrux/rules.toml` (Layer, Grenzen,
Constraints).

### Warum es die einfachste Extension bisher ist

Gegenüber SonarQube (`WP-69`) entfällt fast alles Aufwendige:

| | SonarQube | Sentrux |
|---|---|---|
| Lizenz | Kern LGPL, **Analyzer SSALv1** → Pflicht-Gate (X5) | **MIT** → **kein Lizenz-Gate nötig** |
| Betrieb | Container, ~2 GB RAM, Healthcheck, Volumes | **Einzelbinary**, `binary`-Modus, kein Docker |
| Telemetrie | standardmäßig aktiv, muss abgeschaltet werden | keine bekannt — bei Aufnahme zu verifizieren (§8.7) |
| Netzzugriff | loopback zum eigenen Server | **keiner nötig** |

### Arbeitspakete

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien |
|---|---|---|---|---|---|---|
| WP-104 | `packages/extensions/src/adapters/sentrux` | Adapter im `binary`-Modus: `sentrux check .` für den Gate-Pfad, `scan(path)` für strukturierte Kennzahlen. Ergebnis → `ExternalFindingV1` plus `ExtensionRunV1`; die fünf Dimensionen und das Gesamtsignal als **externe Kennzahlen**, niemals in `ComplexitySnapshotV1` (X3). Regelverstöße aus `.sentrux/rules.toml` werden über den Symbolindex dem umschließenden Symbol zugeordnet, wo möglich. Lizenz MIT → `usageRestriction: 'none'`, **kein** Lizenz-Gate; Telemetrieverhalten beim Pinnen dennoch prüfen (§8.7). | extensions.md §5, §12; docs/SONAR.md | WP-67 | M | Golden-Test gegen echte Sentrux-Ausgabe; Abwesenheit des Binaries → `EXTENSION_UNAVAILABLE` mit sichtbarer Degradation, kein Abbruch; Dimensionen erscheinen getrennt von Untangle-Metriken |
| WP-105 | X8-Gegenprobe **Acyclicity und Depth** | Zwei der fünf Dimensionen überschneiden sich mit dem, was wir selbst erheben: Zyklenerkennung (`spec.md` §14.4) und Levelization/Tiefe (§14.4 Graphmetriken). Die übrigen drei (Modularity, Equality, Redundancy) sind **komplementär** und werden nicht gegengeprüft, sondern als zusätzliche Evidenz geführt. Systematische Abweichung bei den zwei überschneidenden ist ein **Testbefund** — genau wie bei lizard/radon (X8). | extensions.md X8; spec.md §14.4 | WP-104, WP-17 | S | Beide Größen werden gegenübergestellt; Abweichung über Schwelle bricht die Gegenproben-Suite mit Exit ≠ 0 ab |
| WP-106 | **Deklarative Sprachunterstützung prüfen** (betrifft WP-86) | Sentrux trägt 52 Sprachen mit *null* sprachspezifischem Code im Binary: alles Wissen steckt in `plugin.toml` plus tree-sitter-`tags.scm`-Queries. Unser Modell verlangt je Sprache einen vollständigen `LanguageAdapter` in TypeScript — bei 5 Sprachen tragbar, bei 21 (WP-86) nicht. **Zu prüfen ist ein Hybrid:** Symbole, Importe und Calls deklarativ über tree-sitter-Queries; nur die `ComplexityFacts` (Entscheidungspunkte, Nesting-Ereignisse, Operatoren/Operanden für Halstead) weiterhin je Sprache. Wichtige Einschränkung: `tags.scm` liefert Definitionen und Referenzen, **nicht** die Fakten, die unsere Complexity-Engine braucht — eine reine Query-Lösung reicht nicht. | extensions.md; arch §6.5; WP-86 | WP-06 | M | Prototyp für **eine** neue Sprache rein deklarativ für Symbole/Importe/Calls; belegter Aufwandsvergleich gegenüber einem vollen Adapter; begründete Empfehlung für oder gegen den Hybrid |
| WP-107 | **Unser Risk Score ist kompensierbar — Sentrux' Komposition ist es nicht** | Sentrux kombiniert seine fünf Dimensionen mit dem **geometrischen Mittel** und begründet das ausdrücklich als „ungameable by design": eine katastrophale Dimension lässt sich nicht durch Aufblasen einer anderen ausgleichen, weil das Produkt gegen null geht. Unser `RiskScoreV1` (`spec.md` §17.6) nutzt eine **gewichtete Summe** — dort ist genau diese Kompensation möglich: ein Blast Radius von 1,0 kann durch niedrige Churn- und Delta-Werte rechnerisch verschwinden. Das ist ein echter Befund an der eigenen Spezifikation. Zu prüfen: geometrisches Mittel oder eine Mindestschwelle je Komponente, damit keine Einzeldimension wegkompensierbar ist. Die Ausgabe der Komponenten und Caveats (§17.6) bleibt in jedem Fall Pflicht. | spec.md §17.6 | WP-21 | S | Gegenbeispiel dokumentiert, in dem die heutige Formel ein hohes Einzelrisiko wegmittelt; Entscheidung für eine Komposition begründet und in `spec.md` §17.6 nachgezogen |

**Zur Abgrenzung, ehrlich:** Sentrux überschneidet sich mit unserer B-Spalte im
Bereich „Qualitätssignal für Agenten" — sein `session_start()`/`session_end()` ist
im Kern die Ratsche aus `WP-91`, und es ist bereits verfügbar. Es bietet **nicht**:
semantische Code-Suche, Cross-Repo-Impact, Change-Historie mit semantischer Suche,
symbolgenaue Blast-Radius-Analyse oder Retrieval für Agenten. Und unsere `WP-90`/`WP-91`
gehen darüber hinaus, wo es zählt: **funktionale Äquivalenzprüfung** und
**Beitragsstellen je Zeile** statt nur eines Gesamtsignals. Es zu integrieren
statt nachzubauen ist deshalb die richtige Entscheidung — es liefert Evidenz auf
einer Achse, die wir gar nicht erheben (graphentheoretische Architekturgüte), und
wir liefern die Achsen, die es nicht hat.

**Zur Rust-Frage (`docs/PERFORMANCE.md` §5):** Sentrux ist der Existenzbeweis, dass
der Rust-Weg trägt — und zugleich, was er kostet: ~36K Zeilen Rust für ein
Werkzeug, das eine Teilmenge unseres Umfangs abdeckt. Das stützt die getroffene
Entscheidung: integrieren statt nachbauen, und Rust erst dann erwägen, wenn
`WP-95` und `WP-96` die Messlatte nicht erreichen.

---

## 19. Nachtrag A13 — Sprachagnostischer Kern und Prosa als erstklassiger Inhalt (`vision.md` §1c)

**Konkreter Befund, der das ausgelöst hat:** `packages/context-artifacts/src/adapters/markdown.ts`
kann bereits überschriftenbewusste Abschnitte mit Breadcrumbs — getestet und fertig.
Es greift aber **nur** für ausdrücklich konfigurierte Context Artifacts. Gewöhnliche
`.md`-Dateien im Repository fallen im Chunker auf **`line_fallback`**, also
willkürliche Zeilenfenster. Der gute Chunker liegt ungenutzt daneben.

Maßstab am eigenen Repo: **654 KB Markdown** gegenüber 2.006 KB TypeScript — ein
Drittel des Umfangs, und darin praktisch die gesamte Entscheidungsgrundlage.

| ID | Artefakt | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-110 | Strukturbewusstes Chunking für Prosa **im Normalpfad** | Der vorhandene Markdown-Adapter (Überschriften-Abschnitte, Breadcrumbs) wird für gewöhnliche Repository-Dokumente genutzt, nicht nur für konfigurierte Artefakte. Ein Markdown-Abschnitt ist eine semantische Einheit wie eine Funktion; Zeilenfenster über Prosa sind derselbe Qualitätsverlust wie über Code. Gilt analog für die übrigen vorhandenen Formatadapter, wo eine Datei ohne Artefakt-Konfiguration erkannt wird. | vision.md §1c; spec.md §7.1, §8.3; arch §20 | WP-07, WP-15 | M | Eine `.md`-Datei ohne Artefakt-Konfiguration erzeugt Abschnitts-Chunks mit Breadcrumb statt `line_fallback`; Lossless-Invariante unverändert; Retrieval-Recall auf einer Prosa-Ground-Truth messbar besser als mit Zeilenfenstern |
| WP-111 | **Prosa-Metriken statt Code-Metriken auf Prosa** | Cognitive Complexity über ein Markdown-Dokument ist bedeutungslos und darf nicht ausgegeben werden. Stattdessen die sachlichen Analoga: Abschnittstiefe und -zahl, Querverweisdichte (interne und externe Links, tote Verweise), Anteil offener Punkte (TODO/TBD/„offen"/unausgefüllte Platzhalter), Aktualität gegenüber dem letzten Commit der verlinkten Codepfade, Lesbarkeitsindikatoren. `spec.md` §16 wird um einen Prosa-Scope ergänzt; Code-Metriken bleiben davon getrennt. | vision.md §1c; spec.md §16.6 | WP-08, WP-110 | M | Für ein Markdown-Dokument werden Prosa-Metriken geliefert und **keine** cyclomatic/cognitive-Werte; tote interne Verweise werden benannt; die Metriken tragen einen eigenen `metrics_scope` |
| WP-112 | **Doc-Code-Drift als Befund** | Dokumentation und Code sind zwei indexierte Wirklichkeiten mit Provenienz. Wo ein Dokument auf Symbole, Pfade, CLI-Befehle, Konfigurationsschlüssel oder API-Operationen verweist, ist die Abweichung zur Realität messbar: benanntes Symbol existiert nicht mehr, Pfad ist verschoben, dokumentierter Befehl fehlt, Konfigurationsschlüssel wurde umbenannt. Ausdrücklich als **Heuristik** markiert (arch §20), mit Confidence — kein Automatismus. | vision.md §1c; arch §20; spec.md §19 | WP-110, WP-18, WP-17 | L | Ein Dokument, das ein umbenanntes Symbol nennt, erzeugt einen Drift-Befund mit Quellstelle und Confidence; eine Umbenennung im Code lässt den Befund entstehen, die Anpassung des Dokuments ihn verschwinden |
| WP-113 | **Änderungsintelligenz über Dokumente** | Die Change-Engine wird auf Prosa angewandt: `untangle changes search "welche Entscheidungen haben sich im letzten Monat geändert"` über ADRs, Spezifikationen und Runbooks. Change-Events für Dokumente bekommen eigene Suchtexte (`spec.md` §17.7) — Abschnitt hinzugefügt, umformuliert, Entscheidung umgekehrt, offener Punkt geschlossen. **Kein** Risk Score auf Prosa. | vision.md §1c; spec.md §17.7 | WP-21, WP-110 | M | Eine geänderte Entscheidung in einer ADR ist über die Change-Suche auffindbar; Dokument-Change-Events tragen keinen Risk Score |
| WP-114 | Support-Level `text` neu fassen | `spec.md` §7.1 beschreibt `text` als Abstufung nach unten („keine belastbaren Graph-/Metrikversprechen"). Nach `vision.md` §1c ist das zu korrigieren: `text` ist die **vollständige** Leistung für Inhalte ohne Graphen — Suche, Änderungsintelligenz, Historie und Provenienz in voller Qualität. Was fehlt, fehlt sachlich, nicht mangelhaft. Wortlaut in `spec.md` §7.1 nachziehen. | vision.md §1c; spec.md §7.1 | — | S | §7.1 formuliert `text` als eigenständiges Leistungsversprechen; kein Ausgabetext nennt es „degradiert" oder „Fallback" |

**Folge für WP-86 (Sprachbreite):** die Dringlichkeit sinkt. Für eine nicht
geparste Sprache liefert Untangle weiterhin Suche, Diff, Historie und
Textmetriken — ein fehlender Adapter kostet den Graphen und die AST-Metriken,
nicht die Nützlichkeit. Das verschiebt WP-86 hinter WP-110 bis WP-114, weil der
Nutzen je investiertem Aufwand dort höher ist.

---

## 20. Nachtrag — Restdefekte aus der Gegenprüfung von Welle 2b

Fünf der sechs Behauptungen wurden erneut widerlegt, aber die Befunde sind
**zweiter Ordnung**: engere Varianten derselben Klassen. Alle ursprünglichen
sechs Reproduktionen laufen grün.

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-115 | `parser-registry/.../python/parser.ts` | Tiefe Verschachtelung **in einem f-String-Ausdruck** wird beim Überschreiten von `DEFAULT_MAX_PARSE_DEPTH` still verworfen: `tryParseSubExpression` fängt den `ParseError`, gibt `null` zurück, `parseFStringExpressions` hängt nichts an — und **kein Pfad** speist den Fehlschlag in `parser.diagnostics`. `classifyParseQuality` meldet erneut `complete`. Dieselbe E4-Klasse wie WP-76. Fix: jeder verworfene Sub-Parse erzeugt ein Diagnostic der Hauptinstanz. | S | Repro des Prüfers grün; `parseQuality` nie `complete`, wenn ein Sub-Parse verworfen wurde |
| WP-116 | `packages/jobs/src/bounded-queue.ts` | `capacity: 1` schaltet die Byte-Grenze **dauerhaft** ab — mit völlig gültigen Werten. `hasRoomFor()` prüft den Byte-Zweig nur bei `slots.length > 0`; bei Kapazität 1 ist die Queue vor jedem Push leer, also greift die „übergroßes Element in leere Queue"-Ausnahme jedes Mal. Belegt: 20 × 50 MB gegen 100 Byte, keiner blockierte. Die WP-79-Härtung greift am falschen Eingang. Fix: die Ausnahme darf nur für ein **einzelnes** Element gelten, das das Budget allein überschreitet — nicht als Dauerzustand; zusätzlich `capacity` validieren. | S | `capacity: 1` mit kleinem `maxBytes` blockiert nach dem ersten Element; Regressionstest mit genau diesem Fall |
| WP-117 | `packages/embeddings-ollama/src/provider.ts` | Das In-flight-Register wird gelöscht, sobald der Fetch auflöst, aber `embedSlice` entscheidet **einmal** aus einem `Promise.all` über `cache.get()`. Ein Cache, dessen `get()` später auflöst — jeder netzgebundene, also genau der dokumentierte Erweiterungspunkt für `storage-local` — öffnet ein Doppel-Embedding-Fenster. Fix: Cache bzw. Register nach dem Auflösen erneut prüfen, bevor ein Request abgesetzt wird. | S | Repro mit verzögert auflösendem Cache erzeugt genau einen Backend-Aufruf |
| WP-118 | `packages/context-artifacts/src/adapters/sql.ts` | `splitStatements()` kennt nur `''`/`""` als Escape, nicht den in MySQL alltäglichen Backslash. Ein String mit `\'` und einem Semikolon zerreißt **ein** logisches Statement in zwei syntaktisch kaputte Chunks — bei **0** Skip-Ledger-Warnungen, weil die Byte-Abdeckung lückenlos ist. E4 erneut blind. Fix: dialektbewusste Escape-Behandlung plus eine Plausibilitätsprüfung, die syntaktisch unvollständige Statements als Befund meldet. | M | Beide Prüfer-Eingaben ergeben genau ein Statement; ein unbalanciertes Ergebnis erzeugt einen sichtbaren Befund |
| WP-119 | `packages/storage-local` — **bekannte Grenze, keine Reparatur** | TOCTOU zwischen „Lease abgelaufen" und `remove()` des Lock-Verzeichnisses: erneuert der echte Halter genau dann, löscht der Übernehmer die frisch verlängerte Lease. `architecture.md` §21.2 begrenzt Datei-Locks ausdrücklich auf den MVP und verweist für race-freie Leases auf den Remote-Team-Modus. Ein race-freier Datei-Lock über Prozessgrenzen ist ohne zusätzliche Primitive nicht erreichbar. Wird als **dokumentierte Grenze** in der Package-README und im Health-Report geführt. | S | Grenze in README und `untangle doctor` benannt; kein stillschweigendes Verschweigen |

---

## 21. Nachtrag A14 — Auffindbarkeit als Qualitätssignal (`vision.md` §1d)

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-120 | `packages/search` + `packages/complexity` — **Findability je Symbol** | Findability wird eine kontinuierlich gemessene Eigenschaft **je Symbol**, nicht nur ein Benchmark: Rang des Symbols bei einer Suche nach seinem eigenen Namen und seiner Signatur, Streuung der Treffer über Dateien, Zahl der Sprünge bis zum Ziel (WP-92). Ein schwer auffindbares Symbol erscheint in **derselben Hotspot-Liste** wie ein Symbol mit hoher kognitiver Komplexität. | M | `untangle complexity hotspots` führt Findability als eigene Spalte; ein Symbol mit gutem Namen und klarer Verantwortlichkeit rankt messbar besser als ein zerfasertes |
| WP-121 | Findability-Diagnose statt Zahl | Ein niedriger Wert allein hilft nicht. Untangle nennt die wahrscheinliche Ursache: Treffer streuen über viele Dateien (zerfaserte Verantwortlichkeit), richtiger Treffer rankt niedrig (Benennung trägt die Absicht nicht), viele Sprünge (Verflechtung), kein passender Treffer (undokumentiert). Jede Diagnose mit Beleg und Confidence, ausdrücklich als **Heuristik**. | M | Zu jedem niedrigen Wert gibt es eine benannte Ursache mit Beleg; keine Diagnose ohne Confidence |
| WP-122 | **Ratsche für Prosa** (erweitert WP-91) | Der Gate-Modus `ratchet` gilt auch für Dokumente, gemessen an den Prosa-Metriken aus WP-111 statt an Code-Metriken. Ein Dokument, das dieselbe Aussage mit weniger Struktur-, Verweis- und Formulierungslast trägt, ist das bessere. | S | Eine Dokumentänderung, die Prosa-Metriken senkt ohne Inhalt zu entfernen, erscheint als Verbesserung; kein Code-Metrikwert wird je auf Prosa angewandt |
| WP-123 | Doc-Findability als Drift-Signal (erweitert WP-112) | Ein Dokument, dessen zugehöriger Code schwer auffindbar ist, ist ein besonders starkes Drift-Signal: entweder fehlt die Beschreibung, oder sie beschreibt etwas anderes als der Code tut. | S | Symbole mit niedriger Findability und ohne Dokumentbezug erscheinen als eigene Befundklasse |

---

## 22. A15 — Auslieferung: `npm install` → `untangle init` → Wächter läuft

Zielbild des Nutzers, wörtlich: *„Ich will das via npm installieren. Können optional Sonar und
Sentrux extern dazu laden lassen und dann `untangle init` auf ein Projekt machen und dann code
search perfekt, continuous complexity monitoring."*

Das ist die **Abnahmekette**. Jedes WP unten ist erst fertig, wenn der jeweilige Schritt auf einem
fremden Rechner ohne dieses Repository funktioniert.

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-124 | `apps/cli` — das Binär `untangle` | Ein einziges npm-Paket `@untangle-code/cli`, das die Bibliothekspakete als Abhängigkeiten zieht. Bisher sind es 14 Pakete ohne Einstiegspunkt — für den Nutzer existiert Untangle noch gar nicht. Unterbefehle: `init`, `index`, `query`, `complexity`, `graph`, `flow`, `watch`, `doctor`, `extensions`. | L | `npx @untangle-code/cli --help` funktioniert in einem leeren Verzeichnis ohne dieses Repo |
| WP-125 | `untangle init` | Erkennt das Projekt selbst: Sprachen, Monorepo-Topologie (pnpm/npm/yarn-Workspaces, `docker-compose.yml`), vorhandenes Ollama, vorhandenes Qdrant, Ignorier-Regeln aus `.gitignore`. Schreibt eine **kommentierte** `untangle.toml` — der Nutzer soll sehen, was entschieden wurde und warum. Findet es kein Qdrant/Ollama, erklärt es genau einen nächsten Schritt statt zu scheitern. | M | `init` auf einem fremden Projekt erzeugt eine lauffähige Konfiguration ohne Rückfragen; `init` auf diesem Repo erkennt 14 Pakete |
| WP-126 | Ein-Zeilen-Installation | `npm i -g @untangle-code/cli` **und** ein `curl`-Bash-Skript für Nutzer ohne Node. Dazu die Host-Anbindungen: MCP-Server-Eintrag für Claude Code und Codex, jeweils als kopierfertiger Einzeiler in der README. | M | Beide Wege führen zu einem lauffähigen `untangle`; die MCP-Einträge sind wörtlich kopierbar |
| WP-127 | `untangle extensions add` | Lädt ein Extension-Manifest nach `~/.untangle/extensions/<name>/` — **außerhalb** des Projekts (X9). `--from <url|pfad>` mit Lizenz-Gate (X5) und Digest-Prüfung (X6). `untangle extensions list` zeigt Status, Lizenz und letzten Lauf. | M | Ein externes SARIF-lieferndes Werkzeug lässt sich ohne Änderung am Untangle-Quelltext anbinden |
| WP-128 | **Kontinuierliche Komplexitätsüberwachung** — der eigentliche Zweck | `untangle watch` verbindet Watcher, Indexierung und Metriken zu einem laufenden Wächter: bei jeder Änderung Delta an struktureller, semantischer, zyklomatischer und kognitiver Komplexität, dazu die **Findability-Änderung** (§1d). Ausgabe als Strom (Terminal), als Datei und über MCP an einen Agenten. Der Wächter meldet nicht nur Werte, sondern **Richtung**: hat diese Änderung Komplexität abgebaut oder aufgebaut? | L | Eine Änderung an diesem Repo erzeugt binnen Sekunden ein Delta mit Richtungsangabe; die Ratsche (§1b, WP-91) greift |
| WP-129 | Abnahme auf einem **fremden** Projekt | Die Kette `npm i -g` → `untangle init` → `untangle index` → `untangle query` → `untangle watch` auf einem Projekt, das nicht dieses Repository ist. Erst das beweist, dass wir ein Produkt und nicht ein Repository gebaut haben. | M | Protokoll des vollständigen Laufs in `docs/ACCEPTANCE.md`, mit echten Zeiten und echten Zahlen |

---

## 23. Welle 3 — 35 Befunde der Gegenprüfung

Fünf neue Pakete gebaut, **fünf von fünf mit Defekten**. Die Testsuite war dabei durchgehend grün
(2.146 Tests, Typecheck 14/14, Lint sauber, e2e-smoke bestanden) — sie hat **keinen einzigen** dieser
Befunde gesehen. Das ist der bislang deutlichste Beleg dafür, warum die Prüfer eigene
Reproduktionsskripte gegen die gebauten `dist/` schreiben und die Projekt-Testsuite ausdrücklich umgehen.

**24 der 35 Befunde sind E4-Verletzungen** — stiller Inhaltsverlust oder falsche
Vollständigkeitsbehauptung. Nach Welle 1 (3 von 3) und Welle 2 (6 von 6) ist das die dritte Welle in
Folge, in der dieselbe Fehlerklasse dominiert. Sie ist damit kein Ausrutscher einzelner Agenten,
sondern eine strukturelle Schwäche der Architektur: **wir haben Mechanismen für fehlende Bytes, aber
keine für falsch behauptete Vollständigkeit.** Siehe WP-165.

| WP-130 | `packages/file-graph` — `file-index.ts` **(E4)** | **[kritisch]** FileIndex.add loescht den alten Pfad nicht — nach einer Umbenennung meldet der Graph eine "resolved"-Kante auf einen Pfad, den keine Datei hat, mit Aufloesungsrate 1 und leerem Skip-Ledger | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-131 | `packages/file-graph` — `persistence.ts` **(E4)** | **[kritisch]** readGraphSnapshot liefert einen leiseren Graphen ohne jeden Befund, wenn ein Datei-Shard im Speicher fehlt — meta.nodeCount behauptet weiter die volle Zahl | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-132 | `packages/file-graph` — `load.ts` **(E4)** | **[hoch]** Paketkatalog kollidiert ueber Repositorygrenzen hinweg: gleichnamige Pakete verdecken einander still, Abhaengigkeiten werden dem falschen Repository entnommen und Importe loesen ins falsche Repository auf | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-133 | `packages/file-graph` — `persistence.ts` **(E4)** | **[hoch]** readGraphSnapshot meldet einen kaputten graph_meta-Payload nicht: metrics, topology und skipped werden still undefined, obwohl der Typ sie als Pflichtfelder fuehrt | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-134 | `packages/file-graph` — `graph.ts` **(E4)** | **[mittel]** traverse bricht bei erschoepftem Budget alle noch nicht begonnenen Wurzeln ab; deren Abhaengigkeiten fehlen im Ergebnis, ohne dass der genannte Grund das sagt | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-135 | `packages/file-graph` — `graph.ts` | **[niedrig]** Skip-Ledger-Eintraege einer entfernten Datei bleiben stehen und beziehen sich auf eine Datei, die der Graph nicht mehr kennt | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-136 | `packages/symbol-graph` — `resolve.ts:422` **(E4)** | **[kritisch]** Alias-Import wird auf das FALSCHE Symbol aufgeloest — und zwar als resolution=exact, confidence=1, basis=deterministic | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-137 | `packages/symbol-graph` — `build.ts:90` **(E4)** | **[kritisch]** Import-Shadowing: das zweite Binding desselben Namens wird still verworfen; die Kante behauptet exact auf das falsche Modul | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-138 | `packages/symbol-graph` — `resolve.ts:422` | **[hoch]** Alias- und Default-Importe verlieren eine beweisbare Kante: resolution=unresolved trotz aufgeloestem Modul und vorhandenem Ziel | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-139 | `packages/symbol-graph` — `build.ts:291` **(E4)** | **[hoch]** crossRepo ist bei mehrdeutigen Kanten immer false; metrics.crossRepoEdgeCount meldet 0 obwohl alle Kandidaten in fremden Repositories liegen | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-140 | `packages/symbol-graph` — `resolve.ts:213` | **[hoch]** maxCandidates=1 loescht jede mehrdeutige Kante vollstaendig; der als unerreichbar bezeichnete Defensivzweig ist ueber die oeffentliche Option erzwingbar | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-141 | `packages/symbol-graph` — `impact.ts:169` **(E4)** | **[mittel]** analyzeImpact: ein innerhalb der Tiefengrenze erreichbares Symbol faellt heraus, ohne Ledger-Eintrag | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-142 | `packages/symbol-graph` — `impact.ts:196` **(E4)** | **[mittel]** analyzeImpact: der Skip-Ledger meldet den Ausschluss eines Symbols, das im Ergebnis enthalten ist | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-143 | `packages/symbol-graph` — `types.ts:258` | **[mittel]** ImpactedSymbolV1.depth verletzt seinen dokumentierten Vertrag ('Sprungzahl vom naechstgelegenen Wurzelsymbol') | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-144 | `packages/search` — `filter.ts` **(E4)** | **[kritisch]** search() erzwingt workspaceId ueberhaupt nicht — Treffer aus fremden Workspaces werden still als eigene ausgegeben | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-145 | `packages/search` — `engine.ts` **(E4)** | **[hoch]** Der Repo-Scope des Ziels wird nicht durchgesetzt; group.repoIds meldet eine Herkunft, die nicht stimmt | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-146 | `packages/search` — `engine.ts` **(E4)** | **[hoch]** includeContext/includeLinked werden angenommen, als true zurueckgemeldet und wirkungslos verworfen — ohne Warnung, ohne Ledger, und entgegen der Behauptung auch ohne README-Eintrag | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-147 | `packages/search` — `payload.ts` **(E4)** | **[mittel]** readCodeChunkPayload erfindet fehlende Angaben und liefert einen strukturell ungueltigen SourceRange als scheinbar vollstaendigen Treffer | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-148 | `packages/search` — `engine.ts` **(E4)** | **[mittel]** queryFingerprint unterscheidet Modus, pathExclude, Sortierung und Komplexitaets-Bias nicht — sieben verschiedene Ergebnismengen, ein Fingerabdruck | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-149 | `packages/search` — `grep.ts` **(E4)** | **[mittel]** grep verwirft Glob-ausgeschlossene Chunks still, waehrend search() im selben Prozess fuer denselben Glob Ledger-Eintraege schreibt | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-150 | `packages/search` — `engine.ts` | **[mittel]** Die Score-Zerlegung widerspricht sich selbst: inputs.denseRank und die evidence desselben base_hybrid-Bestandteils nennen verschiedene Raenge | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-151 | `packages/search` — `grep.ts` | **[mittel]** Das Abbruchsignal (PortCallOptions.signal) ist im grep-Regex wirkungslos: 145 Sekunden Blockade durch EINE 31-Zeichen-Zeile trotz maxScannedChunks=1 | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-152 | `packages/search` — `engine.ts` | **[niedrig]** maxCandidateLimit aus der Konfiguration (200) wird nirgends durchgesetzt | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-153 | `packages/search` — `glob.ts` | **[niedrig]** Ein fehlerhaftes Glob-Muster des Nutzers wird als provider_unavailable verbucht und loescht stumm die ganze Profilgruppe | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-154 | `packages/extension-runtime` — `runtime.ts` **(E4)** | **[kritisch]** Werkzeugabbruch wird als erfolgreicher Lauf gemeldet: Exit-Code und stderr werden vollstaendig verworfen | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-155 | `packages/extension-runtime` — `sarif.ts` **(E4)** | **[hoch]** SARIF: zusaetzliche locations eines results werden still verworfen | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-156 | `packages/extension-runtime` — `junit-xml.ts` **(E4)** | **[hoch]** JUnit-XML: verschachtelte <testsuite>-Elemente werden nie besucht, ihre Fehlschlaege verschwinden spurlos | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-157 | `packages/extension-runtime` — `sarif.ts` **(E4)** | **[hoch]** SARIF: ein strukturell kaputtes run-Element wird komplett und stumm uebersprungen | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-158 | `packages/extension-runtime` — `runtime.ts` **(E4)** | **[hoch]** HTTP-Modus: der Statuscode der Antwort wird im Lauf nie geprueft, 401/404 gilt als erfolgreicher Lauf | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-159 | `packages/extension-runtime` — `generic-findings.ts` **(E4)** | **[mittel]** generic-findings: ausserhalb des Wertebereichs liegende oder falsch typisierte confidence/isHeuristic werden still verworfen und durch einen erfundenen Vorgabewert ersetzt | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-160 | `packages/extension-runtime` — `junit-xml.ts` **(E4)** | **[mittel]** JUnit-XML: unbrauchbares line-Attribut wird still zu Zeile 1 | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-161 | `packages/extension-runtime` — `normalize.ts` | **[niedrig]** Kennwerte mit absolutem Pfad gelangen ungeprueft in ExternalMeasurementV1.filePath | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-162 | `packages/complexity` + `scripts/complexity-report.mjs` — `complexity-report.mjs` **(E4)** | **[hoch]** parseQuality wird eingesammelt und stillschweigend verworfen: zwei Dateien gehen mit kaputtem Syntaxbaum in die Zahlen ein, drei echte Methoden fehlen, Hotspot #22 ist ein Parse-Artefakt (54 statt 7) | M | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-163 | `packages/complexity` + `scripts/complexity-report.mjs` — `scope-aggregate.ts` **(E4)** | **[mittel]** Die "Kerninvariante" kann Doppelzaehlung strukturell nicht erkennen — die Doku und die Report-Zeile "Verstoesse 0" behaupten aber genau das | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-164 | `packages/complexity` + `scripts/complexity-report.mjs` — `complexity-report.mjs` **(E4)** | **[niedrig]** aggregateScopeTree verwirft Dubletten mit gleichen Werten still, und der Report druckt `duplicatesDropped` nie | S | Reproduktion des Prüfers läuft grün; Regressionstest deckt genau diesen Pfad |
| WP-165 | Querschnitt — **E4 strukturell absichern** | Drei Wellen in Folge dominiert dieselbe Fehlerklasse (3/3, 6/6, 24/35). Einzelreparaturen erreichen sie nicht. Nötig ist ein Mechanismus, der *falsch behauptete Vollständigkeit* erkennt, nicht nur *fehlende Bytes*: ein Ergebnistyp, der Vollständigkeit nur zusammen mit ihrem Beleg tragen kann, plus eine Testhilfe im `testkit`, die für jeden Ergebnistyp prüft, ob ein absichtlich beschädigter Eingang zu einem sichtbaren Befund führt. | L | Eine Testhilfe, die auf alle bestehenden Pakete anwendbar ist; jedes Paket besteht sie oder führt seine Lücke als bekannte Grenze |

---

## 24. Befund aus der Lesekontrolle — `npm install` funktioniert heute nicht

Geprüft am 2026-09-05 über alle 18 Paket-Manifeste. Ergebnis:

| Merkmal | Stand |
|---|---|
| `private: true` | **15 von 18** Paketen |
| `publishConfig` | fehlt bei **18 von 18** |
| `repository` | fehlt bei **18 von 18** |
| `license`, `description`, `files`, `exports` | überall gesetzt (gut) |

Damit ist `npm install @untangle-code/cli` heute **nicht möglich** — ein CLI-Paket kann nicht gegen
Workspace-Abhängigkeiten veröffentlicht werden, die selbst als privat markiert sind. Das trifft die
erste Zeile des Zielbilds A15 direkt.

Zusätzlich eine unbeabsichtigte Abweichung: `config`, `extension-runtime` und `testkit` stehen auf
`private: false`, alle übrigen auf `true`. Das ist keine Entscheidung, sondern Drift — und die
Auswahl ist genau verkehrt herum: `testkit` ist die interne Testhilfe und gehört **nicht**
veröffentlicht, `domain` ist der öffentliche Vertrag und gehört veröffentlicht.

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-166 | Veröffentlichungsfähigkeit aller Pakete | Bewusste Entscheidung je Paket, was veröffentlicht wird und was nicht — nicht Drift. Vorschlag: alles außer `testkit` wird veröffentlicht, weil der Nutzer eigene Adapter gegen die Ports bauen können soll. Dazu `publishConfig.access: "public"` und `repository` überall, plus ein Skript, das die Konsistenz prüft und bei Drift bricht. | S | `pnpm -r publish --dry-run` läuft durch; ein neu hinzugefügtes Paket ohne die Pflichtfelder lässt die Prüfung fehlschlagen |

---

## 25. Welle 3b — Reparatur, und was sie zutage förderte

| Kennzahl | Wert |
|---|---|
| Befunde aus Welle 3 behoben | **36** |
| davon vom Nachprüfer als *nur scheinbar behoben* eingestuft | **8** |
| als *unverändert* eingestuft | **0** |
| Zusätzliche Fehler, die die **Reparatur-Agenten selbst** fanden | **48** |
| Neue Befunde der Nachprüfer | **35** |
| Tests | 1.319 → 2.146 → **2.340** |

Die Reparatur-Agenten fanden bei der Ursachensuche **mehr Fehler, als die Prüfer gezeigt hatten**
(48 gegenüber 35) — die Anweisung „suche die Ursache, nicht das Symptom" trägt messbar.
Kein einziger Befund blieb *unverändert*; die verbliebenen acht sind Fälle, in denen genau der
gezeigte Pfad geschlossen wurde, eine naheliegende Variante aber weiter durchgeht.

### Der wichtigste Einzelbefund

Der Nachprüfer von `search` fand einen Fehler, der **nicht in der Umsetzung liegt, sondern im
Entwurf von `vision.md` §1d**:

> Eine **ausgefallene oder gar nicht ausgeführte** Suche wird als Aussage über den Code veröffentlicht.

§1d sagt: wer nicht schnell gefunden wird, ist womöglich zu komplex oder schlecht dokumentiert.
Fällt die Suche selbst aus, verurteilt dieselbe Logik den Code für ein Versagen des Werkzeugs.
Die Ursachenmenge `FINDABILITY_RANK_MISSING_REASONS` enthält `search_unavailable` — aber nichts
hindert daran, daraus trotzdem eine Diagnose zu bilden. **Findability darf nur berichtet werden,
wenn die Suche nachweislich lief.** Siehe WP-210.

| WP-167 | `packages/symbol-graph` **(E4)** | **[kritisch]** Eine lokale Deklaration verdraengt eine spaetere Importbindung desselben Namens still — die Kante behauptet exact/1/deterministic auf das falsche Symbol | M | Reproduktion des Nachprüfers läuft grün |
| WP-168 | `packages/search` **(E4)** | **[hoch]** findability: eine AUSGEFALLENE oder gar nicht ausgefuehrte Suche wird als Aussage ueber den Code veroeffentlicht — rankMissingReason "no_match", Score 0.25, Diagnose "undocumented" | M | Reproduktion des Nachprüfers läuft grün |
| WP-169 | `packages/symbol-graph` **(E4)** | **[hoch]** exact wird behauptet, obwohl der Name im Zielmodul unbekannt ist: kind 'named'/'default' ohne importedName faellt still auf den LOKALEN Namen zurueck und gilt trotzdem als bewiesen | M | Reproduktion des Nachprüfers läuft grün |
| WP-170 | `packages/symbol-graph` **(E4)** | **[hoch]** analyzeImpact: das beim Erreichen von maxNodes gerade entnommene Symbol faellt aus Ergebnis UND Ledger heraus, waehrend ein gleich gelagertes Symbol benannt wird | M | Reproduktion des Nachprüfers läuft grün |
| WP-171 | `packages/symbol-graph` **(E4)** | **[hoch]** analyzeImpact: bei erschoepftem Kantenbudget verschwindet jedes nur darueber erreichbare Symbol vollstaendig aus dem Skip-Ledger — nur das truncated-Flag bleibt | M | Reproduktion des Nachprüfers läuft grün |
| WP-172 | `packages/file-graph` **(E4)** | **[hoch]** Ein Pfadwechsel meldet nur den ALTEN Pfad als betroffen — der inkrementelle Graph weicht vom vollstaendigen Neubau ab und behauptet ein FALSCHES, existierendes Ziel | M | Reproduktion des Nachprüfers läuft grün |
| WP-173 | `packages/file-graph` **(E4)** | **[hoch]** Zwei gleichnamige Pakete im SELBEN Repository verdecken einander ersatzlos — geraten statt gemeldet, kein Ledger-Eintrag, entgegen dem eigenen Quelltextkommentar | M | Reproduktion des Nachprüfers läuft grün |
| WP-174 | `packages/file-graph` **(E4)** | **[hoch]** readGraphSnapshot prueft nie, ob ein Datei-Shard den Knoten enthaelt, den seine Shard-ID nennt: ein Knoten verschwindet lautlos, ein anderer erscheint doppelt — und die neue Zaehlpruefung bestaetigt das Ergebnis sogar | M | Reproduktion des Nachprüfers läuft grün |
| WP-175 | `packages/extension-runtime` **(E4)** | **[hoch]** JUnit-XML: ein <testsuites> innerhalb einer Suite (und ein <testcase> direkt unter <testsuites>) verschwindet weiterhin spurlos — Befund 3 ist nur eine Ebene tief repariert | M | Reproduktion des Nachprüfers läuft grün |
| WP-176 | `packages/search` **(E4)** | **[mittel]** Teilweise ausserhalb des Ziels liegende ANGEFRAGTE Repositories werden lautlos aus der Suche gestrichen (search und grep) — nur der vollstaendig leere Durchschnitt kommt in den Ledger | S | Reproduktion des Nachprüfers läuft grün |
| WP-177 | `packages/search` **(E4)** | **[mittel]** grep hat keine zweite Verteidigungslinie fuer den Workspace: ein Speicher, der den Filter ignoriert, liefert fremden Workspace-Inhalt ohne Warnung und ohne Ledger | S | Reproduktion des Nachprüfers läuft grün |
| WP-178 | `packages/search` **(E4)** | **[mittel]** Die zweite Verteidigungslinie deckt nur target.repoIds ab, nicht den Repo-Filter der ANFRAGE: ein Treffer aus einem nicht angefragten Repo geht durch, waehrend group.repoIds das Gegenteil meldet | S | Reproduktion des Nachprüfers läuft grün |
| WP-179 | `packages/symbol-graph` **(E4)** | **[mittel]** proven/'unique_export' wird auch fuer Treffer ueber node.name gesetzt — exact/1/deterministic auf ein Symbol, das die Zieldatei unter diesem Namen gar nicht exportiert | S | Reproduktion des Nachprüfers läuft grün |
| WP-180 | `packages/symbol-graph` | **[mittel]** analyzeImpact: die Pareto-Menge macht die Laufzeit ueberproportional teuer und das Zeitbudget greift ohne uebergebene Uhr gar nicht | S | Reproduktion des Nachprüfers läuft grün |
| WP-181 | `packages/file-graph` **(E4)** | **[mittel]** Das von readGraphSnapshot zurueckgegebene Abbild kann sich selbst widersprechen (metrics.nodeCount gegen nodes.length) — der dritte, im Payload vorhandene Zeuge wird nie befragt | S | Reproduktion des Nachprüfers läuft grün |
| WP-182 | `packages/extension-runtime` **(E4)** | **[mittel]** SARIF: eine region mit ausschliesslich byteOffset erhaelt die erfundene Zeile 1 im SourceRange — ohne lineUnknown, ohne issue, ohne Warnung (toter Zweig in readRegion) | S | Reproduktion des Nachprüfers läuft grün |
| WP-183 | `packages/extension-runtime` **(E4)** | **[mittel]** runExtension meldet eine gekuerzte stdout-Ausgabe nirgends — weder beim Werkzeug noch beim Vorschaltbefehl; Befunde gehen still verloren | S | Reproduktion des Nachprüfers läuft grün |
| WP-184 | `packages/extension-runtime` **(E4)** | **[mittel]** generic-metrics: ein leerer oder nur aus Leerzeichen bestehender value-String wird zur erfundenen Zahl 0 — ohne issue | S | Reproduktion des Nachprüfers läuft grün |
| WP-185 | `packages/aggregation` **(E4)** | **[mittel]** Python: die Reparatur des Diagnosekanals ist nur halb verdrahtet — computeSyntactic() meldet fuer JEDE Python-Datei parse_error_node_count: 0, egal wie kaputt; docs/SONAR.md behauptet das Gegenteil ("Auch das ist behoben") | S | Reproduktion des Nachprüfers läuft grün |
| WP-186 | `packages/aggregation` **(E4)** | **[mittel]** duplicate_scope_id nennt die falsche Ursache: der Detailtext behauptet "abweichende Werte" und druckt dabei identische Zahlen; das tatsaechlich abweichende Feld (parentScopeId oder executionUnit) wird nie genannt | S | Reproduktion des Nachprüfers läuft grün |
| WP-187 | `packages/search` **(E4)** | **[niedrig]** CANDIDATE_LIMIT_CLAMPED wird auch dann gemeldet, wenn NICHT gedeckelt wurde: requested = effective = 100000, Nachricht behauptet das Gegenteil | S | Reproduktion des Nachprüfers läuft grün |
| WP-188 | `packages/search` **(E4)** | **[niedrig]** searchConfig.diversifyByDefault und searchConfig.minScoreDefault haben keinen Leser — dieselbe Klasse wie Befund 9, nur fuer maxCandidateLimit behoben | S | Reproduktion des Nachprüfers läuft grün |
| WP-189 | `packages/search` **(E4)** | **[niedrig]** group.repoIds meldet den ERLAUBTEN Bereich, nicht die beitragenden Repositories — der Domain-Vertrag sagt "Repositories, die zu dieser Gruppe beitragen" | S | Reproduktion des Nachprüfers läuft grün |
| WP-190 | `packages/search` | **[niedrig]** workspaceId wird nicht getrimmt: Speicherfilter und prozessinterne Pruefung benutzen verschiedene Werte, eine Anfrage mit Rand-Leerzeichen liefert null Treffer | S | Reproduktion des Nachprüfers läuft grün |
| WP-191 | `packages/search` | **[niedrig]** Falsche Begruendung im Ledger: ein nicht ganzzahliges end_line wird mit "is before start_line" abgelehnt, obwohl es groesser ist | S | Reproduktion des Nachprüfers läuft grün |
| WP-192 | `packages/symbol-graph` | **[niedrig]** minDepth ist nicht die Sprungzahl zur naechstgelegenen Wurzel, wenn der kuerzere Weg unter minConfidence faellt | S | Reproduktion des Nachprüfers läuft grün |
| WP-193 | `packages/file-graph` **(E4)** | **[niedrig]** Ein fehlender workspaceId im Metadaten-Shard wird still durch den Leerstring ersetzt | S | Reproduktion des Nachprüfers läuft grün |
| WP-194 | `packages/file-graph` **(E4)** | **[niedrig]** traverse weist eine Wurzel, die der Graph gar nicht kennt, als bearbeitet aus | S | Reproduktion des Nachprüfers läuft grün |
| WP-195 | `packages/file-graph` **(E4)** | **[niedrig]** applyChanges verwirft ein `removed` fuer eine unbekannte file_id stillschweigend | S | Reproduktion des Nachprüfers läuft grün |
| WP-196 | `packages/file-graph` **(E4)** | **[niedrig]** truncationReason nennt den ERSTEN Grund, nicht den, an dem tatsaechlich Knoten verloren gingen | S | Reproduktion des Nachprüfers läuft grün |
| WP-197 | `packages/file-graph` **(E4)** | **[niedrig]** Der geschriebene Pfadindex verliert eine file_id, wenn zwei Knoten denselben Repository-Pfad haben — ohne Befund, ohne Ledger | S | Reproduktion des Nachprüfers läuft grün |
| WP-198 | `packages/file-graph` | **[niedrig]** WorkspacePackageEdgeV1 identifiziert Pakete weiterhin nur ueber den Namen: Paketkanten zweier Repositories sind ununterscheidbar | S | Reproduktion des Nachprüfers läuft grün |
| WP-199 | `packages/extension-runtime` | **[niedrig]** Ein gueltiger, leerer JUnit-Bericht (<testsuites></testsuites>) laesst den ganzen Lauf mit einer sachlich falschen Begruendung scheitern | S | Reproduktion des Nachprüfers läuft grün |
| WP-200 | `packages/aggregation` **(E4)** | **[niedrig]** sameValues ignoriert sloc: zwei Eintraege mit derselben Id und unterschiedlichem sloc werden ohne Verstoss verschmolzen — das Gewicht des SLOC-gewichteten Mittels faellt still weg | S | Reproduktion des Nachprüfers läuft grün |
| WP-201 | `packages/aggregation` | **[niedrig]** Kopfzeile und Abschnitt 7 des Reports beschriften Teilmengen als Gesamtmengen | S | Reproduktion des Nachprüfers läuft grün |
| WP-202 | `packages/search` — **nur scheinbar behoben** | Befund 5 [mittel] — queryFingerprint unterscheidet materiell verschiedene Anfragen nicht | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-203 | `packages/search` — **nur scheinbar behoben** | Befund 8 [mittel] — Abbruchsignal im grep-Regex wirkungslos (katastrophales Backtracking) | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-204 | `packages/search` — **nur scheinbar behoben** | Befund 9 [niedrig] — maxCandidateLimit (200) wird nirgends durchgesetzt | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-205 | `packages/symbol-graph` — **nur scheinbar behoben** | Befund 2 [kritisch]: Import-Shadowing — das zweite Binding desselben Namens wird still verworfen, die Kante behauptet exact auf das erste Modul | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-206 | `packages/symbol-graph` — **nur scheinbar behoben** | Befund 6 [mittel, E4]: Ein innerhalb der Tiefengrenze erreichbares Symbol faellt aus analyzeImpact heraus, ohne Ledger-Eintrag | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-207 | `packages/file-graph` — **nur scheinbar behoben** | Befund 1 [kritisch] — FileIndex.add loescht den alten Pfad nicht; nach einer Umbenennung resolved-Kante auf einen Pfad, den keine Datei hat (Probe 9/10, Probe 6 Szenario E) | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-208 | `packages/file-graph` — **nur scheinbar behoben** | Befund 3 [hoch] — Paketkatalog kollidiert ueber Repositorygrenzen; gleichnamige Pakete verdecken einander still (Probe 3/4) | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-209 | `packages/extension-runtime` — **nur scheinbar behoben** | Befund 3 [hoch] — JUnit-XML: verschachtelte <testsuite>-Elemente werden nie besucht (formats/junit-xml.ts) | M | Der gezeigte Fall UND eine naheliegende Variante laufen grün |
| WP-210 | `vision.md` §1d + `packages/search` — **Findability nur bei belegter Suche** | Eine Findability-Aussage setzt voraus, dass die Suche nachweislich ausgeführt wurde und ein Ergebnis lieferte. Bei `search_unavailable` oder `symbol_not_indexed` entsteht **keine Diagnose**, sondern ein Zustandsvermerk. §1d ist entsprechend zu ergänzen: die Umkehrung „schwer auffindbar ⇒ Qualitätsmangel" gilt nur bei funktionierendem Abruf. | M | Eine ausgefallene Suche erzeugt nie eine `FindabilityDiagnosisV1`; ein Test belegt es |

### WP-165 hat sein eigenes Problem gefunden

Die Testhilfe `assertHonestUnderDamage` steht und deckt sechs Beschädigungsarten ab. Der Agent
berichtet aber eine Lücke, die genau die Klasse ist, gegen die er gebaut wurde — eine Ebene höher:

> „Wer `claim: () => 1` schreibt, bekommt sechsmal *unchanged* und einen grünen Test. Ich habe nur
> erzwungen, dass keine Beschädigungsart stillschweigend fehlt — nicht, dass die Projektion etwas
> taugt."

Dazu die ehrliche Feststellung, dass die zweite Auftragshälfte **nicht erfüllbar** ist: eine
nominale Vollständigkeitsmarke lässt sich in TypeScript nicht erzwingen, weil `as`-Umdeutungen jede
Marke umgehen — „das ist keine Bequemlichkeit, sondern eine Eigenschaft der Sprache". Statt Erfolg
zu behaupten, wurden zwei Ersatzschichten plus eine Lint-Regel gebaut. Das ist die richtige Antwort.

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-211 | `packages/testkit` — Güte der `claim`-Projektion | Eine zu grobe Projektion macht die Ehrlichkeitsprüfung wertlos, ohne dass es auffällt. Nötig ist eine Gegenprobe: die Testhilfe verlangt je Paket einen **Mutationsnachweis** — ein absichtlich eingebauter Verlustpfad muss die Prüfung umwerfen. Läuft sie auch dann grün, ist die Projektion untauglich und der Test schlägt fehl. | M | Für `parser-registry` und `context-artifacts` liegt je ein Mutationsnachweis vor (für den Chunker existiert er bereits) |
| WP-212 | `spec.md` §22 — fehlende Abbruchunterstützung | `chunkFile()` und `LanguageAdapter.parse/extractChunks/extractSymbols` nehmen kein `AbortSignal`, obwohl §22 es für öffentliche APIs verlangt. Die Beschädigungsart `abort_signal` musste in zwei von drei Paketen abbedungen werden. | M | Alle drei Pakete bestehen die Prüfung ohne Abbedingung |

---

## 26. Selbstanalyse durch das eigene Binär — zwei Befunde

Erster Lauf von `untangle complexity` auf dem eigenen Repository, über `apps/cli/dist/index.js`.
805 Dateien gefunden, 652 gerechnet, 220 übersprungen — **alle 220 mit benanntem Grund**, E4 hält
an der Oberfläche. Die Aufschlüsselung förderte aber zwei Befunde zutage, die kein Prüfer gefunden
hatte, weil sie sich erst am Maßstab einer echten Codebasis zeigen.

### WP-215 — Alles ab 32 KiB wird nicht analysiert (**kritisch**)

10 Dateien scheiterten mit `Der Adapter warf beim Parsen: Invalid argument`. Nach Größe sortiert
ist die Grenze exakt:

| Ergebnis | Datei | Größe |
|---|---|---|
| gerechnet | `packages/complexity/src/scope-aggregate.ts` | 31.246 B |
| **gescheitert** | `packages/search/src/regex-safety.ts` | 33.070 B |

Jede Datei unter 32 KiB läuft, jede darüber scheitert. Das ist die Standard-Puffergrenze von
`node-tree-sitter`: `parser.parse(text)` ohne `bufferSize` bricht bei ~32.768 Zeichen ab.

**Verifizierte Gegenmaßnahme** (im Paketkontext gemessen):

```
Größe: 39.728 Zeichen
ohne bufferSize:  FEHLER — Invalid argument
mit bufferSize:   OK, root program | Kinder 43 | hasError false
```

Warum das schwer wiegt: die Grenze trifft **systematisch die größten Dateien** — also genau die,
die am ehesten Hotspots sind. Die Hotspot-Liste ist dadurch nach unten verzerrt, und der Effekt
wächst mit der Projektgröße. Auf einer fremden Codebasis mit vielen großen Dateien verlöre
Untangle einen erheblichen Teil des Materials, und zwar bei Parse, Chunking, Komplexität,
Embeddings **und** Suche zugleich.

E4 ist formal gewahrt (der Fehlschlag steht im Skip-Ledger), aber die Diagnose ist unbrauchbar:
`Invalid argument` sagt niemandem, dass eine Größengrenze gerissen wurde.

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-215 | `packages/parser-registry` — Puffergrenze | `bufferSize` proportional zur Eingabelänge übergeben, in allen Adaptern die `tree-sitter` nutzen. Zusätzlich: eine Größengrenze, die tatsächlich gerissen wird, erzeugt einen **benannten** Skip-Grund (`file_too_large`) mit der gemessenen Größe — nicht `Invalid argument`. | S | Alle 8 Dateien ≥32 KiB dieses Repos parsen; ein Regressionstest mit einer >32 KiB großen Fixture; die Gesamtzahlen der Selbstanalyse ändern sich messbar |
| WP-216 | `packages/parser-registry` — Diagnose statt Weiterreichen | Jede Ausnahme des Adapters wird auf einen benannten Grund abgebildet, bevor sie in den Ledger geht. Ein durchgereichter Bibliotheks-Fehlertext ist keine Diagnose. | S | Kein Skip-Ledger-Eintrag enthält mehr einen unübersetzten Bibliothekstext |

### WP-217 — 35 Markdown-Dateien gelten als `unsupported_language` (**hoch**)

Die 143 `unsupported_language`-Übersprungenen verteilen sich so: 80 `.json`, **35 `.md`**, 6 `.toml`,
2 `.yml`, 2 `.yaml`, 2 `.xml`, 2 `.jsonl`.

Das widerspricht `vision.md` §1c unmittelbar. Dort steht, dass der Kern sprachagnostisch arbeitet
und Prosa **erstklassiger Inhalt** ist — `text` ist keine abgeschwächte Fassung von `deep`, sondern
die vollständige Leistung für Inhalte ohne Graphen. Unser eigenes Werkzeug nennt sie „nicht
unterstützt".

Der Maßstab am eigenen Repo: 654 KB Markdown gegen 2.006 KB TypeScript. Ein Viertel des
Materials — und für ein Werkzeug, das Agenten beim Verstehen helfen soll, ist die Dokumentation
nicht das unwichtigere Viertel.

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-217 | `packages/parser-registry` + `packages/chunker` — Prosa als Sprache | `.md` und die übrigen Textformate erhalten die Unterstützungsstufe `text` statt `unsupported_language`. Der überschriftenbewusste Chunker aus `context-artifacts/src/adapters/markdown.ts` existiert bereits und wird für gewöhnliche `.md`-Dateien nutzbar gemacht (WP-110). Prosa-Metriken statt Code-Metriken (WP-111). | M | Kein `.md` erscheint mehr als `unsupported_language`; ein Markdown-Dokument wird überschriftenbewusst gechunkt, nicht in Zeilenfenster geschnitten |

---

## 27. Welle 4 — das Produkt existiert, aber die Kette trägt nicht

Beide Abnehmer urteilen **produkt-funktioniert-nicht**. Das ist das richtige Urteil, und es ist
wertvoller als ein beschönigtes.

| Schritt der Kette | Urteil |
|---|---|
| `pnpm -r build` | funktioniert |
| `untangle --help` | funktioniert — neun Unterbefehle, jeder mit eigener Hilfe |
| fremdes Projekt wählen | funktioniert — echtes mehrsprachiges Repo mit Container-Topologie |
| `untangle init` | **scheitert** — das ausgelieferte Binär führt einen Stub aus |
| `untangle doctor` | teilweise — ehrlich, aber liest die falsche Konfigurationsdatei |
| `untangle index` | **scheitert** — nicht gebaut |
| `untangle query` | **scheitert** — ohne Index nichts zu durchsuchen |
| `untangle complexity` | teilweise — läuft, plausible Rangfolge |
| `untangle watch` | **funktioniert** — der einzige Schritt, der das Zielbild ohne Abstrich einlöst |

### Die Selbstkritik des CLI-Agenten trifft den Kern

> „Ich habe `untangle index` nicht gebaut, und das ist der Befehl, an dem der Nutzerwunsch hängt.
> Alle Bausteine liegen da. Was fehlt, ist genau das Verbindungsstück. **Ein Nutzer, der heute
> installiert, kann suchen: nichts. Das Arbeitspaket ist erfüllt, das Nutzerziel nicht.**"

Und zur eigenen Arbeitsweise:

> „Drei Defekte habe ich erst LIVE gefunden, nicht beim Schreiben. […] Gefunden habe ich sie nur,
> weil Ollama zufällig kaputt war. Wäre der Dienst gesund gewesen, hätte ich alle drei ausgeliefert.
> Ich habe also nicht sorgfältig genug gedacht, sondern Glück gehabt."

Einer dieser drei war eine E4-Verletzung im wichtigsten Befehl: bei blockiertem Embedder gab
`query` „Keine Treffer." mit Exit-Code 0 aus, obwohl im Skip-Ledger `provider_unavailable` stand —
es war gar nicht gesucht worden. Behoben, mit Regressionstest.

### Blockierer

| ID | Artefakt | Zweck | Größe | Akzeptanzkriterien |
|---|---|---|---|---|
| WP-218 | `apps/cli/src/index.ts:25` — **Einzeiler** | Der Import zeigt auf `./commands/init.js` statt `./commands/init/index.js`. Die vollständige `init`-Implementierung existiert und ist getestet — sie ist nur nicht verdrahtet. Das ausgelieferte Binär führt deshalb einen Stub aus: keine Spracherkennung, keine Topologie, keine Kommentare. | S | `untangle init` auf einem fremden Projekt erkennt Sprachen und Topologie; ein Test prüft, dass jeder registrierte Befehl auf seine echte Implementierung zeigt |
| WP-219 | `@untangle-code/core` + `untangle index` | Das fehlende Verbindungsstück zwischen scanner, parser-registry, chunker, embeddings-ollama, storage-qdrant und jobs. `jobs/src/stages.ts` verweist bereits auf ein Paket, das es nicht gibt. **Ohne diesen Befehl ist die gesamte Suchhälfte des Produkts unerreichbar.** | L | `untangle index` indiziert ein fremdes Projekt; `untangle query` findet danach etwas; `--explain` zeigt die Score-Zerlegung |
| WP-220 | Veröffentlichung — `workspace:*` bleibt wörtlich stehen | `npm pack` schreibt die 15 internen Abhängigkeiten unverändert als `workspace:*` ins Manifest. `npm install <tarball>` scheitert mit `EUNSUPPORTEDPROTOCOL`. Damit funktioniert genau die Zeile nicht, die README und `install.sh` versprechen. `pnpm publish` ersetzt das Protokoll, `npm publish` nicht — die Veröffentlichung muss über pnpm laufen und das muss erzwungen sein. | M | Ein gepackter Tarball lässt sich mit `npm install` in ein leeres Projekt installieren |
| WP-221 | **AGPL-Pflichten verletzt** | Kein einziger der 18 Tarballs enthält die LICENSE-Datei; NOTICE fehlt ebenso. AGPL-3.0-only §4/§5 verlangt, dass jeder Empfänger eine Kopie der Lizenz erhält. 16 der 18 Paket-READMEs erwähnen die Lizenz mit keinem Wort — und die README **ist** die npm-Paketseite. Zusätzlich: `THIRD_PARTY_LICENSES.md` ist in Risiko R6 ausdrücklich zum Release-Blocker erklärt und existiert nirgends. npm nimmt eine echte LICENSE-Datei automatisch auf, einen Symlink nicht. | M | Jeder Tarball enthält LICENSE und NOTICE; jede Paket-README nennt die Lizenz; `check-publishable` erzwingt beides |
| WP-222 | `untangle doctor` — zwei Widersprüche | (a) doctor liest nur `.untangle.json`, `init` schreibt `untangle.toml` — die frisch geschriebene Konfiguration ist für doctor unsichtbar, worauf er rät, `init` auszuführen, was gerade geschah. (b) Bei `qdrant.mode = "managed"` fällt doctor auf `127.0.0.1:6333` zurück, meldet die **fremde** Instanz als „[OK] Qdrant" und empfiehlt, dort zu indizieren — während `init` genau diesen Port unter Berufung auf spec.md §3.2 verweigert. Zwei Befehle desselben Werkzeugs widersprechen sich in einer Sicherheitsfrage. | M | doctor liest beide Formate; doctor empfiehlt nie einen Port, den init verweigert |
| WP-223 | `check-publishable` gibt falsche Entwarnung | Das Skript prüft die Felder, aber weder ob eine LICENSE-Datei existiert noch ob `workspace:*` im gepackten Manifest überlebt — also genau die zwei Dinge, an denen die Veröffentlichung tatsächlich scheitert. Ein Prüfskript, das die realen Blockierer nicht sieht, ist schlimmer als keins. | S | Das Skript schlägt bei beiden heutigen Blockierern fehl |
| WP-224 | Ausgelieferter Ballast | Testgerüst (`test-support/`, `testing/`) liegt in Produktions-Tarballs; jede ausgelieferte Source-Map ist tot, weil `src` fehlt — rund 40 % der Dateizahl je Tarball. | S | Kein Testgerüst und keine toten Maps in veröffentlichten Paketen |
| WP-225 | README verspricht MCP-Anbindung im Präsens | Der Eröffnungssatz behauptet eine Fähigkeit, die es nicht gibt; drei kopierfertige Blöcke folgen; erst 30 Zeilen später nimmt eine Stand-Notiz das zurück. E4 gilt auch für die README. | S | Keine Fähigkeit wird im Präsens behauptet, bevor sie läuft |
| WP-226 | Python-Tokenizer verliert NEWLINE nach nachgestelltem Kommentar | `tokenizer.ts:381-391` prüft nur das letzte Token auf `COMMENT` statt „seit dem letzten NEWLINE". | S | Regressionstest mit nachgestelltem Kommentar vor Zeilenende |

### Zwei Umgebungsbefunde, die keine Produktfehler sind

**Ollama liefert keine Embeddings.** `/api/tags` antwortet sofort, aber `/api/embed` und
`/api/embeddings` mit `qwen3-embedding:0.6b` laufen nach 30 s, 60 s und 180 s ohne Antwort aus.
Dadurch ist die semantische Hälfte der Suche bis heute **nie live belegt** — nur gegen den
deterministischen Embedder des testkits. Das ist die größte Lücke im Nachweis.

**Auf der fremden Qdrant-Instanz liegt eine Untangle-Collection.** `untangle_it_a5314a814d_code_v1`
auf `127.0.0.1:6333`, neben der fremden `multimodal_rag`. Sie stammt aus unserem eigenen
Integrationstest vor WP-75 — genau der Fehler, den WP-75 beschreibt. Der Abnehmer hat dort
ausschließlich gelesen. **Die Entscheidung über das Entfernen liegt beim Nutzer**, weil ein
Löschvorgang auf fremder Infrastruktur nicht rückholbar ist.

---

## 28. Welle 5 — die Puffergrenze belegt sich selbst

Die Selbstanalyse durch das eigene Binär, vor und nach der Reparatur von WP-215:

| Kennzahl | vorher | nachher | Änderung |
|---|---:|---:|---|
| Dateien gefunden | 805 | **918** | +113 |
| Code gerechnet | 652 | **709** | +57 |
| Dokumente (Prosa) | — | **57** | neue Kategorie (WP-217) |
| übersprungen | 220 | 223 | +3 |
| Ausführungseinheiten | 7.221 | **8.311** | +1.090 |
| Cognitive gesamt | 13.830 | **17.398** | **+25,8 %** |
| Cyclomatic gesamt | 15.664 | **18.850** | +20,3 % |

**Ein Viertel der kognitiven Komplexität dieses Repositoriums war unsichtbar.** Nicht falsch
gemessen — gar nicht gemessen. Auf Platz 4 der Hotspots steht jetzt
`packages/parser-registry/src/languages/python/engine.ts:448 walkStmt` mit cognitive 150; die Datei
ist 36,5 KB groß und gehörte damit zu den acht, die zuvor an der 32-KiB-Puffergrenze scheiterten.

Das ist der Beleg für die Vermutung aus §26: die Grenze traf **systematisch die größten Dateien**,
also genau die mit der höchsten Wahrscheinlichkeit, Hotspots zu sein. Jede Hotspot-Liste, jede
Ratsche und jede Risikobewertung vor dieser Reparatur war nach unten verzerrt.

### Prosa ist jetzt eine eigene Kategorie

`untangle complexity` weist Dokumente getrennt aus — 57 Stück. Sie werden **nicht** in die
Code-Summen gerechnet, was §1c entspricht: Prosa ist erstklassiger Inhalt, aber keine Ausführung.
Zwei neue Sprachfamilien im Parser: `prose` und `structured-text`.

### Ein Agent hing, ohne seine Arbeit zu verlieren

Der fünfte Bau-Agent lieferte kein Ergebnis; alle fünf Agentenprotokolle standen 73 Minuten still,
während der Workflow weiter auf `running` stand. Seine Arbeit war jedoch bereits vollständig auf
die Festplatte geschrieben — `prose/` und `structured-text/` liegen im Quelltext, die Tests laufen
grün. Der Workflow wurde gestoppt, der Stand verifiziert und übernommen.

Merkposten für künftige Wellen: ein Workflow-Status `running` ohne Schreibvorgänge ist kein Beweis
für Fortschritt. Die Aktivität der Agentenprotokolle ist das verlässlichere Signal.

---

## 29. Welle 7 — ast-grep aufgenommen, die eigene These aber nicht eingelöst

Beide Gutachter urteilen **trägt-nicht**. Das ist das richtige Urteil, und es ist wertvoller als
ein beschönigtes — zumal die Welle auf eine ausdrückliche Entscheidung des Nutzers zurückging.

### Was gelungen ist

**Der Motortausch ist bitgenau ergebnisgleich.** Der Gutachter verglich denselben Eingabebaum durch
beide Binäre: 8.757 vorbestehende Symbolzeilen, davon **null geändert, null entfallen**, drei neu
(`die`, `say`, `usage` aus `scripts/install.sh`, weil Bash dazukam). `cognitive` 18.316 → 18.316,
**identisch**, obwohl der Motor unter allen vier Bestandssprachen ausgetauscht wurde. Laufzeit eher
minimal schneller. Für eine Migration dieser Größe ist das ein starker Beleg.

**Elf Sprachen sind dazugekommen** — Go, Rust, Java, C#, Ruby, PHP, Kotlin, C, C++, Swift, Bash.
Je Sprache kostet das 65 bis 133 Zeilen Tabelle, also genau die Ratsche, die versprochen war.

### Was misslungen ist

| Kennzahl | vorher | nachher | |
|---|---:|---:|---|
| Kognitive Gesamtkomplexität | 18.316 | **19.461** | +1.145 (+6,3 %) |
| Produktivcode (.ts) | 48.829 | **52.535** | +3.706 Zeilen |
| Abgelöste Dateien | — | **0** | |

**Der Tausch, um den es ging, fand nicht statt.** `languages/python/` steht unverändert bei
cognitive 2.140 über 425 Ausführungseinheiten. Die 5.604 handgeschriebenen Zeilen, deren Ablösung
das erklärte Ziel war, sind alle noch da.

**Stattdessen ist der größte Hotspot der Projektgeschichte entstanden:**
`shared/table-profile.ts:390 createTableProfile` mit **cognitive 312**, 515 SLOC — 55 % über dem
bisherigen Spitzenwert. Die kognitive Komplexität von `languages/shared/` hat sich verdoppelt
(566 → 1.169, **+106 %**) bei netto −14 Zeilen.

**Bedingung 3 aus `vision.md` §1b ist verletzt:** 13 neue Abhängigkeiten mit nativem Binärteil,
301 MB. §1b bindet die Aussage „besser" ausdrücklich an *keine neuen Abhängigkeitskanten*.

Nach unserem eigenen Maßstab ist diese Welle damit **keine Verbesserung, sondern eine
Verschlechterung mit Fähigkeitsgewinn**. Beides gehört zusammen genannt.

### Die Python-Ablösung existiert — aber nicht im Arbeitsbaum

Der zuständige Agent hat sie gebaut, jedoch in einem **isolierten Worktree**, weil ein zweiter Agent
gleichzeitig dieselben Verzeichnisse umbaute und seine Dateien im Minutentakt überschrieb. Er hat
zwei Worktrees von HEAD gezogen und dort gemessen, statt im Hauptbaum wertlose Ergebnisse zu
erzeugen (E5). Das ist die richtige Entscheidung gewesen — der Fehler liegt bei mir: **ich habe drei
Agenten gleichzeitig in dasselbe Paket geschickt.**

Ein dritter Agent hat denselben Konflikt anders gelöst: er hatte bereits ~1.500 Zeilen eines eigenen,
parallelen Motors fertig, entdeckte den Motor des anderen Agenten und **löschte seinen eigenen**,
statt einen zweiten daneben zu stellen. Auch das war richtig.

### Befunde

| ID | Befund | Schwere |
|---|---|---|
| WP-236 | **Rust:** `///`- und `//!`-Kommentare verschlucken die nächste Codezeile. `sloc`, `comment_ratio` und `doc_ratio` sind dadurch falsch. **(E4)** | **hoch** |
| WP-237 | **Go:** Methodensymbole verlieren den Empfängertyp — zwei verschiedene Methoden bekommen denselben qualifizierten Namen. | **hoch** |
| WP-238 | **Python:** `with a() as x, b() as y:` lässt die ganze Datei mit `parseQuality: "failed"` durchfallen — im Parser, dessen Ablösung diese Welle als Ziel nannte. | **hoch** |
| WP-239 | **Kernthese nicht eingelöst:** +1.145 cognitive, null abgelöste Dateien. Die Python-Ablösung aus dem Worktree überführen und `createTableProfile` (cognitive 312) zerlegen. | **hoch** |
| WP-240 | `supportLevel: "deep"` ist **nicht an die Grammatikverfügbarkeit gebunden**: elf Sprachen versprechen `deep` und können nach `npm install` still ausfallen, weil die Sprachpakete nur für fünf Plattformen Prebuilds liefern und `postinstall` den Fehlschlag mit Exit 0 verschluckt. **(E4)** | **hoch** |
| WP-241 | Tote Produktionsabhängigkeit `@ast-grep/lang-python` (5,9 MB), von keiner Zeile Quelltext benutzt. | mittel |
| WP-242 | Go und Rust verlieren Schnittstellen- und Trait-Deklarationen ohne Rumpf komplett aus den Symbolen. | mittel |
| WP-243 | Kotlin: `else if` zählt als volle Verschachtelung — 50 % höhere Cognitive-Zahl als bei zeichengleichem Java-Code. | mittel |
| WP-244 | README nennt eine Größengrenze von 6 MiB, der Code erzwingt 5 MiB. **(E4)** | mittel |
| WP-245 | `THIRD_PARTY_LICENSES` nennt die Lizenz je eingebetteter Fremdgrammatik nicht — die Sprachpakete liefern fremde Grammatiken aus, führen in ihrer LICENSE aber nur sich selbst. | mittel |
| WP-246 | `untangle doctor` meldet nicht, welche ast-grep-Sprachen tatsächlich verfügbar sind. `astGrepLanguageStates()` existiert, wird aber von keinem Befehl gelesen. | mittel |

### Lehre für die Wellenplanung

Drei Agenten in einem Paket erzeugen einen Motor zu viel und eine Ablösung zu wenig. Künftig gilt:
**ein Paket, ein Agent** — oder eine ausdrückliche Reihenfolge mit Übergabe, nicht Gleichzeitigkeit.

---

## 30. Welle 7b — die Ratsche greift, aber die Tests wären fast mitgegangen

Der erste Anlauf brach ab: **alle sechs Agenten liefen ins Sitzungslimit**. Was sie bis dahin
geschrieben hatten, lag jedoch vollständig auf der Platte, und der wichtigste Teil war fertig. Die
anschließende Fortsetzung hat die damals offenen Parser-, Profil- und Sucharbeiten abgeschlossen;
die folgenden Abschnitte bewahren zuerst den Zwischenstand und halten danach den Endzustand fest.

### Die Ablösung ist vollzogen

| | vorher | nachher |
|---|---:|---:|
| `languages/python/` Produktivcode | **5.604 Zeilen** | **693 Zeilen** |
| Kognitive Gesamtkomplexität des Repos | 19.461 | **17.872** |
| Ausführungseinheiten | 9.118 | 8.965 |

**−4.911 Zeilen, −1.589 cognitive.** Die drei Python-Hotspots, die seit Welle 5 auf den Plätzen 2,
4 und 5 standen — `collectLeafTextsStmt` (201), `tokenize` (169), `walkStmt` (150) — sind aus der
Liste **verschwunden**. Damit ist die Bilanz aus §29 gedreht: Welle 7 hatte +1.145 cognitive
gebracht, Welle 7b nimmt 1.589 wieder heraus.

### Die Bedingung wurde verletzt, und es ist gut ausgegangen

Die Auflage lautete: *die 1.432 Zeilen Python-Tests müssen grün laufen, bevor irgendetwas gelöscht
wird.* Der Agent hat sie **mitgelöscht** — 1.432 → 520 Zeilen, und keiner der vier historischen
Defektfälle war noch abgedeckt.

Zur Hälfte war das richtig: `tokenizer.test.ts` und `parser.test.ts` prüften interne Formen, die es
nicht mehr gibt. Falsch war, die **Verhaltensfälle** mit aufzugeben.

Aufgefallen ist es, weil `scripts/e2e-smoke.mjs` — das kumulative Regressionsnetz — sofort anschlug:

```
ASSERTION FAILED: WP-115 VIOLATED (false success): "deep-parens" discarded
f-string content but reported parseQuality="complete"
```

### Die Prüfung war überholt, nicht der Code

Nachgemessen: die Bedingung `1 if x else 2` wird auch in **5.000 Klammerebenen** noch als genau ein
Entscheidungspunkt gezählt. Der Inhalt geht also nicht verloren — `complete` ist die *wahre*
Aussage. Der alte Defekt lag an `DEFAULT_MAX_PARSE_DEPTH` im handgeschriebenen Parser, den es nicht
mehr gibt.

Die Prüfung wurde deshalb **an der Invariante ausgerichtet statt an ihrem früheren Symptom**. Die
Invariante lautete nie „tiefe Verschachtelung muss ein Diagnostic erzeugen", sondern **„Inhalt darf
nicht still verlorengehen"**. Beim alten Parser war ein Diagnostic der einzige Weg, sie zu erfüllen;
jetzt wird direkt geprüft, dass der Inhalt ankommt. Das ist ein **schärferer** Test als vorher.

### `python/regressions.test.ts` — 20 Verhaltenstests

Gegen `parse`, `extractSymbols` und `computeComplexity` formuliert, weil diese Oberfläche einen
Backendwechsel überlebt und die Interna nicht:

| Fall | Prüfung |
|---|---|
| WP-76 | elif-Ketten mit 10, 500 und 2.000 Klauseln ergeben genau so viele Entscheidungen |
| WP-115 | Tiefe 1/100/1.000/5.000 behält ihren Inhalt; kaputte Eingabe wird gemeldet; sechs gültige Formen bleiben unangetastet |
| WP-226 | Nachgestellter Kommentar beendet die Zeile nicht, die Folgezeile geht nicht verloren |
| WP-238 | `with a() as x, b() as y:` samt geklammerter und `async`-Form |

**WP-238 ist durch die Ablösung gratis mitbehoben** — der alte Parser ließ diese Form die ganze
Datei mit `parseQuality: "failed"` durchfallen.

### Ein Werkzeugfehler von mir

`pnpm lint:fix` auf einem halbfertigen Baum hat einen Werte-Import mit einem `import type`
verschmolzen. Dadurch verschwanden `compareCodepoints`, `classifyAdapterFailure`,
`parserBackendForLanguage` und `sha256Hex` beim Übersetzen — vier CLI-Tests fielen mit
`ReferenceError` um. Merkposten: **kein `lint:fix` auf einem Baum, den ein Agent halbfertig
hinterlassen hat.**

### Parser und Profil: der damalige Rest ist geschlossen

`createTableProfile` ist kein 515-SLOC-Entscheidungsmonolith mehr. Die Verantwortung liegt jetzt in
`table-profile-decisions.ts`, `table-profile-module-facts.ts`, `table-profile-queries.ts` und
`table-profile-scopes.ts`; `table-profile.ts` verdrahtet diese Teile. Damit ist der zweite Teil von
WP-239 umgesetzt, ohne die bereits vollzogene Python-Ablösung zurückzudrehen.

Die vier offenen Sprachdefekte sind als Verhaltensregressionen geschlossen:

- **WP-236:** Rust-`///`- und `//!`-Kommentare enden exakt an ihrer eigenen Zeile, auch mit CRLF und
  Unicode; die folgende Codezeile bleibt in SLOC und Symbolanalyse erhalten.
- **WP-237:** Go-Methoden tragen den Empfängertyp im qualifizierten Namen, einschließlich Pointer-
  und generischer Receiver.
- **WP-242:** rumpflose Go-Interface- und Rust-Trait-Methoden bleiben als Symbole erhalten;
  Deklarationen in Rust-`extern`-Blöcken werden nicht fälschlich als Trait-Methoden ausgegeben.
- **WP-243:** Kotlins `else if` hat dieselbe kognitive Form wie die entsprechende Java-Fortsetzung,
  einschließlich Kommentarvarianten und negativer Gegenproben.

WP-238 war bereits durch den Backendwechsel behoben. WP-244 ist ebenfalls geschlossen: README und
Code nennen beide die wirkliche Grenze von **5 MiB**.

### Suche: WP-231 bis WP-233 geschlossen

Der Diagnosehelfer wurde zu einem versionierten Benchmark-Katalog und einer produktiven
`untangle-ranker-v2`-Änderung ausgebaut. Auf dem rekonstruierten 22-Fragen-Hauptkatalog stieg MRR
von 0,601190 auf **0,693939**, Platz 1 von 11/22 auf **13/22** und Recall@5 von 16/22 auf
**18/22**. Die fünf exakten Symbolnamen stehen sämtlich auf Platz 1 (WP-233); die sieben deutschen
Hauptfragen steigen bei Recall@5 von 3/7 auf 5/7, und eine Korroborationsprobe plus sechs getrennte
deutsche Holdouts stehen unter derselben produktiven Policy jeweils auf Platz 1 (WP-232).

WP-231 entscheidet Abwesenheit nicht aus einem universellen Cosine-Wert. Ein exakter Symbolname ist
direkte Evidenz; sonst müssen dichter Topwert ≥ 0,45, Abstand von Rang 1 zu festem dichtem Rang 50
≥ 0,061 und IDF-gewichtete Query-Abdeckung in einem Kandidaten ≥ 0,291 **gemeinsam** tragen. Die
knappen gemessenen Trennmargen betragen rund 0,0059/0,0055 beim Abstand und 0,0073/0,0062 bei der
Abdeckung (Wahrheit über der beziehungsweise klare Negativprobe unter der Grenze). Die IDF wird in
der festen Union aus dense50 und sparse50 bestimmt und driftet daher nicht mit `candidateLimit`:
Live-Läufe bei 50, 80, 100, 150 und 200 behielten jeweils 22/22 Wahrheiten und verwarfen 7/7 klare
Negativproben. Die Ranking-MRR darf dabei von 0,693939 auf 0,686364 wechseln; die
Abwesenheitsentscheidung, Platz 1 (13/22) und Recall@5 (18/22) blieben stabil.

Die Policy ist an Embedding-Profil, Workspace und Collection gebunden; die behauptete Target-ID
muss der tatsächlichen Embedder-ID entsprechen, sonst bricht die Engine beim Aufbau ab. Fehlt der
spärliche Abrufzweig oder die passende Bindung, folgt bei nicht-exakten Fragen die sichtbare
Nichtentscheidung `RELEVANCE_POLICY_NOT_EVALUATED`, nicht eine unkalibrierte Abwesenheitsaussage.
Auch Config-Layer behandeln jedes profilbezogene Binding atomar: Ein höheres Layer kann nicht
Workspace oder Collection austauschen und dabei unbemerkt die Schwellen eines niedrigeren Korpus
erben; ein unvollständiger Ersatz scheitert stattdessen an der Validierung.
Ein Benchmark-Abruffehler bricht vor dem Schreiben eines Artefakts ab. Die vierte Grenze bleibt
bewusst dokumentiert: Gemessen wurde am stehenden **7.983-Punkte-Index** mit Korpusgeneration
`unknown`; eine wesentliche Korpusrevision verlangt Neuvermessung.

Drei kompositionelle Negativdiagnosen bleiben absichtlich außerhalb des harten Gates: Einzelne
Teilkonzepte existieren, nur ihre behauptete Beziehung nicht; reine Vektorsuche kann dieses
Entailment nicht zuverlässig entscheiden. WP-234 (mehrdateiliche Antworten über Suche plus Graph)
und WP-235 (Laufzeit nach Stufen aufschlüsseln) bleiben daher **offen**.

### Verifikationsstand nach dem Monorepo-Gate

Die paketbezogenen Testläufe sind grün: Parser **211**, Domain **204**, Config **89 plus ein
plattformbedingter Windows-Skip**, Search **353 Tests in 21 Dateien** und CLI **222**. Danach lief
auch die vollständige Folge gegen den gemeinsamen Arbeitsbaum grün:

- `pnpm -r build` und `pnpm -r typecheck`: alle 20 Workspace-Projekte im Lauf erfolgreich,
- `npx vitest run`: **270 Testdateien bestanden**, eine übersprungen; **2.822 Tests bestanden**,
  vier übersprungen,
- `pnpm lint`: ohne Befund,
- `pnpm e2e:smoke`: `ALL ASSERTIONS PASSED` gegen die gebauten Distributionen,
- `pnpm check-publishable`: 19 öffentliche Tarballs mit 2.135 Dateien und ein privates Paket ohne
  Abweichung,
- `pnpm check-licenses`, `git diff --check` und die Gleichheitsprüfung beider Config-Schemas: ohne
  Befund.

Zwei vollständige Benchmark-Nachläufe waren nach Entfernung allein von Label und Laufzeiten
bytegleich; beide lieferten MRR 0,693939, Platz 1 13/22, Recall@5 18/22 und 7/7 Enthaltungen für
die klaren Negativproben.

Die Eigenkomplexitätsmessung trennt den Refaktorerfolg von der zugleich hinzugekommenen
Suchfunktionalität: `createTableProfile` fiel von cognitive **320** / cyclomatic **131** auf
**0/1**; der komplexeste der ausgelagerten Table-Profile-Bausteine liegt bei **12/13**. Über das
gesamte, gewachsene Repository stiegen dagegen 986 auf 994 gefundene Dateien, 8.982 auf 9.225
Ausführungseinheiten, cognitive 17.889 auf **17.906** und cyclomatic 20.021 auf **20.366**. Das ist
keine globale Senkung und wird nicht als solche verbucht: Der lokale Monolith ist entfernt, während
Policy-, Benchmark- und Regressionstestcode hinzugekommen sind.

---

## 31. Welle 8 — eine Runtime, persistierte Graphen und sichtbarer Kontext

Welle 8 schließt vier bisher nebeneinanderliegende Wege zu einer belastbaren Oberfläche zusammen:
die programmatic Fassade, das persistierte Graphpaar, Graphkontext an Suchtreffern und MCP samt
Offline-Explorer. Die Welle behauptet dabei bewusst nicht, dass sämtliche 39 MCP-Fähigkeiten oder
die vollständige Portfolio-Engine schon existieren.

### Programmatic Fassade

`@untangle-code/core` exportiert `createUntangle` und den kompatiblen Namen
`createUntangleEngine`. Die acht Methoden aus `spec.md` §22 delegieren ausschließlich an injizierte
Use-Case-Ports, reichen `AbortSignal` weiter und übersetzen Abbrüche einheitlich. Ein nicht
verdrahteter Port wirft `FEATURE_UNAVAILABLE`; Schließen ist idempotent und verhindert neue Arbeit.
Die Fassade erfindet weder CLI-Konfiguration noch Adapter. Die weitergehenden Context- und
Portfolio-Methoden aus dem vollen WP-23-Ziel bleiben offen.

### Ein Graphpaar je Workspace und Generation

Datei- und Symbolgraph werden mit kollisionsfreien Workspace-Shard-IDs und expliziter Generation
geschrieben und gelesen. Jeder Graph-Shard-Payload wird erneut gegen beide Identitäten geprüft. Alte globale
Shards werden standardmäßig nicht gelesen; der Legacy-Pfad verlangt ein ausdrückliches
`allowLegacyFallback` und denselben Scope. Der vollständige Symbolsnapshot enthält Knoten, Kanten,
Metriken und Skip-Ledger. Der nach dem Dateigraph geschriebene Symbolshard dient als Publish-Marker
für ein zusammengehöriges Paar.

Jeder neu geschriebene `code_chunk` trägt dieselbe `generation_id` und die verwendete
`metrics_version`; Suchtreffer beziehen daraus `indexGeneration` und `metricsVersion`. Alte Punkte
ohne diese Felder bleiben sichtbar `unknown` und werden niemals still dem neuesten Graphen oder
einer aktuellen Metrikversion zugeordnet — sie brauchen einen Vollreindex. Unveränderte
inkrementelle Läufe behalten dieselbe Generation. Kann diese Generation nicht sicher aus einem
passenden Checkpoint fortgesetzt werden, wird jede Datei neu geschrieben, damit Chunk-Payloads und
das vollständig neu publizierte Graphpaar nicht auseinanderlaufen.

Das ist noch keine allgemeine Transaktion über sämtliche Index-Metadaten: Graph-Garbage-Collection
fehlt, alte globale Shards verlangen standardmäßig einen Reindex, und ein einzelner Indexlauf über
ein Repository ist noch kein workspace-weites Cross-Repo-Abbild. `untangle_cross_repo_impact`
bleibt deshalb ausdrücklich nicht verfügbar.

### Suchkontext ohne Ranking-Mutation

`untangle query --context --linked` reichert erst **nach** Ranking, Deduplizierung und Limit an.
Dateikontext besteht aus direkten persistierten Kanten in beide Richtungen; Symbolbeziehungen
verwenden nur exakt aufgelöste persistierte Endpunkte. Jede Relation trägt Workspace-Generation,
Repository, Ref, Datei/Pfad, Richtung, Kantenart und gespeicherte Cross-Repo-Provenienz. Fehlende
oder partielle Graphen werden als Warnung und Auslassung sichtbar, verändern aber weder Reihenfolge,
Scores, Fingerprint noch Trefferzahl. Relationen, Warnungen, IDs und Diagnosetexte sind hart
begrenzt; adversarielle Provider-Ausgaben können die Ergebnisgröße nicht wieder öffnen.

Damit ist WP-234 auf der Ebene **evidenztragender Mehrdatei-Kontexte** gebaut. Eine synthetisierte,
mehrdateilige Antwort ist damit noch nicht automatisch bewiesen und wird nicht als solche verbucht.
Im Grep-Modus bleibt `--context=N` beziehungsweise `-C N` numerisch; ein nacktes `--context` ist
dort ein Aufruffehler, während derselbe Schalter in der Indexsuche die Graphanreicherung aktiviert.

### MCP: vollständige Namens- und Vertragsoberfläche, partielle Fachabdeckung

Die öffentliche Runtime liegt in `@untangle-code/cli/mcp`; `apps/mcp-server` reexportiert sie nur.
`untangle mcp --stdio` registriert exakt die 32 Namen aus `spec.md` plus sieben aus `portfolio.md`.
Jedes Tool besitzt ein eigenes Input- und Success-Data-Schema; Fehler bleiben im gemeinsamen
`ToolResponseEnvelopeV1`. Ungültige Argumente, falsche Runtime-Ausgaben, Workspace-Konflikte und
Abbrüche bleiben damit auch im strukturierten Segment maschinenlesbar. Das echte gebaute Binary ist
gegen Legacy- und aktuelles MCP-Protokoll getestet.

Von 39 Tools sind **16** fachlich verdrahtet: Health, Projekte, Suche, Context-Liste, vier
Dateigraph-Lesewege samt Visualisierung, zwei Symbolwege, Flow, Impact, Complexity, Hotspots und
About. Die übrigen 23 Namen antworten mit `FEATURE_UNAVAILABLE`; insbesondere Portfolio, Change,
Quality Gate, Jobsteuerung und echter workspace-weiter Cross-Repo-Impact werden nicht vorgetäuscht.

Die Sicherheits- und Integrationsgegenprobe schloss mehrere echte Grenzfehler: Pfadausbruch über
dangling Symlinks sowie ungültige oder zyklische Pfade, SDK-Vorvalidierung mit text-only-Fehlern,
unmögliche Success-/Failure-Envelopes, fremde Success-Daten, asynchrone Graph-Ladefehler und
Mid-flight-Abbrüche in Complexity, Health und Search. Pfade werden vor dem Runtime-Aufruf
kanonisiert, Eingaben manuell in das gemeinsame Envelope übersetzt und Erfolgsdaten mit der
jeweiligen Operation korreliert. Explizite `workspaceId` wird zentral gegen den bedienten Workspace
geprüft; die 16er-Verfügbarkeitsliste ist unveränderlich und auf vollständigen Dispatch geprüft.
Graph-Query verlangt eine explizite Datei und ist auf Tiefe 16, 5.000 Knoten und 20.000 Kanten begrenzt;
Flow/Impact auf Tiefe 64, 1.000 Resultate, 5.000 Knoten und 20.000 Kanten. Abschneidung bleibt im
Ergebnis sichtbar, ein Abort kann keinen erfolgreichen Teilbefund veröffentlichen. Der
stdio-Vertrag baut vor seinem Test zwingend das ausgelieferte Binary, damit ein alter `dist`-Baum
keinen falschen Erfolg erzeugt.

### Offline-Explorer

`@untangle-code/graph-explorer` erzeugt deterministisches, selbstenthaltenes HTML aus strukturellen
Datei- und Symbolsnapshots. Nutzdaten liegen Base64-kodiert in einem inerten Element; CSP erlaubt
weder Netzwerk noch fremde Skripte, und die Runtime baut Beschriftungen nur mit DOM-APIs und
`textContent`. Enthalten sind Datei-/Symbolumschaltung, Suche, Repository- und Kantentypfilter,
zyklussichere rückwärts-transitive Hervorhebung, Inspector, die Layouts `repository-lanes`, `grid`
und `circle` sowie lokaler PNG-Export. Quelltext, Rohimporte, Signaturen und Content-Hashes gehören
nicht zum serialisierten Modell.

Die CLI schreibt nur mit explizitem `untangle graph visualize --out=<DATEI>` und meldet exakte
Trunkierungsstatistiken. Pakettests führen die eingebettete Runtime in einem DOM-Harness aus; eine
zusätzliche Browser-Screenshot-Prüfung deckt Desktop und schmale Viewports ab. Der PNG-Pfad setzt
moderne SVG-/Canvas-/Blob-APIs voraus und begrenzt die längste Seite auf 4096 Pixel.

### Verifikationsstand

Der Abschlusslauf gegen den gemeinsamen Arbeitsbaum ist grün:

- `pnpm -r build` und `pnpm -r typecheck`: alle 22 Workspace-Projekte erfolgreich,
- `npx vitest run`: **285 Testdateien bestanden**, eine übersprungen; **2.963 Tests bestanden**,
  vier übersprungen,
- `pnpm lint` ohne Befund und `pnpm e2e:smoke` mit `ALL ASSERTIONS PASSED`, einschließlich
  gebautem MCP-stdio-Vertrag und Explorer-Runtime,
- `pnpm check-publishable`: 20 öffentliche Tarballs und zwei private Hilfspakete korrekt erkannt;
  `pnpm check-licenses`, `pnpm format:check` und `git diff --check` ohne Befund.

Die eigene Komplexitätsmessung lief mit `untangle-metrics-v1` über 823 von 1.051 gelieferten
Dateien; 228 Auslassungen stehen mit Grund im Ledger. Alle Zähl- und Wertinvarianten halten. Die
Funktionslesart umfasst 6.205 Einträge mit cognitive **16.888** und cyclomatic **16.485**; der
größte Hotspot bleibt `loadWorkspaceTopology` mit cognitive 177. Das gewachsene Repository wurde
damit vermessen, eine globale Komplexitätssenkung wird nicht behauptet.

Ein anschließender echter Vollindex mit dem gebauten Binary analysierte **1.046/1.046** geplante
Dateien, schrieb **8.842** Chunks/Punkte und **12.610** Symbole sowie ein Dateigraphpaar mit
1.046 Knoten/3.641 Kanten und 8.488 Symbolknoten/34.562 Symbolkanten. Die veröffentlichte Generation
`a62f4077-46f6-4dac-83a9-03d1ba1663bf` lieferte danach über CLI und den aktuellen MCP-Client
denselben Treffer `createUntangle` mit `metricsVersion: "untangle-metrics-v1"`. MCP listete exakt
39 Tools beziehungsweise 16 verfügbare, beantwortete Search und Graph Query und erzeugte den
selbstenthaltenen Explorer; stdout/stderr blieben protokollsauber. Desktop- und Mobilansicht des
Explorers wurden zusätzlich im Browser visuell geprüft.

---

## 32. Welle 9 — vom Suchtreffer zur dynamischen Product Complexity

Welle 9 baut den zentralen Differenzierer additiv auf die seit Welle 8 funktionierende Suche:
Untangle beobachtet nicht nur statische Codekomplexität und synthetische Symbol-Findability,
sondern den realen Suchweg eines Agenten von einer Produktabsicht bis zu einem ausdrücklich
bestätigten Ziel. Eine normale Suche ohne Search Journey bleibt fachlich rückwärtskompatibel; die
additive Beobachtung darf weder Query-Fingerprint noch Retrieval, Ranking, Treffer oder
Fehlersemantik verändern.

### Arbeitspakete

| ID | Bereich | Zweck | Quellabschnitte | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|---|
| WP-247 | `packages/domain` | Versionierte Verträge für Retrieval-Funnel, Search Journey, Target-Locator, Dynamic Search Complexity, kohortierte Product Complexity, Store-Port und benannte Session-Fehler | `spec.md` §13.7, §25.1; `vision.md` §1e | WP-01, WP-19 | M | `untangle-dynamic-search-complexity-v1` ist von Cognitive Complexity und Findability getrennt; Sessionzustände sind `active\|completed\|abandoned`; kein abgeschlossenes Assessment ohne mindestens einen Versuch und explizites Target; Kandidatenvertrag enthält keinen Chunk-/Quelltext; Error Codes `SEARCH_SESSION_NOT_FOUND`, `SEARCH_SESSION_CONFLICT`, `SEARCH_SESSION_INVALID_STATE` sind exportiert und getestet |
| WP-248 | `packages/search` — Retrieval-Funnel | Erklärbare Kandidatenzähler je Profilgruppe von Dense/Sparse/Symbol-Abruf über Filter, Ranking, Dedupe und Qualifikation bis zur Ausgabe | `spec.md` §13.2, §13.7 | WP-19, WP-247 | M | Diagnose beeinflusst Ranking/Fingerprint nicht; alle Funnel-Zähler halten Monotonie-Invarianten der jeweiligen Stufen; Dateistreuung liegt in `[0,1]`; Kandidatenlimit und Top-Score-Abstand sind deterministisch; nicht durchsuchte Profile bleiben von leeren Suchergebnissen unterscheidbar; bekannte Generationen bleiben auch bei finaler No-hit-Ausgabe erhalten; nur abgeschlossen verifizierte Indexevidenz liefert den aus dem vollständigen Manifest abgeleiteten `corpusRevisionFingerprint` |
| WP-249 | `packages/search` — Search-Journey-Service | I/O-agnostische State Machine für `start`, erfolgreiche/fehlgeschlagene Search-Beobachtung, `observe`, `get`, `complete`, `abandon` und `report`; task-basierte Indikatoren und kompatible Kohorten | `spec.md` §13.7; `product.md` §4.7, §8.7 | WP-247, WP-248 | L | Ziel-/Querytext nur bei `retainText`, sonst workspace-lokale, domain-separierte HMAC-SHA-256-Fingerprints; freier Fehler-/Abbruchtext ebenfalls nur bei `retainText`, kontrollierter Abbruch-Code textfrei; derselbe `clientStep` und dieselbe Beobachtung sind ohne Revisionsänderung idempotent, abweichende Wiederholung ergibt Konflikt; ohne `acceptedAttemptId` zählen alle Suchen bis zum Abschluss; eine explizite Auswahl bleibt additiv als `outcome.acceptedAttemptId` erhalten und wird an Domain-, Store- und MCP-Grenze gegen genau diesen Versuch geprüft, während Legacy-Outcomes ohne Feld lesbar bleiben; ausgefallene oder partiell ungesunde Retrievals verhindern einen vollständigen Messkontext; v2 erhält je Profil die Verbindung aus Embedding-Profil, Indexgenerationen und Korpusrevision, während Legacy-Kontexte sichtbar, aber nie ausreichend bleiben; ein extern oder profilmehrdeutig bestätigtes Target erzeugt keine erfundenen Rangwerte; keine Precision- oder opake Score-Ausgabe; `sufficientEvidence` erst ab drei abgeschlossenen Sessions desselben vollständigen Messkontexts |
| WP-250 | `packages/storage-local` | Lokale, atomare und gegen konkurrierende Schreiber geschützte Journey-Persistenz unter `.untangle/product-complexity/sessions` | `spec.md` §13.7, §24; `architecture.md` §12, §21.2 | WP-12, WP-247 | M | Pfadableitung akzeptiert nur sichere Session-IDs; der workspace-lokale HMAC-Schlüssel liegt separat unter `.untangle/product-complexity/fingerprint.key`; der POSIX-Adapter schreibt Schlüssel und Journey-Dateien mit Modus `0600`; Schreiben nutzt erneuerte Fingerprint-/Create-/Session-Leases, Compare-and-Swap-Revision, owner-geprüften Pre-Commit, gemeinsames Zehn-Sekunden-Frischefenster aller Publish-Locks mit begrenztem Fail-closed-Konvergenzversuch, temporäre Datei und Rename; exakte Temp-Pfade werden auch nach Abbruch/Fehler best-effort bereinigt; 32 MiB je Datensatz, 10.000 Dateien und 128 MiB je vollständigem `list`-/`report`-Snapshot werden vor und nach tatsächlichem Lesen fail-closed erzwungen; erkannte Verschwinden-, Typ-, Größen- und Bytebudgetänderungen während des Snapshots brechen sichtbar ab, während gleich große atomare Ersetzungen ohne versioniertes Read-Primitive als lokale Grenze dokumentiert bleiben; korrupte Datensätze werden nicht als Messung gelesen; Workspace-Filter und deterministische Sortierung sind getestet |
| WP-251 | `apps/cli/src/mcp` + privater Wrapper | `untangle_search_session` als ein Management-Werkzeug mit sechs Aktionen; optionale `session: { id, step }`-Kopplung an `untangle_search`; strikt validierte Success-Schemas | `spec.md` §21; `product.md` §9 | WP-24, WP-249, WP-250 | L | MCP listet exakt 40 Namen; `start\|get\|observe\|complete\|abandon` liefern eine Journey und `report` den Kohortenreport; gekoppelte Search-Antwort trägt `searchObservation`; Recorderfehler ergibt sichtbar `status: "not_recorded"`, während die fachlich erfolgreiche Suche erfolgreich bleibt; derselbe Vertrag läuft über Legacy- und aktuellen MCP-Client gegen das gebaute Binary |
| WP-252 | Produktvertrag, Parität und Realprobe | Vision, Produktdefinition, Spezifikation, Bauplan und Paritätsmatrix bilden denselben Vertrag ab; eine echte task-basierte Search Journey belegt die End-to-End-Kette | `vision.md` §1e; `product.md` §4.7, §8.7, §15; `spec.md` §13.7, §21 | WP-247–WP-251 | M | Paritätsmatrix wird in derselben Welle fortgeschrieben; Realprobe führt `start` → mindestens eine gekoppelte hybride Suche → Target-Bestätigung → `report` aus; Goal-, Query- und Failure-Reason-Rohtexte fehlen im gespeicherten Default-Datensatz, während Locator-, Rang-, Score-, Tool- und Lifecycle-Metadaten sichtbar bleiben; Ausgabe zeigt Funnel, Target-Rang und Caveats; alle gemeinsamen Gates bleiben grün |
| WP-253 | Feature Probe und Feature→Code-Abbildung | Eine optionale, vom Caller als stabil deklarierte Feature-ID verbindet reale Workspace-Suchen mit bestätigten Codezielen; Suchaufwand und statische Target-Code-Complexity bleiben getrennte Evidenzachsen | `vision.md` §1e; `product.md` §2.6, §4.7; `spec.md` §13.7 | WP-247–WP-252 | M | Feature-ID wird standardmäßig als eigene workspace-lokale HMAC-Domain pseudonymisiert; Kandidatenbeobachtung bindet Complexity- und Payload-Vollständigkeit in die Idempotenz ein; neue Abschlüsse liefern beobachtete oder diskriminiert nicht verfügbare Target-Code-Evidenz; `featureMappings` gruppiert ausschließlich explizit getaggte Journeys nach Feature-Fingerprint plus Messkontext, bilanziert alle getaggten Abschlüsse exakt über `featureTaggedCompleted` und mittelt keine Scope-/Version-/Generationsvarianten; Embeddings werden nicht als Complexity-Metrik und beide Achsen nicht als kombinierter Score ausgegeben; der Vertrag behauptet keine eigenständige Verifikation von Feature-Semantik, Korrektheit, Stabilität oder Code-Ownership; Realprobe belegt die Abbildung gegen Untangles eigenen Index |
| WP-254 | Corpus- und Suchprovenienz-Härtung nach dem Wave-9-Audit | Bindet veröffentlichte Korpusrevisionen an tatsächlich analysierte Bytes, ersetzt geänderte Dateien vollständig und begrenzt ref-lose Suche auf lokal aufgezeichnete aktuelle Kontexte | `spec.md` §10.5, §12.1, §13.2; `architecture.md` §13, §18.1 | WP-248, WP-252 | M | Analyse und unveränderter Graph-Reparse hashen die tatsächlich gelesenen Bytes erneut; Read-/Hashabweichungen enden mit `ANALYSIS_INCOMPLETE` ohne abgeschlossenen Korpusfingerprint; geänderte Dateien werden inklusive leerer Punktmenge per `file_id` vollständig ersetzt, sodass pensionierte Chunks/Symbole keinen erfolgreichen inkrementellen Abschluss überleben; eine bounded Registry bewahrt getrennte Workspace-/Repo-/Ref-/Embedding-Profil-Records mit generationsgebundenem Current-Pointer und Legacy-Lesefallback; ref-lose Suche setzt vor dem Store-Abruf lokal aufgezeichnete kanonische Ref-IDs und prüft den effektiven Scope danach erneut; explizite Multi-Repo-/Multi-Ref-Provenienz verlangt reale abgeschlossene Kontexte statt eines kartesischen Produkts und bindet jeden Kandidaten exakt an Repo, Ref und Generation; widersprüchliche aktuelle Embedding-Räume brechen `auto` sichtbar ab |

### Messmodell und Wahrheitsgrenzen

Der persistierte Retrieval-Funnel unterscheidet erhaltene Dense-, Sparse- und Symbolkandidaten,
eindeutige lesbare Kandidaten, zulässige Kandidaten nach Scope/Filtern, gerankte Kandidaten,
deduplizierte Primärtreffer, qualifizierte Treffer und tatsächlich ausgegebene Treffer. Je Versuch
bleiben Profil, Indexgeneration, Ranker-Version, Warnungen und Retrieval-Gesundheit sichtbar. Das
belegt explizite Abrufausfälle direkt und macht breite Codeverantwortung, schwaches Ranking oder
stark wechselnde Kandidaten als mögliche Einflussfaktoren untersuchbar. Agentenmodell, Harness,
vorheriger Kontext, Suchstrategie und Task-Mix bleiben in v1 externe, zu kontrollierende
Konfundierungen; der Funnel weist ihnen keine Ursache zu.

Der Abschluss liefert nur **ein** positives Target-Label. Daraus sind profil-lokaler Zielrang,
Reciprocal Rank, Score-Abstand und Suchaufwand ableitbar; die Relevanz aller übrigen Kandidaten ist
unbekannt. Welle 9 behauptet deshalb ausdrücklich keine Precision und keinen universellen
„Product-Complexity-Score“. Die Indikatoren und Caveats bleiben einzeln sichtbar.

Ein optionaler **Feature Probe** bindet mehrere Journeys über eine pseudonymisierte, vom Caller als
stabil deklarierte Feature-ID. Untangle prüft diese Deklaration nicht. Der Report stellt dann zwei
Achsen nebeneinander: Dynamic Search Complexity beschreibt
den beobachteten Weg; versionierte statische Metriken beschreiben den eindeutig zuordenbaren,
akzeptierten Code-Target. Embeddings bleiben Retrieval-Repräsentationen und sind selbst keine
Komplexitätsmessung. Fehlende oder mehrdeutige Target-Metriken bleiben explizit `unavailable`;
unterschiedliche Metrik-Scope-, Versions- und Indexgenerationsvarianten werden nie gemittelt.

### Zeitlose Kohorten ohne vermischte Messkontexte

Ein `measurementContextId` trennt Ranker-Versionen, textfreie Fingerprints der wirksamen
Suchmodus-/Ranking-/Relevanzkonfiguration, effektive Ergebnis-/Kandidatenlimits und in v2 die je
Profil erhaltene Verbindung aus Embedding-Profil, Indexgenerationen und dem unveränderlichen
`corpusRevisionFingerprint`. Nur abgeschlossene Journeys innerhalb desselben Kontexts werden
gemeinsam aggregiert; aktive und abgebrochene Sessions bleiben lediglich in den Sessionzählern.
Unversionierte Legacy-Kontexte bleiben sichtbar, werden im Report aber immer unvollständig und
können ebenso wie andere unvollständige Kohorten nie `sufficientEvidence: true` erreichen. Drei
bestätigte Ziele in einem vollständigen v2-Kontext sind die Mindestmenge dafür. Das ist keine
statistische Allgemeingültigkeitsbehauptung, sondern eine
harte Schutzgrenze gegen ein kohortiertes Produktsignal aus einer Einzelanekdote. Der v1-Report
besitzt keine Zeitachse und behauptet weder einen zeitlichen Trend noch eine Vorher-/Nachher-Ansicht.
Agentenmodell, Harness, vorheriger Kontext und Suchstrategie werden in v1 nicht erfasst. Vergleiche
benötigen deshalb extern kontrollierte Caller-Bedingungen und dürfen Unterschiede nicht allein dem
Produkt zuschreiben.

Die allgemeinen Kohorten bleiben als rückwärtskompatible Workspace-Arbeitslastsicht erhalten.
Feature-Mappings entstehen nur aus explizit getaggten Sessions und werden zusätzlich nach
Feature-Fingerprint getrennt. `sessionCounts.featureTaggedCompleted` muss der Summe aus
`featureMappings[*].search.completedSessionCount` entsprechen. Untangle errät keine
Feature-Zuordnung aus Legacy-Zielen oder Suchtexten und verifiziert die Caller-Deklaration nicht
semantisch. Der bestätigte Target schließt nur den Discovery-Loop; Change Event, Verifier,
strukturelles Vorher/Nachher und Feedback aus realer Nutzung bilden einen offenen späteren
Evidenz-Loop.

### Rückwärtskompatibilität

Die Aufzeichnung ist ausdrücklich und lokal. Ohne `untangle_search_session action=start` gibt es
keine Session; ohne `session`-Feld an `untangle_search` keine Beobachtung. Scheitert nur die
Persistenz, bleibt ein vorhandenes Suchergebnis verwendbar und meldet die ausgefallene Beobachtung
separat. Dadurch bleibt Untangle bereits während des Aufbaus dieser neuen Messdimension als Suche,
Graph- und Complexity-Werkzeug funktional.

### Verifikationsstand

Der gehärtete Welle-9-Abschluss lief über 24 pnpm-Workspace-Projekte; der rekursive
Build-/Test-Scope deckte 23/24 ab. Die vollständige Suite bestand mit **290 Testdateien und 3.121
Tests**; eine weitere Testdatei sowie vier Tests waren übersprungen. Davon lagen 3.111 Tests in den
Workspace-Paketen und 10 im Root-Skript-Scope. Die gezielten Paketstände lauten Domain **224**,
Search **410**, Storage Local **129**, CLI **341** und Website **11** Tests. Core **43** und Jobs
**104** decken zusätzlich die crash-sichere Generation-State-Übergabe. Build, Typecheck, Test,
Lint, Formatprüfung, E2E-Smoke, Lizenzprüfung, Publishability für 23 Pakete (20 öffentlich, 3
privat), `git diff --check` und der eingefrorene Offline-Installationslauf waren grün.

Die reale Probe verwendete den modernen MCP-Vertrag `2026-07-28`; der Server meldete **40** Tools,
davon **17** verfügbar. Ein vollständiger Qwen-/Qdrant-/AST-Reindex erzeugte Generation
`87e30a0e-977b-4c99-888b-76c7d728d9f2` aus 1.063 Dateien, 9.110 Chunks/Punkten, 13.005 Symbolen,
einem Dateigraphen mit 1.063 Knoten/3.703 Kanten und einem Symbolgraphen mit 8.758 Knoten/35.917
Kanten.

Search Journey `bc9440dc-03b5-4431-bac2-14f65c090996` fand
`buildDynamicProductComplexityReport` in `packages/search/src/product-complexity.ts` nach zwei
Suchen und einer Reformulierung auf profil-lokalem Rang 3. Der Lauf hatte keine fehlgeschlagene
Suche, 180 zulässige untersuchte Kandidaten, 17 eindeutige exponierte Kandidaten in 10 Dateien,
eine gemeldete Navigation und drei beobachtete Hops. Der damalige Messkontext war nach dem
Legacy-Vertrag vollständig; die Kohorte enthielt zunächst eine Journey.

Nach der finalen Härtung führte das neu gebaute Binary Journey
`4600bca3-c22e-49e7-9db1-938d87045d29` gegen dieselbe Generation aus. Zwei gesunde gekoppelte
Hybrid-Suchen fanden `assessSearchJourney` in derselben Datei auf Rang 1; der Vektor meldete 184
zulässige untersuchte Kandidaten, 20 eindeutige exponierte Kandidaten in 11 Dateien, eine
Reformulierung, eine Navigation und drei beobachtete Hops. Der moderne MCP-Readback bestätigte
danach 40 angebotene Tools, die abgeschlossene Session und leeres stderr. Die Kohorte enthält nun
zwei abgeschlossene Journeys und bleibt korrekt unter der Mindestmenge drei
`sufficientEvidence: false`. Das bestätigt den Guard, aber noch kein ausreichendes kohortiertes
Produktsignal. Beide gespeicherten Beobachtungen entstanden vor Messkontext v2 und seinem
unveränderlichen Korpusfingerprint. Sie bleiben als historische Workflow-Evidenz sichtbar, werden
vom gehärteten Report aber unabhängig von ihrer damaligen Einstufung als unvollständig und nie
ausreichend behandelt.

WP-253 wurde anschließend gegen Untangles eigenen aktualisierten Index ausgeführt. Der
inkrementelle Lauf verarbeitete 45 geänderte von 1.063 gefundenen Dateien, übernahm 1.018
unverändert und veröffentlichte für dieselbe fortgeführte Generation einen verifizierbaren
`completed`-State nach dem damaligen Vertrag. Die Collection enthielt danach 9.728 Punkte; der
Dateigraph 1.063 Knoten/3.715 Kanten und der Symbolgraph 8.936 Knoten/37.226 Kanten. Dieser
historische State trug noch keinen aus dem vollständigen Manifest abgeleiteten
`corpusRevisionFingerprint` und ist deshalb keine v2-Vergleichsevidenz.

Feature Probe `c0555839-69fd-4b72-89ba-784750d0152b` startete mit der vom Caller als stabil
deklarierten Feature-ID
`search.feature-to-code-mapping`. Die erste produktsprachliche Hybrid-Suche fand
`buildFeatureMapping` auf Rang 4; eine zweite, weiterhin hybride Reformulierung brachte dasselbe
Symbol auf Rang 1. Der vollständige Vektor meldete zwei Suchen, eine Reformulierung, 186 zulässige
untersuchte Kandidaten, 17 eindeutige exponierte Kandidaten in 11 Dateien, zwei beobachtete Hops,
gesunde Retrievalrate 1 und einen nach dem damaligen Legacy-Vertrag vollständigen Messkontext. Das
explizit bestätigte Target trug die angegebene Indexgeneration und `untangle-metrics-v1` mit
cyclomatic classic/extended **8/12**, cognitive **18** und SLOC **93**; `payloadComplete` war wahr.
`report.featureMappings` stellte Search- und Codeachse getrennt dar. Der Lauf bleibt ein Beleg für
diesen Feature→Code-Workflow, nicht für semantische Feature-Korrektheit oder v2-Korpusvergleich.
Unter dem gehärteten Vertrag bleibt seine Feature-Kohorte sichtbar, aber unabhängig von ihrer
Größe `sufficientEvidence: false`.

Eine vorausgehende Probe gegen den noch generationslosen Legacy-State fand zwar das richtige
Report-Symbol auf Rang 1 und las dessen Code-Metriken, wurde aber korrekt als unvollständiger
Messkontext markiert. Nach dem State-Update war dieselbe Strecke nach dem damaligen Vertrag gesund;
ohne Korpusfingerprint ist auch diese Aufzeichnung heute Legacy-Evidenz. Persistiert blieben weder
Goal-, Feature- noch Query-Rohtext; Target-Locator, Metrikprovenienz und die getrennten HMAC-
Fingerprints blieben als prüfbare Evidenz erhalten.

Bei `retainText: false` enthielt der persistierte Datensatz keinen Ziel-, Query- oder Quelltext; der
separate HMAC-Schlüssel hatte Modus `0600`; der POSIX-Persistenztest deckt denselben Modus für neue
Journey-Dateien. Da die realen Journeys keine fehlgeschlagene Suche und keinen Recorderausfall
erzeugten, stammen Failure-Reason-Redaktion und
`searchObservation.status: "not_recorded"` aus den grünen Vertrags- und Fehlertests, nicht aus einer
vorgetäuschten Live-Störung. Die Eigenmessung analysierte 836 Dateien und 13.126 Scopes:
Execution-Unit-Cognitive 18.121, Top-Level 29.073, self 15.919, Maximum 177; unter den
Welle-9-geänderten Hotspots lag `HybridSearchEngine.searchTarget` bei 148.

Die finale adversariale Härtung schließt mehrere Mess- und Zustandslücken: Ohne
`acceptedAttemptId` verschwinden
spätere Suchen nicht mehr aus dem Aufwand; ein partieller Provider-/Profilausfall und ein vollständig
fehlgeschlagener, aber gezählter Versuch können keinen vollständigen Messkontext mehr vortäuschen.
Treffer aus einer abgebrochenen, fehlgeschlagenen oder nicht verifizierbaren Indexgeneration bleiben
nutzbar, tragen aber `INDEX_CONTEXT_INCOMPLETE`; eine gekoppelte Journey wertet sie weder als gesundes
Retrieval noch als vollständigen Messkontext.
Ein neuer `completed`-State ist erst dann vergleichbare v2-Evidenz, wenn er den deterministisch aus
dem vollständigen bestätigten Datei-/Content-Manifest gebildeten, unveränderlichen
`corpusRevisionFingerprint` trägt. `running`, `cancelled` und `failed` publizieren ihn nicht; der
Search-Journey-Kontext erhält pro Profil die Verbindung aus Embedding-Profil, Generationen und
Korpusrevision statt drei unabhängiger Mengen.
Dasselbe gilt für wegen `missing_index_entry` verworfene Kandidaten und `INCOMPLETE_PAYLOAD`:
verwendbare Teilergebnisse bleiben erhalten, werden aber nicht zu positiver Produktevidenz.
Vor jeder Indexmutation wird ein dauerhafter `running`-Marker geschrieben; der terminale Zustand
folgt erst nach erneuerter Lock-Lease und einem finalen Besitznachweis. Ein nicht überlappender
Heartbeat erneuert lange Indexläufe spätestens nach einem Lease-Drittel; Besitzverlust bricht als
`LOCK_HELD` ab und unterdrückt den Terminal-Callback. Ein kurzer repo-weiter State-Publish-Lock und
Generation-CAS lassen den Abschluss nur den eigenen `running`-Marker ersetzen. Scheitert dessen
Persistenz, wird ein potenziell alter Hinweis nach Möglichkeit entfernt oder laut als
unverifizierbar gemeldet. Ein harter Abbruch oder konkurrierender Folgelauf kann dadurch keinen
veralteten `completed`-Zustand still als aktuelle Generation ausgeben.
Zusätzlich bleibt freier Abbruchtext hinter `retainText`; der textfreie `reasonCode` ist geschlossen
typisiert. Oversized Session-Dateien werden vor der Inhaltslesung fail-closed abgelehnt; neue
POSIX-Datensätze werden mit `0600` geschrieben. Abgebrochene oder fehlgeschlagene atomare Writes
räumen ihre exakten Temp-Pfade best-effort auf, ohne den primären Fehler zu verdecken.

Nach dieser Härtung bestätigte der frisch gebaute Indexer den vollständigen Workspace in einem
Zero-Change-Lauf: Job `8db2e89e-fa13-4840-9fd3-d4317e646129` sah 1.063 Dateien, übernahm alle 1.063
unverändert und veröffentlichte nur nach `completed` für Generation
`87e30a0e-977b-4c99-888b-76c7d728d9f2` den aus dem vollständigen Datei-/Content-Manifest
abgeleiteten Korpusfingerprint
`58c59fd0a4f6d9e4b3d9ea2a1637d89be576b906ab45ffcc4aab1274bca39117`. Dateigraph
1.063/3.716 und Symbolgraph 8.956/37.449 Knoten/Kanten wurden erneut bestätigt. Der daraus
profilgebunden normalisierte Suchkontext trug
`276069dfa72ebace0f7eab1fb3bf1a19a44601d68f9129ba4ad6bd6a6f4b7b9b`; damit bleibt die
Verbindung aus Embedding-Profil, Generation und Roh-Korpusrevision erhalten, statt drei
unabhängige Mengen zu hashen.

Drei danach gestartete v2-Feature-Probes
`0e60812d-05dc-4802-9012-943cc4580113`,
`948ab0f1-0b84-4d8b-8c98-03ef5b72dd3e` und
`ac82f79e-1711-4648-bfd0-20318e12823e` verwendeten drei unterschiedliche Ziele unter derselben
stabilen, standardmäßig nur als HMAC-Fingerprint gespeicherten Feature-ID. Alle Retrievals waren
gesund und bestätigten je ein echtes Symbol in `packages/search/src/product-complexity.ts`.
Messkontext `112ca29b73051e6ae5a084f18c858602e80a2437c199c2312bfd4154a02b0730` enthielt exakt drei
abgeschlossene Sessions, war vollständig und erreichte die bewusst kleine Schutzgrenze
`sufficientEvidence: true`. Die Suchachse meldete Median 1 und p90 2 Suchen, Median 0
Reformulierungen, Median-Target-Rang 4, MRR 0,333, Target-returned-rate 1, Direct-hit-rate 0,
Median 93 zulässige Kandidaten in 8 Dateien, Churn 0,889 und Candidate-limit-hit-rate 1. Die
Codeachse erhielt getrennt drei vollständige `untangle-metrics-v1`-Varianten: `buildFeatureMapping`
8/12 cyclomatic, cognitive 18, SLOC 93; `assessSearchJourney` 31/47, 55, 250; und
`SearchJourneyService.report` 1/1, 0, 8. Der Gesamtreport bilanzierte alle sechs historisch und
aktuell feature-getaggten Abschlüsse exakt über `featureTaggedCompleted: 6`; Legacy-Kohorten blieben
sichtbar unvollständig.

Diese kontrollierte Eigenprobe validiert Mechanik und Ehrlichkeitsgrenzen, nicht allgemeine
Produktqualität, Kausalität oder Precision. Alle drei caller-bestätigten Targets wurden ausgegeben;
fehlende Direct Hits, Rang 4 im Median und stets erreichte Kandidatenlimits zeigen zugleich
untersuchungswürdige Retrieval-Reibung. Trennschärfe bleibt ohne Labels für die übrigen Kandidaten
unbelegt. B39 bleibt offen, bis bestätigter
Target, tatsächliche Änderung, ausführbarer Verifier, strukturelles Vorher/Nachher und Feedback aus
realer Nutzung als getrennte Evidenzbahnen verbunden sind.

### Audit-Härtung nach der v2-Eigenprobe

WP-254 schließt vier danach gefundene Integritätslücken. Analyse und Graph-Reparse unveränderter
Dateien verifizieren nun die tatsächlich gelesenen Bytes gegen Discovery und Plan; ein Read- oder
Hashfehler endet als `ANALYSIS_INCOMPLETE` und kann keinen abgeschlossenen Korpusfingerprint
erzeugen. Die Persistenz geänderter Dateien ist ein vollständiger Replace nach `file_id`, sodass
alte Chunk- oder Symbolpunkte auch bei einer nun leeren Punktmenge nicht in einem erfolgreichen
inkrementellen Index verbleiben.

Eine Suche ohne Ref-Angabe erhält bereits vor dem Store-Abruf die lokal aufgezeichneten,
repo-qualifizierten kanonischen Ref-IDs ihres effektiven Repo-Scopes; Workspace, Repository und Ref
werden nach dem Abruf erneut geprüft. Explizite Multi-Repo-/Multi-Ref-Evidenz prüft reale
abgeschlossene Kontexte statt eines künstlichen kartesischen Produkts und verlangt für jeden
zurückgegebenen Kandidaten den exakten Repo-/Ref-/Generationskontext. Gezielte Regressionstests
decken diese Invarianten ab.

### Finaler Self-Index und Feature-Probe nach dem Integritätsaudit

Der abschließende vollständige Lauf `7dc80be4-acdf-4b9d-9b18-1ec216efb64c` verarbeitete 1.065
Dateien, analysierte 1.064 davon neu und veröffentlichte 9.388 Chunks/Punkte sowie 13.560 Symbole.
Der Dateigraph enthielt 1.065 Knoten/3.730 Kanten, der Symbolgraph 9.162/38.752. Generation
`87e30a0e-977b-4c99-888b-76c7d728d9f2` blieb stabil; der neue vollständige Korpusfingerprint lautet
`5534b0a0735249b0ade52cacc04807583d46b25decab468e3f87a9a16b51c791`.

Drei echte MCP-Journeys fanden `buildFeatureMapping`, `assessSearchJourney` und
`SearchJourneyService.report` jeweils im ersten Hybrid-Suchlauf auf den Rängen 3, 1 und 3. Alle
drei gehörten zum vollständigen Messkontext
`f11d160875cb9dc6f4c5bdc50195a1c51f418e19a713cfae40430aa19d35ece8`. Die Feature-Kohorte
erreichte mit exakt drei Abschlüssen `sufficientEvidence: true`; Median/p90 Suchen 1/1,
Median-Rang 3, MRR 0,556, Target-returned-rate 1, Direct-hit-rate 0,333, Median 84 zulässige
Kandidaten in 13 Dateien und Candidate-limit-hit-rate 1. Die getrennte Codeachse band alle drei
bestätigten Ziele an vollständige `untangle-metrics-v1`-Evidenz: cyclomatic classic/extended,
cognitive und SLOC 8/12, 18, 93; 31/47, 55, 250; sowie 1/1, 0, 8. Der moderne MCP-Server bot 40
Tools an und blieb auf stderr still.

Die Probe belegt die lauffähige Feature→Code-Messmechanik unter dem final gehärteten Indexzustand.
Sie belegt keine allgemeine Precision oder Produktqualität: Ränge 3/1/3, nur ein Direct Hit und
das in allen drei Läufen erreichte Kandidatenlimit zeigen konkret, wo Retrieval weiter geschärft
werden kann. B39 bleibt offen, bis Change Event, ausführbarer Verifier, strukturelles
Vorher/Nachher und Feedback aus realer Nutzung als getrennte Evidenzbahnen verbunden sind.

---

## Nachtrag Welle 10 — B29: Lizenz-Gate und Digest-Pin an der Grenze, nicht in der Reihenfolge (2026-09-07)

B29 verspricht für jede Extension ein Lizenz-Gate, einen vollständig gepinnten Image-Digest, kein
Vendoring und einen Aufruf ausschließlich über eine Prozess- oder HTTP-Grenze. Gebaut waren die
drei Mechanismen bereits: `evaluateLicenseGate` mit getrenntem Werkzeug- und Regelsatz-Gate,
`DIGEST_PATTERN` in der Manifestvalidierung, `EXTENSION_IMAGE_MISMATCH` beim Lauf, `spawn` und
`fetch` als einzige Auswege aus dem Paket. Die Durchsicht für diese Welle fand trotzdem vier
Stellen, an denen das Versprechen weiter reichte als der Code.

| ID | Artefakt | Zweck | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|
| WP-255 | `packages/extension-runtime/src/runtime.ts` | **Das Gate stand vor dem Lauf, nicht vor der Probe.** `detectExtension` startet für `binary` die Versionsabfrage und spricht für `http` den Endpunkt an — beides ist ein Zugriff auf das fremde Werkzeug. Der Gate-Status kam nur als Anzeigewert herein („wird nur ANGEZEIGT, detect startet nichts"), die Regel lebte allein in der Reihenfolge von `runRun`. Jeder weitere Aufrufer — `status`, das MCP-Tool, ein Job — hätte X5 neu brechen können. Das Gate steht jetzt in `detectExtension` selbst. | WP-67 | S | `detect` mit Gate `unacknowledged`/`revoked` ruft weder Prozess- noch HTTP-Port auf, liefert `available: false` und je Aufrufmodus einen Grund, der das Gate nennt; mit `acknowledged`/`not_required` prüft es unverändert weiter |
| WP-256 | `apps/cli/src/commands/extensions/status.ts` | **`untangle extensions status [<id>]` fehlte vollständig**, obwohl `extensions.md` §11.1 und §20.2 es führen und WP-71 es als Akzeptanzkriterium nennt. Damit war der gepinnte Digest nirgends einsehbar, ohne einen Lauf auszulösen: eine Zusicherung, die niemand ansehen kann, ist schwer zu glauben und leicht unbemerkt zu brechen. Zeigt gepinntes Image und Digest, laufenden Digest samt Abgleich, Werkzeug- und Regelsatz-Gate mit Bestätigungsbefehl, Endpunkt, Binary, Werkzeugversion, fehlende Pflicht-Secrets (nur Namen) und den letzten Lauf. | WP-67, WP-127 | M | `status` startet keinen Container und zieht kein Image; bei offenem Gate findet keine Probe statt; ein unbekannter Name endet mit Begründung statt leerem Bericht; ein nicht auslesbarer laufender Digest wird als „unknown" mit Grund geführt, nie als „—" |
| WP-257 | `packages/extension-runtime/src/manifest/shape.ts` | **`image.includes(":")` traf daneben.** Ein Tag wurde erkannt, aber `registry.example.invalid:5000/vendor/analyzer` — die naheliegendste Form in einem abgeschotteten Netz — ebenfalls abgelehnt, mit der Begründung „image must be the repository name without a tag", obwohl gar kein Tag vorhanden war. Eine falsche Begründung ist teurer als eine strenge Regel. Die Referenz wird jetzt zerlegt: Registryteil abtrennen, dann im Rest nach Tag und eingebettetem `@sha256:` suchen. | WP-67 | S | Repositoryname und Registry mit Port werden angenommen; Tag, Tag hinter Registry-Port und eingebetteter Digest werden mit je eigener, zutreffender Begründung abgelehnt |
| WP-258 | `apps/cli/src/commands/extensions/state.ts`, `enable.ts` | **Der Gate-Status `revoked` war unerreichbar.** `extensions.md` §9.3 verlangte im selben Satz, den Eintrag zu *entfernen* und den Status `revoked` anzuzeigen — beides zusammen ist nicht erfüllbar. `disable --revoke-license` stempelt den Eintrag jetzt mit `revokedAt`, statt ihn zu löschen. Für die Sicherheit ändert das nichts, beide Formen verweigern den Lauf; es ändert, was danach gesagt werden kann: „nie bestätigt" und „bestätigt und zurückgenommen" sind verschiedene Tatsachen. `remove` löscht weiterhin. | WP-127 | S | Nach `disable --revoke-license` meldet das Gate `revoked` mit Zeitpunkt und Bestätigungsbefehl, `allowed: false`, und `detect` probt weiterhin nichts; `remove` entfernt die Zeile |
| WP-259 | `packages/extension-runtime/src/boundary.test.ts` | **„Kein Vendoring" war eine Aussage, die jemand von Hand nachgesehen hat.** Eine Namensliste scheidet aus: E2 verbietet fremde Produktnamen im Quellbaum, eine Suche danach müsste sie hineinschreiben. Geprüft wird deshalb die *Form* der Grenze — ohne einen einzigen fremden Namen. | WP-67 | S | Das Paket liefert keine Werkzeugdefinition aus (`fixtures` nicht in `files`); die Laufzeitabhängigkeiten sind genau `@untangle-code/domain`, `fast-xml-parser`, `smol-toml`, ohne Peer-Dependency; `node:child_process` steht in genau einer Datei; kein Produktivmodul zieht sich selbst eine Verbindung über `node:http`/`https`/`net` |

### Korrekturen an `extensions.md`

Drei Stellen der Spezifikation waren gegen sich selbst oder gegen das gebaute Binary gerichtet und
sind korrigiert, jeweils mit Begründung im Dokument:

- **§9.3** verlangte Löschen und Status `revoked` zugleich. Neu: entwerten statt löschen.
- **§11.1 Exit Codes** nannte `2` für Infrastrukturfehler und berief sich auf `spec.md` §18.3.
  §18.3 gilt für **Quality Gates**; die gebaute CLI belegt `2` mit Aufruffehlern und meldet ein
  offenes Lizenz-Gate als `4` (Umgebung nicht bereit). Nachgemessen am Binary.
- **§6.1 detect** und **X6** halten jetzt fest, was WP-255 und WP-257 durchsetzen.

### Verifikation gegen das gebaute Binary

Temporäres Profil, kein Container, kein Netz, drei reale Manifeste:

| Schritt | Erwartung | Ergebnis |
|---|---|---|
| `add` mit `digest = "latest"` | abgelehnt (X6) | Exit 1, `container.digest: image must be pinned to a complete sha256 digest (X6)` |
| `add` mit Registry auf Port 5000 | angenommen | Exit 0 |
| `run` bei offenem Gate | nichts startet | Exit 4, `EXTENSION_LICENSE_UNACKNOWLEDGED` |
| `status` bei offenem Gate | Pin sichtbar, keine Probe | Digest angezeigt, `available: false`, Grund nennt das Gate |
| `enable --acknowledge-license` | persönliche Erklärung im Nutzerprofil | Exit 0, Datei im OS-Datenverzeichnis, nichts im Projekt |
| `status` nach Bestätigung | Gate `acknowledged` | Grund wechselt zur fehlenden Container-Sonde |
| `disable --revoke-license` | Gate `revoked` | Zeitpunkt und Bestätigungsbefehl ausgewiesen |
| `run` nach Widerruf | nichts startet | Exit 4 |
| `status --format=json` | stderr leer | 0 Bytes |

Nicht belegt und ausdrücklich offen: es läuft weiterhin **keine** Container-Extension. Ohne
Container-Runtime-Sonde bleibt der laufende Digest unbekannt, und der Abgleich gegen den Pin ist
durch Vertrags- und Fehlertests gedeckt, nicht durch einen echten Pull. Der Digest-Pin ist damit
als Validierungs-, Anzeige- und Verweigerungsregel verifiziert, nicht als durchlaufener
Container-Lebenszyklus. WP-68 bis WP-72 bleiben unverändert offen.

---

## Nachtrag Welle 11 — B26/B28: Komplexitätssignale fremder Werkzeuge (2026-09-07)

Der Auftrag lautete, für dieses Repository einen Monitoring-Lauf einzurichten, der Komplexität
zusammen mit zwei externen Werkzeugen beobachtet — und zwar als **eine schlanke, generische
Signal-Bahn**, nicht als ein Adapter je Werkzeug. Genau das ist auch die einzige Bauform, die X9
erlaubt: Untangle kennt Ausgabeformate und Bedeutungen, nicht Produkte.

Die Bestandsaufnahme fand fünf Stellen, an denen die vorhandene Bahn nicht trug.

| ID | Artefakt | Zweck | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|
| WP-260 | `packages/extension-runtime/src/formats/generic-metrics.ts` | **Die häufigste Ausgabeform wurde nicht gelesen.** `generic-metrics` kannte nur Eintragslisten. Ein Werkzeug, das eine Handvoll repo-weiter Zahlen als flaches Objekt schreibt — `{"quality_signal":0.45,"cycle_count":3}` —, ergab NULL Messwerte und einen Hinweis. Neu: `shape = "flat-object"`, deklariert und nie geraten, denn dasselbe Objekt kann ebenso ein einzelner Eintrag sein. | WP-108 | S | Zehn Zahlen ergeben zehn Messwerte; jeder nicht-numerische Schlüssel wird genannt statt verschluckt; die Ausgabe ist nach Schlüssel sortiert, damit zwei Läufe vergleichbar sind |
| WP-261 | `packages/extension-runtime/src/formats/json-lines.ts` | **Eine Web-API liefert die Liste verschachtelt** (`component.measures`), nicht auf oberster Ebene. Neu: deklarierter `container`-Punktpfad. Ein Pfad, der ins Leere zeigt, ist ein Befund — „dort steht nichts" und „dort steht keine Liste" sind verschiedene Aussagen. | WP-108 | S | Die Liste wird unter dem Pfad gefunden; ein toter Pfad erzeugt einen begründeten Befund statt eines leeren Ergebnisses |
| WP-262 | `packages/domain/src/types/extensions.ts` | **Der Kern der Welle: eine fremde Zahl trägt jetzt ihre Bedeutung.** `[[complexitySignals]]` gibt einem Ausgabeschlüssel ein `kind` aus geschlossener Menge und einen `scope`. `comparableTo` ist die einzige Tür zu einer Gegenprobe nach X8 — und für `proprietary-composite` verschlossen, erzwungen durch die Validierung. Ohne diesen Vertrag sehen `quality_signal = 0,45` und `cognitive_complexity = 4284` im System gleich aus, obwohl nur die zweite Größe etwas ist, das Untangle selbst berechnet. | WP-01 | M | Ein Mischwert mit `comparableTo` wird abgelehnt, mit Begründung; unbekanntes `kind`/`scope` wird abgelehnt; zwei Bedeutungen für denselben Schlüssel werden abgelehnt |
| WP-263 | `packages/extension-runtime/src/manifest/shape.ts`, `runtime.ts`, `normalize.ts` | **Die Lesehilfe war von keinem Manifest aus erreichbar.** `formatOptions` existierte nur als Parameter für Aufrufer aus dem Quelltext; ein Manifest konnte seine eigene Ausgabeform nicht beschreiben — genau die Werkzeugkenntnis, die X9 aus dem Quelltext heraushalten will, hatte also keinen anderen Ort. Neu: `[outputMapping]` im Manifest, `formatOptionsFromManifest`, und die Bedeutung wandert bis an `ExternalMeasurementV1.signal`. | WP-260–WP-262 | M | Ein Manifest allein genügt, um eine flache oder verschachtelte Ausgabe zu lesen und zu benennen; ein datei-/symbolbezogen deklarierter Wert ohne Pfad bekommt die Bedeutung NICHT und wird vermerkt |
| WP-264 | `packages/extension-runtime/src/runtime.ts`, `apps/cli/.../run.ts`, `status.ts` | **`authSecretName` war ein Feld ohne Wirkung.** Das Manifest durfte ein Zugangsgeheimnis benennen, die HTTP-Grenze kann Header senden — nur verband die beiden nichts. Eine Extension gegen eine tokengeschützte API ging unauthentifiziert hinaus, und der 401 nannte die Ursache nicht. `extensions.md` liess das Schema offen; es ist jetzt festgelegt: `Authorization: Bearer <wert>`. | WP-67 | S | Der Header steht an Probe und Lauf; ein fehlendes Geheimnis erzeugt keinen leeren Bearer; ein Verweis auf ein nicht deklariertes Secret wird abgelehnt; das Token erscheint in keiner Meldung |

### Verifikation gegen echte Werkzeuge

Beide Manifeste liegen **außerhalb** des Repositories im Nutzerprofil (X9). Der Lauf des lokal
installierten Strukturanalysators gegen dieses Repository lief über das gebaute Binary durch:
Exit 0, zehn Messwerte, davon fünf mit deklarierter Bedeutung. Zwei Größen sind für die
Gegenprobe geöffnet (`dependency-cycles` 3, `dependency-depth` 28), zwei herstellereigene
Mischwerte bleiben ausdrücklich unvergleichbar, fünf Schlüssel ohne Deklaration bleiben namenlos
erhalten. Jeder Wert trägt `evidenceOnly: true` und den `externalMeasurement`-Marker; keiner
passt strukturell an eine Untangle-Metrikstelle (X3).

Die Qualitätsplattform war im Profil noch auf dem **Entwurfsschema** hinterlegt
(`adapterVersion`, `[invocation] mode = …`, `[output] format = "…-webapi"`) und wurde seit der
Festlegung von `extensions-v1` mit Begründung abgelehnt — der Monitoring-Lauf, den
`docs/SONAR.md` beschreibt, war also seit Monaten still ausser Betrieb. Das neue Manifest ist
gültig; das Lizenz-Gate greift nachweislich, nennt den Bestätigungsbefehl und das fehlende
Token, und der Endpunkt wird bei offenem Gate nicht einmal probeweise angesprochen.

### Ausdrücklich offen

- **Die Gegenprobe selbst (X8, B28).** `comparableTo` sagt, welche Werte verglichen werden
  *dürfen*. Der Vergleich gegen `packages/complexity` und die Graphen und die Meldung einer
  systematischen Abweichung als Testbefund sind nicht gebaut. B28 bleibt `offen`.
- **B26** verlangt die Verbindung fremder Befunde mit Symbol, Graph, Blast Radius und Historie.
  Gemessen wurden bisher repo-weite Größen; die Symbolzuordnung trägt der Vertrag, geliefert hat
  sie noch kein Lauf. B26 bleibt `offen`.
- **B27/WP-72** (`--finding`, `--severity` als Payloadfilter im Store) ist unberührt.
- **Der Live-Beleg der Qualitätsplattform** steht aus; er verlangt eine laufende Instanz.
- **Die Container-Sonde (WP-67)** fehlt weiterhin; damit bleibt der Digest-Abgleich aus B29
  Vertragsevidenz.

---

## Nachtrag Welle 12 — Untangle stellt den Dienst selbst bereit (2026-09-08)

Der Auftrag war, den Monitoring-Dienst **von Untangle aus** hochzuziehen statt nebenher per
Skript — er ist schliesslich eine Extension. Damit fiel die letzte offene Zusicherung aus B29:
bis hierher war der Digest-Pin Validierungs-, Anzeige- und Verweigerungsregel, aber nie gegen
einen echten laufenden Container geprueft, weil kein Container je lief.

| ID | Artefakt | Zweck | Deps | Größe | Akzeptanzkriterien (prüfbar) |
|---|---|---|---|---|---|
| WP-265 | `packages/extension-runtime/src/container/compose.ts` | **Die Bereitstellung wird aus dem Manifest gerendert, nicht aus einer mitgebrachten Datei ausgefuehrt.** Die im Profil liegende Fassung nannte `image: <repo>:community` — ein wanderndes Tag; der Digest im Manifest haette damit nichts gepinnt. Ebenso wenig sieht man einer fremden YAML an, ob sie an Loopback bindet, die Labels setzt oder privilegiert startet. | WP-01 | M | `image@digest` statt Tag; jede Portbindung an `127.0.0.1`; beide Labels; Volumes praefixiert; `privileged: false`, `cap_drop: ALL`, `no-new-privileges`; bytegleich bei gleicher Eingabe |
| WP-266 | `packages/extension-runtime/src/container/types.ts`, `apps/cli/.../container.ts` | Container-Grenze als Port plus Adapter ueber ein Compose-faehiges Kommando des Nutzers (`UNTANGLE_CONTAINER_CLI`, Vorgabe `docker`). **Die Besitzprobe ist der tragende Teil:** `up`, `down` und `logs` verlangen BEIDE Labels, bevor sie etwas anfassen. Der Name `untangle-ext-<id>` ist vorhersagbar, und auf dieser Maschine laufen zwölf fremde Container. | WP-265 | M | Ein Container gleichen Namens ohne Labels gilt als fremd; `down`/`logs`/`up` setzen dann KEINEN compose-Aufruf ab; `--volumes` nur auf ausdrueckliche Anweisung |
| WP-267 | `apps/cli/.../provision.ts` | Lebenszyklus `render → up → healthcheck`. Auf die Gesundheit wartet Untangle selbst ueber den Healthcheck des Manifests, statt einen in den Container zu rendern — ein Healthcheck im Container muesste voraussetzen, welches Programm darin liegt (X9). Ein bereits laufender eigener Container wird nicht neu gestartet. | WP-266 | M | Ohne `--yes` startet nichts und die Ressourcenkosten stehen da (X1); ein Dienst, der nie antwortet, endet mit Grund statt mit Warten |
| WP-268 | `apps/cli/.../status.ts`, `run.ts` | **Der Digest gehoert zur Extension, nicht zum Aufrufmodus.** Bei `invocation = ["http"]` betritt `detect` den Container-Zweig nie; der Pin blieb ungeprueft, obwohl genau dieser Container lief — X6 waere fuer die haeufigste Betriebsart eines Dienstes wirkungslos geblieben. | WP-266 | S | `status` zeigt laufenden Digest und Abgleich unabhaengig vom Aufrufmodus; ein abweichender Pin beendet den Lauf mit `EXTENSION_IMAGE_MISMATCH`, bevor gemessen wird |
| WP-269 | `apps/cli/.../logs.ts`, `enable.ts` | `untangle extensions logs <id>` und `disable --remove-container [--remove-volumes]` — beide in `extensions.md` §11.1 gefuehrt und beide nicht vorhanden. **Nebenbefund dabei:** die Flag-Pruefung von `disable` lag NACH dem Schreiben des Zustands; ein Aufruf, den die CLI im selben Atemzug als Aufruffehler zurueckwies, hatte die Extension bereits deaktiviert. Ein abgelehnter Befehl darf nichts getan haben. | WP-266 | S | Logs nur fuer den eigenen Container; `--remove-volumes` nur mit `--remove-container`; ein zurueckgewiesener Aufruf laesst den Zustand unveraendert |

### Verifikation gegen den echten Dienst

`untangle extensions run sonarqube --yes` hat den Dienst selbst bereitgestellt: Runtime erkannt,
Compose-Datei aus dem Manifest gerendert, `up` ausgefuehrt, Healthcheck nach zehn Versuchen mit
200 beantwortet. Anschliessend las die Extension ueber die Measures-API fuenf Kennzahlen mit
Bedeutung — cognitive 13.640, cyclomatic 23.143, ncloc 133.759, Duplikate 1,6 %.

Beide Haelften von X6 sind damit erstmals real belegt: bei passendem Pin meldet `status`
`matches the pin`, bei manipuliertem Pin `DIFFERS from the pin`, und `run` endet mit
`EXTENSION_IMAGE_MISMATCH`, bevor gemessen wird. Die Telemetrie ist im laufenden Container
tatsaechlich abgeschaltet (`SONAR_TELEMETRY_ENABLE=false`). Die zwoelf fremden Container auf
dieser Maschine blieben unberuehrt; ihre Laufzeiten sind unveraendert.

### Ausdrücklich offen

- **Der Vergleich der beiden Achsen (WP-70, B28).** Beide Zahlen sind jetzt maschinenlesbar, und
  gerade deshalb steht hier kein Delta: die eigene Messung umfasst 856 Dateien, der externe Lauf
  einen anderen Ausschnitt, und „execution unit" ist nicht dieselbe Lesart wie die Summe je
  Funktion. `comparableTo` sagt, dass ein Vergleich der ART nach zulaessig ist, nicht dass dieser
  Lauf gegen jenen gehalten werden darf. Korpusangleichung zuerst.
- **Der Scan-Ausloeser.** Untangle stellt den Dienst bereit und liest die Messwerte; den Scan,
  der sie erzeugt, stoesst es noch nicht an. Das waere eine zweite Extension mit
  `invocation = ["container"]` und `analyzeArgs` — die Container-Grenze dafuer steht jetzt.
- **B26** verlangt weiterhin den Symbolbezug; gemessen wurden repo-weite Groessen.


## Abschluss `untangle scan` — 2026-09-10

Die unterbrochene Sitzung ist abgeschlossen: `scan` ist registriert, dokumentiert
und verwendet den extrahierten gemeinsamen Extension-Ausführungspfad. Scan-weites
`--yes` zeigt Kosten vor Bereitstellung; eigene Metriken, externe Evidenz und
begründete Ausfälle bleiben getrennt. Ausfälle stoppen nachfolgende Extensions
nicht; Lizenz-Gate, Digest-Pin, Regelsatz, Abbruch und Provenienz bleiben erhalten.

Die Domain verweigert `comparableTo` für nicht produzierte `(kind, scope)`-Paare
oder unbekannte Metrikversionen. Repo-weites SLOC ist damit ausgeschlossen,
Zyklen und Tiefe bleiben vorhanden. Die bestätigte Doppelzählung verschachtelter
Funktionen in den CLI-Summen ist durch die vorhandene `execution_unit`-Aggregation
behoben; Einzelwerte und Hotspot-Gates bleiben gleich. Alte Summen benötigen eine
neue Baseline.

**3.246 Tests bestanden, 4 übersprungen**, alle Projektprüfungen einschließlich
E2E-Smoke grün. Live: zehn Sentrux-Messwerte; SonarQube gesund, Messung mangels
`SONAR_TOKEN` begründet ausgelassen. Details und Grenzen: [SCAN.md](SCAN.md).
B26/B28 bleiben wegen fehlender Symbol-Gegenprobe weiterhin offen; `scan` behauptet
deren Erledigung nicht.

### Nachtrag: automatische Zugangsdaten — 2026-09-10

`extensions setup <id> --yes`, `extensions run --yes` und `scan --yes` verwenden
einen gemeinsamen Zugangspfad. Ein externer `[setup]`-Provider erzeugt fehlende
Secrets erst hinter Lizenz-Gate, Zustimmung, Besitz-, Digest- und Healthprüfung.
Die Runtime speichert sie atomar im privaten Nutzerprofil, an den Endpunkt
gebunden, und verwendet sie erneut. `extensions configure <id>` stellt eine
private Konfigurationsdatei bereit; `--from` importiert Secret-Werte aus JSON,
nicht aus Prozessargumenten. Nichtleere Env-Werte haben Vorrang. Bootstrap-Secrets
mit `setupOnly` erreichen ausschließlich den Setup-Prozess. Status bleibt lesend;
Provider-Fehler und Logs geben keine Zugangsdaten aus.

Der SonarQube-Provider bleibt externes Nutzerdatum gemäß X9. Er hat auf der
vorhandenen Instanz erfolgreich einen Admin-Usertoken erzeugt und fünf Messwerte
abgerufen. Die Aussage „read-only Token" in der früheren Betriebsanleitung wurde
korrigiert. Der fehlende Scan-Auslöser und B26/B28 bleiben unverändert offen.

Abnahme: **3.263 Tests bestanden, 4 übersprungen** (`vitest run --maxWorkers=2`),
zusätzlich sieben Tests des externen Providers. Build, Typecheck, Format,
Lizenzprüfung, Publishability und E2E-Smoke bestanden; Lint ohne Fehler bei
14 bestehenden Warnungen. Die Status-Testumgebung verwendet jetzt ausdrücklich
keinen echten Container-Daemon. Ein zeitabhängiger Lease-Test bestand nach einem
Ausfall im stark parallelen Erstlauf isoliert und im vollständigen Abschlusslauf.
Live lieferte `scan --yes` zehn Sentrux- und fünf SonarQube-Messwerte, ohne die
gespeicherte Token-Datei erneut zu schreiben oder Zugangsdaten auszugeben.
