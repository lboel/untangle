# Untangle — Vision

**Status:** Draft 0.1  
**Product name:** Untangle  
**Working tagline:** *Keep spec-driven code easy to change.*  
**Document language:** English.  
**Scope:** This document describes the long-term product vision. Binding requirements are in [`spec.md`](./spec.md), and technical implementation is described in [`architecture.md`](./architecture.md).

---

<a id="1-vision-in-einem-satz"></a>

## 1. Vision in one sentence

**Untangle will be the local search and complexity harness for Spec Driven Development and Agentic Engineering: teams and coding agents should be able to translate specifications into traceable features and keep their implementation understandable and maintainable over time.**

Untangle connects declared product intent and feature responsibility with semantic and lexical
search, AST-based structure, file and symbol graphs, cross-repository impact analysis, complexity
metrics and historical change data. Its goal is a traceable answer to six questions:

1. **Which declared requirement, feature boundary and responsibility belongs to the task?**
2. **Where is the relevant logic?**
3. **How does it relate to the rest of the system?**
4. **What will a change affect?**
5. **Is the feature implementation becoming easier or harder to maintain?**
6. **How much search and navigation work lies between product intent and its target?**

---

<a id="1a-produktdefinition--was-untangle-konkret-ist"></a>

## 1a. Product definition — what Untangle is

**Untangle is a local search and complexity harness for spec-driven, agentic software development.**

Its technical core is a complexity-aware RAG code search system for project landscapes.

It searches code semantically and lexically, but unlike a pure search engine, the target product
considers six dimensions:

1. **Structure.** AST boundaries, symbols, signatures, file and symbol graphs. A hit is a symbol
   with its definition, callers and callees, not a text window.
2. **Landscape.** A workspace contains repositories; a repository contains **projects**. Monorepos
   contain meaningfully linked subprojects (`workspace:*`, path dependencies, project references,
   Compose services); shared and dependent repositories connect through the same package identity
   rather than being indexed in isolation.
3. **Time.** Untangle stores not just the current state but what changed: which symbol, in which
   file, on which line, with what effect.
4. **Complexity.** Every symbol carries cyclomatic, cognitive, Halstead, structural, textual and
   syntactic metrics—and their **delta** with every change.
5. **Search path.** An explicitly recorded agent task connects multiple real search attempts,
   retrieval candidates and navigation steps to a confirmed target. This reveals the work between
   product intent and code.
6. **Feature responsibility.** A declared feature map connects vision and specification to complete
   code/test scopes, acceptance criteria and owners. Complexity becomes visible at this domain
   boundary; shared implementation and missing evidence remain identifiable.

This yields a capability a search engine alone cannot structurally provide:

> **Untangle understands what changes over time—and exactly where a change removed or added complexity.**

Search and complexity form **one** query layer, rather than two tools. This enables requests that
grep, vector search or a linter alone cannot answer:

```text
untangle query "token rotation" --cognitive-min 15 --changed-since 30d --project backend
untangle query "retry logic" --impacts PaymentService.charge --in-cycle
untangle query "what made authentication more complex last month?"
```

<a id="ergänzung-zu-spec-driven-development"></a>

### Complementing Spec Driven Development

Specs record desired behavior and acceptance criteria. Untangle should maintain their connection
to actual implementation within an existing agent workflow:

```text
Vision / Spec → declared features → code and tests → Ownership
```

Before a change, search and graphs help locate the affected responsibility. The feature report
shows complete declared scope, complexity budgets, test evidence and open assignments. Explicitly
recorded Search Journeys add observations of the difficulty agents face between an assignment
and a confirmed implementation location. Teams can investigate whether terminology, documentation
or feature boundaries need refinement.

These local search, reporting and recording paths are built through CLI and MCP. Assignment is
declared and structurally checked; domain spec conformance and ownership are not automatically
confirmed. The complete autonomous change, comparison and simplification loop remains a
development goal. The long-term rule is: **each feature should carry only the complexity its
desired behavior actually needs.**

<a id="branch--und-worktree-bewusstsein"></a>

### Branch and worktree awareness

A repository rarely has exactly one state. People, and especially agents, work concurrently in
multiple branches and **git worktrees** of the same repository. Untangle treats this as normal:

- `repo_id` identifies the repository; `ref_id` identifies the branch/commit/snapshot. A worktree
  creates **no second** `repo_id`, but another `ref_id`;
- Multiple worktrees of the same repository share embedding cache and package identity and do
  not generate duplicate embedding costs for unchanged files;
- Search can be scoped to one ref or intentionally span several refs, with each result naming its ref;
- Change and complexity analysis compares any two refs, even when checked out in different worktrees.

<a id="für-agents"></a>

### For agents

A coding agent should obtain dependable context in a few calls: search first, then read. Results
are token-light by default—no source bodies unless requested—carry provenance (repository,
project, ref, file, lines, symbol) and score components, and honestly state index freshness and
what indexing skipped.

---

<a id="1b-die-kernthese-komplexität-aufwickeln-wege-verkürzen"></a>

## 1b. The core thesis: untangle complexity, shorten paths

<a id="gebauter-erster-schritt-produktkontext-sichtbar-machen"></a>

### First implemented step: expose product context

`untangle init` captures v1 candidates for vision, specification and product descriptions with
local source paths, content hashes, headings and document references. `--vision` and `--spec`
allow explicit selection relative to the project directory. Missing, ambiguous and incompletely
assessed sources remain visible; the review draft contains open questions and initially empty
feature and ownership lists. This works without an LLM or embeddings and creates no new product
documents. Assessment limits lines to 16,384 UTF-16 code units, opening square brackets to 4,096
and heading candidates to 2,048 per document. Exceeded parse limits remain visible with hashes
and `not_assessed` as incomplete findings.

This entry point creates a traceable documentary foundation. Domain alignment remains
`unverified`, even with completely selected documents. Paths, hashes and headings establish
existing sources; they confirm neither feature identity, ownership nor code conformance. Those
confirmed assignments and behavioral evidence are still needed before "the same functionality
with less complexity" can be evaluated dependably. The complete v1 contract is in
[`spec.md`](./spec.md#2021-lokaler-produktkontext-beim-init-v1).

Untangle measures complexity in order to **untangle** it, rather than merely report it.

<a id="die-qualitätsaussage"></a>

### The quality claim

> **Achieving the same functionality with less complexity—structural, semantic, cyclomatic,
> cognitive—produces better code.**

This is not a style preference. Complexity is the price paid by every subsequent change: more
paths to understand, more places where assumptions may break, and more context people and agents
must load before starting. A reduction with the same behavior is a real gain, not a cosmetic one.

**For the claim to remain testable, "the same functionality" must be operationally defined.**
Untangle counts reduced complexity as an improvement only when:

- The **public symbol surface** is unchanged (signatures, exports, visibility), measurable through
  the symbol graph;
- **Test results** are unchanged: passing before and after, the same count, no removed or skipped tests;
- **Dependency edges** have not expanded: no new imports, no new cycles.

Untangle can measure the first two and derive the third from the graph. It explicitly states what
it **cannot** do: static analysis cannot prove identical observable runtime behavior. Reduced
complexity is therefore **strong evidence**, not proof, and is never presented as proof.

<a id="die-ratsche"></a>

### The ratchet

This establishes the operating rule Untangle enforces:

- Complexity must **not increase** with unchanged functionality (delta-first, `spec.md` §18.1:
  existing debt does not block adoption; regressions do);
- A change that **reduces** complexity without changing surface, tests or edges is explicitly
  **reported as an improvement**, rather than silently accepted;
- Regressions identify their **contribution sites**—line, construct, nesting contribution—showing
  *where* the cost arises, not merely *that* it increased.

<a id="der-zweite-hebel-wegkürze"></a>

### The second lever: shorter paths

Complexity is one half. The other is **how far one must travel to reach the right location**.

> **A shorter route to the relevant location—even in large, intertwined projects—produces a
> better result for people and agents.**

Untangle makes this **measurable**, rather than merely claiming it:

- **Path length** = the number of Untangle calls plus files opened afterward until reaching the
  ground-truth location;
- Measured against fixture-suite ground-truth questions (`spec.md` §27.3), making it reproducible
  and comparable across versions;
- Complements the north-star metric in §11.5, which previously measured *whether*, not *how directly*.

<a id="warum-beides-zusammengehört"></a>

### Why both belong together

The two levers interact: lower complexity means clearer symbol boundaries, less entanglement,
shorter graph paths and therefore fewer hops to the right location. This is the product's
**working hypothesis**, and Untangle treats it that way: it is **measured** on Untangle's own code
and fixtures, not assumed. Failure to confirm it is a finding, not a reason to change measurement.

---

<a id="1c-der-kern-ist-sprachagnostisch--und-prosa-ist-erstklassig"></a>

## 1c. The core is language-agnostic — prose is first-class

It is easy to read Untangle as a source-code tool. That is too narrow.

<a id="was-keinen-parser-braucht"></a>

### What needs no parser

Most of the value chain is **entirely language-independent**:

| Capability | Requires a parser? |
|---|---|
| Discovery, ignore rules, binary detection, hashing | No |
| Embedding and hybrid search | No |
| Change detection through content hashes and text diffs | No |
| Change history and semantic search over changes | No |
| Textual and lexical metrics (§16.6) | Mostly no |
| Cross-repository/project context, provenance, freshness | No |
| AST chunking, symbols, imports, calls | **Yes** |
| Cyclomatic, cognitive, Halstead and syntactic metrics | **Yes** |
| File/symbol graphs, blast radius | **Yes** |

A parser enriches the result. It is not a prerequisite for Untangle's usefulness.

<a id="prosa-ist-kein-ausweichfall"></a>

### Prose is no fallback case

For documentation—Markdown, ADRs, RFCs, specifications, runbooks, changelogs—Untangle works
**especially well**, rather than merely coping without a parser: natural language embeds more
reliably than source code, and questions people and agents ask about systems often concern intent.
*Why* was a decision made, *what* applies, *what* changed? Those answers are in prose, not code.

This repository is its own example: **654 KB of Markdown** versus 2,006 KB of TypeScript. One
third of the volume contains practically the entire basis for decisions.

`spec.md` §7.1 currently describes `text` support as "safe text chunks and search, with no dependable
graph/metric claims", making it sound like a lower tier. That reading must be corrected:

> **`text` is not degraded `deep`. It is the complete service for content without graphs:
> full-quality search, change intelligence, history and provenance. What is absent is absent
> substantively, not through poor implementation.**

<a id="was-daraus-folgt"></a>

### Consequences

- **Structure-aware chunking without a parser.** A Markdown section is a semantic unit, like a
  function. Line windows over prose lose quality just as line windows over code do.
- **Prose-specific metrics instead of code metrics applied to prose.** Cognitive Complexity over
  a Markdown document is meaningless. Section depth, cross-reference density, open-item share and
  freshness are its analogues.
- **Document change intelligence** has independent value: *"which decisions changed last month?"*
  asks about ADRs and specifications, not source code.
- **Doc/code drift** becomes measurable: documentation claims and code behavior are two indexed
  realities with provenance; discrepancies are findings.
- **Language breadth becomes less urgent.** Untangle still supplies search, diff, history and text
  metrics for an unparsed language. A missing adapter costs graphs and AST metrics, not usefulness.

---

<a id="1d-auffindbarkeit-ist-ein-qualitätssensor--kein-beweis"></a>

## 1d. Findability is a quality sensor — not proof

Section 1b implies the inverse observation at the product's core:

> **When healthy search under controlled conditions repeatedly fails to reach the right
> location quickly, it is a finding worth investigating about the relationship between product
> terminology, documentation, code and retrieval—not yet proof of a defect in any one component.**

Poor findability is confounded: task wording, agent strategy, prior context and retrieval quality
can affect results just as product models, documentation and code can. Only after controlling
caller and retrieval conditions do these product/code hypotheses become testable:

| Symptom | Possible product/code hypothesis |
|---|---|
| Hits scattered across many files | Fragmented responsibility |
| The correct hit ranks low | Naming and surrounding context fail to convey intent |
| Several hops before reaching the target | Excessive coupling or deep indirection |
| No matching hit | Undocumented behavior or a name that fails to describe its purpose |

**Findability becomes a measurable relationship between intent, search context and a confirmed
symbol**, not an intrinsic symbol property. Repeatedly hard-to-find targets may appear as hotspot
candidates alongside static complexity; these evidence axes remain separate and must neither
prove nor compensate for each other.

<a id="die-interpretation-setzt-funktionierenden-abruf-voraus"></a>

### Interpretation requires functioning retrieval

This interpretation requires search to have **demonstrably run**. That alone does not establish
causality. If the vector store is unreachable, no embedding profile responds, the symbol is not
indexed, or the probe was never made, nobody actually searched. An empty result then does not mean
"the code is hard to find"; it means "our tool did not work". Confusing them judges someone else's
code for the tool's own failure.

> **A failed search is a finding about Untangle, never about the code being read.**

Untangle separates them structurally, not just by convention. A **measurement** (search ran, here
is its rank) and a **state note** (search did not run, here is why) have distinct forms. The state
note carries no score, cause or evidence; it cannot occupy a place expecting a code claim and
cannot produce a diagnosis. It carries a reason, named, visible and entered in the skip ledger
(§8.4) like any omission. In doubt, Untangle says nothing about the code and describes its own state.

Untangle connects two usually separate observations: **search effort and static code complexity
are separate evidence axes addressing the same work question**—how difficult is it to understand
and change something in this system? Connecting them distinguishes a pure code search engine
from a product complexity sensor; it claims neither correlation nor a shared quality grade.

<a id="die-ratsche-gilt-auch-für-prosa"></a>

### The ratchet also applies to prose

Section 1c means the ratchet from §1b also applies to first-class documentation. A document that
carries the same meaning with less structural, reference and wording load is better. Untangle
should give the same feedback during documentation work as during coding, measured with prose
metrics (§1c), not code metrics.

A document whose associated code is repeatedly hard to find under controlled conditions supplies
a testable drift hypothesis: description, product terms and implementation boundaries may have
diverged. Additional evidence is needed to confirm or reject it.

---

<a id="1e-product-complexity-entsteht-im-suchweg"></a>

## 1e. Product complexity emerges along the search path

Cognitive Complexity describes control flow in a known symbol. The findability probe from §1d
asks how an already-known symbol ranks in a synthetic search for itself. A real product task
starts earlier: the agent does not yet know its target file or symbol. It knows only an intent
such as "Improve card presentation in the profile area".

> **The evidenced steps an agent needs from that intent to the confirmed code target are a dynamic
> observation of this task/agent/retrieval interaction—not merely a static file property.**

In product language: **Product complexity is the distance between intent and implementation. Easy
to find is evidence of a product that is well-defined, clear, and easy to understand.** Repeated
reformulations, broad candidate sets and many hops are not automatically quality judgments. Only
repeated comparable journeys under controlled caller conditions become a heuristic product signal
of how clearly ontology and operations correspond; even then they prove no single cause.

Untangle records this as a **Search Journey**. It begins only with an explicit start, then links up
to 128 hybrid, semantic, lexical or symbolic searches and up to 512 explicitly reported navigation
events, ending with a confirmed target or visible abandonment. Normal search remains fully usable
without this coupling and is not recorded; the product runs no hidden agent telemetry.

A journey may also carry a feature ID declared stable by the caller. Like goals and queries, it is
stored only as its own workspace-local HMAC fingerprint unless text retention is explicitly
requested. This turns a general task into a repeatable **feature probe**: real workspace search
leads from the same product capability to explicitly confirmed code targets, without retroactively
inferring a feature from old or untagged journeys.

<a id="der-evidenztragende-retrieval-funnel"></a>

### The evidence-bearing retrieval funnel

| Stage | Observable evidence | Claim boundary |
|---|---|---|
| Product goal | Workspace-local, domain-separated HMAC-SHA-256 fingerprint; optionally explicitly retained text | No code or search claim yet |
| Feature | Separate workspace-local HMAC-SHA-256 fingerprint of an optional caller-declared feature ID | Cohort association, not content classification or stability verification |
| Search attempts | Query fingerprints, success/failure, ranker version | Effort and reformulation, not target relevance |
| Retrieval | Searched profiles/generations, eligible candidates, limits, file dispersion | Retrieval state, not precision |
| Output | Profile-local ranks, score breakdown, unique hit locators | Which candidates were visible |
| Navigation | Explicitly reported file, symbol, graph and other tool steps | Observed hops only, never inferred |
| Completion | Confirmed file, symbol or chunk locator | Exactly one positive target label |
| Target code | Versioned static metrics of the uniquely attributable accepted index hit and its generation | Separate code axis; never derived from embeddings or search effort |

A completed journey produces explainable indicators: searches to target, query reformulations,
successful and failed search effort, first and accepted target attempt, target rank and reciprocal
rank, candidate/file load, result-list changes, file dispersion, reached candidate limits,
selection lag and observed tool/file hops. Together they form **Dynamic Search Complexity**.
A journey is not compressed into an opaque "complexity score": the components and their caveats
are the product.

The feature probe places this search axis alongside static complexity evidence for the confirmed
target. They remain separate. Embeddings represent semantic proximity for retrieval; their shape
or dimensionality is not product or code complexity. Several simple targets may form a necessarily
broad domain feature, and a locally simple target scope may still be hard to find. Keeping these
concepts distinct is what makes the mapping useful as a learning signal.

<a id="von-einer-aufgabe-zum-kohortierten-produktsignal"></a>

### From one task to a cohort-based product signal

A single search path describes only that task. **Dynamic Product Complexity** emerges from several
completed journeys. Measurement Context v2 strictly separates cohorts by ranker, text-free ranking
context and effective limits, together with each profile's retained association of embedding
profile, index generations and immutable corpus revision. A change in search mode, ranking policy,
model, budget or corpus must not appear as a codebase improvement. Unversioned legacy contexts
remain readable and diagnostically visible, but like other incomplete contexts can never form
sufficient evidence. Fewer than three compatible confirmed targets also produce
`sufficientEvidence: false`. The v1 report aggregates these cohorts without a time axis; it is
not a temporal trend or before/after view.

General backward-compatible workspace cohorts describe observed workload. Feature claims arise
only in `featureMappings`, separated at least by feature fingerprint and measurement context.
Confirmed targets and their metric variants retain scope, version and index generation;
incompatible variants are not averaged, and missing evidence is not treated as zero. Untangle
therefore shows which locator identities callers confirmed during repeated tasks and how much
search effort they required. It verifies neither feature semantics, stability nor code ownership;
different locator precision can also make the same physical code area appear as multiple targets.

Confirming a target supplies exactly one positive label. It makes target rank, reciprocal rank and
score gap measurable, but not the relevance of every other candidate. Untangle therefore claims
**no precision** from Search Journeys. Active and abandoned journeys remain visible as funnel
exits, but do not enter the cohort signal.

Failed embeddings, unsearched profiles and unreachable vector stores remain findings about
Untangle here too. They count toward observed effort and retrieval health, but must never be
silently reinterpreted as high product or code complexity. This separation makes the differentiator
dependable: Untangle measures code and the observed route an agent needed to understand the
product. Separate retrieval health and path indicators suggest whether retrieval problems
contributed; they prove no single cause in code, product models or agent strategy.

The built v1 loop ends at feature-to-code discovery. The larger learning cycle remains an explicit
horizon: confirmed target → change event → executable verification → structural before/after →
real usage → corrected assumptions. Search, code structure, verifiers and usage feedback answer
different questions and must never disappear into a universal score.

---

<a id="1f-zielbild-kontinuierlich-geringe-komplexität-pro-feature"></a>

## 1f. Target: continuously low complexity per feature

Untangle aims to serve as a complete local replacement for analysis and monitoring work currently
covered by Sentrux and Sonar. This remains a development goal. Beyond it, the product promise
includes exposing complexity in feature sets, product terms and ownership: each new function
should retain understandable responsibilities, a bounded change scope and verifiable implementation.

The target loop begins with stable feature identity, acceptance criteria and explicitly confirmed
ownership. Active local search checks how product intent leads to AST symbols, dependencies,
contracts and documentation. Versioned embedding spaces extend retrieval with semantic proximity;
AST and graph evidence establish actual relationships. Ambiguous terms, widely dispersed change
paths, additional coupling and rising structural complexity should give agents concrete
simplification guidance, with locations and uncertainty.

A feature receives comparable before/after evidence, executable verification and a ratchet against
unintended complexity growth. Search quality and index freshness must first be dependable. Current
development supplies this retrieval foundation; binding ownership models, temporal feature
baselines, complete analyzer coverage and automatic change gates remain further work. Neither
embedding distances nor many search attempts alone prove high product complexity.

<a id="gebauter-nächster-schritt-deklarierter-featureabgleich"></a>

### Next implemented step: declared feature alignment

`untangle product` and MCP `untangle_product` connect explicitly declared feature IDs and
acceptance criteria to vision/spec headings, complete code/test scopes and ownership declarations.
Agents see content hashes, coverage, cognitive/cyclomatic metrics in three scope readings and
concrete hints about large responsibilities or missing evidence. Shared code counts once in the
overall union; test complexity remains separate.

An actually executed, source-bound test report can support declared criteria. Embeddings and
search hits do not replace this proof. Untangle's [self-map](./untangle.features.json) is a declared
proposal: work roles are not confirmed people, and missing ownership remains open. Even consistent
evidence does not independently prove domain conformance.

The [v1 contract](./docs/FEATURE_ALIGNMENT.md) requires no index or service. Without a manifest, an
empty draft remains for explicit assignment. This step makes responsibility measurable and
agent-visible; temporal baselines, full analyzer parity and automatic change gates remain further work.

<a id="2-das-problem"></a>

## 2. The problem

Modern software rarely consists of one repository. It spans services, libraries, frontends,
infrastructure, schemas, API specifications and accumulated conventions. Developers and AI agents
lose much of their time reconstructing context rather than writing code.

Current tools each address only part of the problem:

- Grep and symbolic search find strings, but do not understand domain meaning.
- Vector search finds semantically similar passages, but knows no dependable dependencies.
- IDE language servers are precise, but usually limited to one repository, one language and a running IDE.
- Static-analysis tools measure individual quality values, but rarely connect them to search,
  blast radius and change history.
- Coding agents reread files, incur high tool/token costs and make plausible but wrong assumptions
  when context is missing.
- Cross-repository effects often become visible only in CI, staging or production.

The core problem is:

> **Code exists, but its relationships, change impact and maintainability trajectory are not
> available as one queryable system.**

---

<a id="3-warum-untangle"></a>

## 3. Why Untangle

The name **Untangle** describes the benefit: dependencies, responsibilities and impacts move
from an unclear web into a checkable structure.

Untangle does not aim to understand source code "magically". It combines deterministic analysis
with probabilistic search:

- **ASTs and parsers** supply structure and source positions.
- **File and symbol graphs** supply relationships.
- **Qdrant** stores vectors, BM25 data, metadata, graph shards and history.
- **Ollama** generates local embeddings.
- **Git and file hashes** supply traceable changes.
- **Metric engines** capture cyclomatic, cognitive, structural, textual and syntactic complexity.
- **MCP, CLI, npm API and plugins** expose the same intelligence in different work environments.

---

## 4. Mission

Untangle helps teams and agents make changes with dependable system context.

To do so, it must:

- Make relevant code, schema, API and architecture locations quickly discoverable;
- Expose dependencies within and between repositories;
- Predict impact before a change and verify it afterward;
- Explainably capture complexity and architecture regressions;
- Work locally, privately and without mandatory cloud services;
- Integrate with existing tools through standardized interfaces;
- Work incrementally, resumably and efficiently on large codebases.

---

<a id="5-zielgruppen"></a>

## 5. Audiences

### 5.1 Software Engineers

They need reliable answers before changing code:

- Where is a symbol defined and used?
- Which services, packages or repositories depend on it?
- Which tests and configurations matter?
- Is a function already a complexity hotspot?
- Which complexity values change with this patch?

<a id="52-tech-leads-und-software-architects"></a>

### 5.2 Tech leads and software architects

They need an ongoing view of structure and evolution:

- Which dependencies form cycles?
- Which modules have high coupling and high change frequency?
- Which pull requests worsen architecture or maintainability?
- Where do documented and actual architecture disagree?

<a id="53-ai-coding-agents-und-agent-plattformen"></a>

### 5.3 AI coding agents and agent platforms

They need compact machine-readable context:

- Semantic cross-repository search;
- Precise file, symbol and line references;
- Call flow and blast radius;
- Structured complexity and change data;
- Consistent MCP tools independent of the host.

<a id="54-plattform--und-developer-experience-teams"></a>

### 5.4 Platform and developer experience teams

They need a shared local service that:

- Indexes multiple repositories;
- Supplies the same intelligence to IDEs, CLI, CI and agents;
- Combines central policies with local privacy;
- Stores traceable versions of parsers, chunkers, embeddings and metrics.

---

<a id="6-north-star-erlebnis"></a>

## 6. North-star experience

A developer plans to change `AuthService.validateUser` in the backend and asks Untangle:

> "What must I consider when moving validation into the shared identity package?"

Untangle responds with:

- The most relevant code/documentation locations from backend, shared library, frontend and infrastructure;
- The symbol's definition, callers, callees and cross-repository dependencies;
- A blast radius by direct and transitive impact;
- Existing architecture cycles and a simulation of possible new edges;
- Cyclomatic and cognitive complexity before the change;
- Relevant tests, schemas and API contracts;
- A structured change checklist.

After the patch, Untangle supplies:

- Added, changed, moved and removed symbols;
- Complexity deltas with specific contribution sites;
- Added/removed dependencies and cycles;
- An explainable change risk score;
- A quality gate result for CLI, IDE or CI.

The developer did not need to know which repository held each fact. The agent did not need to
open dozens of files blindly. The answer stayed local and was checkable through file, symbol and
line references.

---

<a id="7-strategische-produktpfeiler"></a>

## 7. Strategic product pillars

### 7.1 Evidence-first Code Intelligence

Every answer should rest on evidence that can be stored and checked:

- Repository, ref and commit;
- File and source range;
- Symbol identity and signature;
- Search score components;
- Graph paths and confidence;
- Metric version and contribution sites;
- Timestamp and analyzer version.

Untangle should expose uncertainty rather than hide it. Unresolved calls, parser errors and
incompatible embedding profiles are explicitly labeled.

### 7.2 Cross-Repo by Design

Cross-repository capability is not a later addition. Workspace, repository, branch and commit are
part of each data point's identity from the outset. Search, graphs, impact and changes must work
across repository boundaries.

<a id="73-change-intelligence-statt-statischer-momentaufnahme"></a>

### 7.3 Change intelligence rather than a static snapshot

Untangle captures changes to symbols, dependencies and complexity alongside current state. This produces:

- Historical hotspots;
- Architecture trends;
- Semantically searchable changes;
- Quality gates on deltas rather than existing debt;
- Better rename/move detection.

<a id="74-local-first-und-private-by-default"></a>

### 7.4 Local-first and private by default

Default operation uses local or self-hosted components:

- Qdrant locally or externally managed;
- Ollama locally or remotely in one's own network;
- No mandatory API keys;
- No unsolicited telemetry;
- No source transmission to Untangle services.

Cloud features may be added later, but local operation must not be a reduced demo.

### 7.5 Tool-agnostic Distribution

Untangle is an engine with multiple surfaces:

- npm CLI;
- MCP server;
- Programmatic npm API;
- VS Code extension;
- Plugin/skill bundles for agent hosts;
- CI integration and GitHub Action.

Every surface uses the same core services and stable data contracts.

### 7.6 Explainable Quality

A single "code quality score" is insufficient. Untangle shows:

- Which value changed;
- Which AST nodes or control-flow constructs contributed;
- How the value was calculated;
- How large the affected blast radius is;
- Which threshold or rule was violated.

---

<a id="8-produktprinzipien"></a>

## 8. Product principles

### 8.1 Search before read

Agents and people should search purposefully before reading complete files. Retrieval results
contain enough structure to plan the next query precisely.

### 8.2 Structure before embeddings

Embeddings complement structural analysis rather than replace it. Symbol boundaries, imports,
calls, signatures and metrics are obtained deterministically from source.

### 8.3 Incremental by default

After initial indexing, only affected files, symbols, chunks, graph portions and metrics are
updated. Interruptions must not force complete restarts.

### 8.4 No silent data loss

Large AST regions are split further by structure. Content must not be silently truncated. If a
limit nevertheless applies, the indexer must mark state as incomplete or fail in a controlled manner.

### 8.5 Stable identity over source position

Line numbers are metadata, not primary identity. Repository, file, symbol and chunk IDs use stable
names, signatures and fingerprints.

### 8.6 One engine, many hosts

MCP, CLI, SDK and plugins must not contain divergent analysis implementations. Host-specific
packages remain thin adapters.

### 8.7 Compatibility is versioned

Parser, chunker, embedding, metric and schema versions are stored. An existing index is not
silently reused with incompatible rules.

### 8.8 Defaults must work locally

The first successful flow should require as little configuration as possible:

```bash
npx -y @untangle-code/cli index
npx -y @untangle-code/cli search "authentication flow"
```

Alternatively, an MCP host starts the same engine through `npx`.

---

<a id="9-differenzierung"></a>

## 9. Differentiation

Untangle is neither a chatbot nor another code editor. Its core capability is a reusable codebase
intelligence layer.

| Alternative | Typical strength | Untangle differentiation |
|---|---|---|
| Grep/Ripgrep | Exact text search | Semantic, structural and cross-repository |
| Pure vector RAG systems | Finding similar content | AST boundaries, graphs, impact and metrics |
| Language servers | Precise navigation | Polyglot, persistent, host-independent, cross-repository |
| Traditional static analysis | Deterministic rules | Connected to search, graphs, history and agents |
| Code graph products | Dependencies | Additional hybrid search and change complexity |
| AI coding assistants | Generating and explaining code | Vendor-neutral local evidence for all agents |

The durable advantage is the shared versioned data foundation, rather than one algorithm:

```text
Code + AST + Search + Graph + Complexity + Change History
```

---

<a id="10-bewusste-nicht-ziele"></a>

## 10. Deliberate non-goals

The first product generation should not:

- Replace a general AI chat client;
- Modify source autonomously without an explicit host or user instruction;
- Fully replace build systems or compilers;
- Offer complete runtime observation or APM;
- Position security SAST as its main product;
- Support every language equally deeply immediately;
- Present raw LLM assessments as objective quality metrics;
- Require cloud login for local use;
- Rank incompatible embedding spaces together with false precision.

---

<a id="11-erfolgskriterien"></a>

## 11. Success criteria

<a id="111-nutzerwert"></a>

### 11.1 User value

- A new repository can be indexed without manual data modeling.
- A typical architecture question requires significantly fewer file openings than grep-based exploration.
- Cross-repository results include traceable provenance.
- Refactorings show a useful blast radius before the change.
- Complexity deltas explain new regressions at symbol and line level.

<a id="112-retrieval-qualität"></a>

### 11.2 Retrieval quality

- Relevant ground-truth locations appear predominantly among top results in a curated benchmark.
- Exact symbol, identifier and path queries work reliably through BM25.
- Semantic concept queries find relevant implementations without identical terminology.
- Cross-repository ranking does not systematically favor small or large repositories.

<a id="113-zuverlässigkeit"></a>

### 11.3 Reliability

- Interrupted indexing can resume from its last checkpoint.
- Unchanged files produce no new embedding calls.
- Watcher events are debounced and protected by periodic reconciliation.
- Repository failures degrade cross-repository search in a controlled, visible manner.

### 11.4 Adoption

- npm installation and MCP configuration take only a few commands.
- Plugin bundles use the same engine version.
- VS Code and at least two agent hosts are supported at public beta launch.
- Programmatic API and JSON output allow integration without parsing presentation text.

<a id="115-north-star-metrik"></a>

### 11.5 North-star metric

**Verified context delivered per interaction:** the share of search, impact or change requests
where a person or agent receives an answer with verifiable file/symbol references in at most
three Untangle calls.

Supporting metrics:

- Index-to-first-use;
- Top-k retrieval recall;
- Mean number of subsequently opened files;
- Incremental reindex latency;
- Share of explainable quality gate violations;
- Crash/resume success rate;
- Plugin-to-engine version compatibility.

---

<a id="12-entwicklungshorizonte"></a>

## 12. Development horizons

<a id="horizont-1--verlässlicher-lokaler-kern"></a>

### Horizon 1 — Reliable local core

- Qdrant and Ollama;
- npm CLI and MCP;
- AST chunking;
- Single- and cross-repository hybrid search;
- Incremental indexing and watchers;
- File and symbol graphs;
- Impact, flow and context artifacts.

<a id="horizont-2--complexity-und-change-intelligence"></a>

### Horizon 2 — Complexity and Change Intelligence

- Cyclomatic and cognitive complexity;
- Structural, textual, syntactic and Halstead metrics;
- Change events and complexity history;
- Hotspots, change reports and quality gates;
- Cross-repository change impact.

<a id="horizont-3--team--und-governance-funktionen"></a>

### Horizon 3 — Team and governance features

- Shared remote Qdrant instances;
- Branch- and commit-aware team indexes;
- Policy packs and architecture rules;
- CI/PR comments;
- Audit and access models;
- Optional managed services without creating a dependency for the local edition.

---

<a id="13-marke-und-distribution"></a>

## 13. Brand and distribution

<a id="131-produktmarke"></a>

### 13.1 Product brand

The working name is **Untangle**. Formal trademark, domain and collision checks are required
before public announcement because other software offerings have already used the term.

Recommended spelling:

- Product: `Untangle`
- CLI command: `untangle`
- Configuration file: `.untangle.json`
- Ignore file: `.untangleignore`
- Data directory: `.untangle/`
- MCP server ID: `untangle`

<a id="132-npm-namensstrategie"></a>

### 13.2 npm naming strategy

The unscoped npm package `untangle` is already occupied. The plan therefore provisionally uses its own scope:

```text
@untangle-code/cli
@untangle-code/core
@untangle-code/mcp
@untangle-code/plugin-sdk
@untangle-code/testkit
```

`@untangle-code` is a placeholder scope that must be registered and legally checked before
publication. The scoped CLI package still exports the `untangle` binary:

```bash
npm install --global @untangle-code/cli
untangle --help
```

Without global installation:

```bash
npx -y @untangle-code/cli --help
```

<a id="133-plugin-identität"></a>

### 13.3 Plugin identity

Plugins and extensions should share the brand while using host-appropriate IDs:

```text
MCP server:               untangle
Claude/Cursor plugin:     untangle
VS Code publisher/id:     untangle-code.untangle
Open VSX:                 untangle-code/untangle
GitHub Action:             untangle-code/untangle-action
```

Plugin distribution must not contain a second analysis engine. It installs or starts the
published CLI/MCP engine and bundles only manifests, skills, commands and host UI.

---

<a id="14-open-source--und-clean-room-grundsatz"></a>

## 14. Open-source and clean-room principle

Untangle is developed as an independent implementation with its own data models, APIs, tests and
source. Feature ideas may derive from publicly observable behavior and general techniques;
source from AGPL or other licensed projects may be incorporated only when the chosen Untangle
license and every distribution form explicitly permit it.

Before public beta, decisions are required on:

- Core and CLI licenses;
- Plugin and extension licenses;
- Contributor agreement or DCO;
- Treatment of optional enterprise components;
- Trademark and package-name protection.

---

<a id="15-produktversprechen"></a>

## 15. Product promise

> **Untangle shows which code an agent should read, how that code relates to the system, what
> risks a change creates, whether the system becomes simpler or more complex, and how much
> evidenced search work lay between product intent and its target—locally, traceably and across
> repository boundaries.**
