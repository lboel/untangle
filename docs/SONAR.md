<a id="sonarqube-als-analyzer-extension--betrieb-und-baseline"></a>

# SonarQube as an analyzer extension: operation and baseline

> **Historical revision, partly superseded (addendum 2026-09-07).** The files
> `scripts/sonar-up.sh`, `scripts/sonar-scan.sh` and `docker/extensions/sonarqube.yml`
> below were removed from this repository in commit `4c3436e`. Bundled tool
> definitions effectively become part of the product even when never started;
> a Compose fragment containing SSALv1 analyzers does not belong in an AGPL
> repository (X9). These definitions moved to the user profile.
> The baseline run and assessment below remain evidence for WP-73 and WP-74.
>
> The current operating guide is [COMPLEXITY-SIGNALS.md](./COMPLEXITY-SIGNALS.md).
> It describes the extension as an HTTP read connection to the Measures API,
> with a license gate, token secret and declared meaning per measurement.

Implementation of `extensions.md` WP-69/WP-71. Strictly opt-in (X1): nothing here
runs automatically.

<a id="betrieb"></a>

## Operation

```bash
sh scripts/sonar-up.sh     # Start instance, wait for health, pin digest
sh scripts/sonar-scan.sh   # Run analysis
```

| | |
|---|---|
| Endpoint | `http://127.0.0.1:19001`, **loopback only** |
| Port 19001 rather than 19000 | A foreign SonarQube instance already uses 19000 on this machine. Untangle does not modify foreign containers (`spec.md` §3.2, `extensions.md` §8); it starts an owned instance with separate volumes and container name. |
| Image digest | `sonarqube@sha256:62930c7f510534bb2bf551ca69ad3ee6f8e12b4116d394597c64cefccbb3313b`, recorded in `docker/extensions/sonarqube.digest` (X6) |
| Telemetry | `SONAR_TELEMETRY_ENABLE=false`; otherwise SonarQube sends daily telemetry to SonarSource (`vision.md` §7.4, `extensions.md` §8.7) |
| License gate | LGPL-3.0 core, **bundled SSALv1 analyzers** (not OSI-approved). Explicitly starting the Compose fragment acknowledges this (X5). |
| Token | From `SONAR_TOKEN` or `.untangle/sonar-token`, never project configuration; `.untangle/` is Git-ignored |
| Labels | `dev.untangle.managed=true`, `dev.untangle.extension=sonarqube` |

<a id="baseline-lauf-2026-09-04"></a>

## Baseline run, 2026-09-04

| Metric | Value |
|---|---:|
| Lines of code | 26,560 |
| Files | 265 |
| Bugs | 17 |
| Vulnerabilities | 2 |
| Security hotspots | 0 |
| Code smells | 281 |
| Duplication | 1.9% |
| Cyclomatic (Sonar) | 5,570 |
| Cognitive (Sonar) | 4,284 |
| Technical debt | 2,282 min |
| Maintainability / Reliability / Security | A / D / D |
| **Quality gate** | **OK** |

<a id="bewertung-der-befunde--entscheidung-x3-in-der-praxis"></a>

## Assessing findings: decision X3 in practice

`extensions.md` X3 defines external findings as evidence, not Untangle metrics.
This run provides a concrete example.

<a id="echter-befund-1-von-19"></a>

### Actual finding (1 of 19)

**`packages/parser-registry/src/languages/shared/chunks.ts:129`: `reduce()` without an initial value.**

```ts
const ranges = properties.map((property) => ownRange(property, ctx));
const range = ranges.reduce((acc, r) => unionRange(acc, r));
```

Empty `properties` makes `reduce` throw `TypeError` inside the chunker with an
unhelpful message. Nonemptiness is an implicit caller precondition. Fix with an
explicit guard or initial value. → **WP-73**.

<a id="falsch-positive-im-untangle-kontext-18"></a>

### False positives in Untangle's context (18)

**16× “Provide a compare function that depends on `String.localeCompare`”.**
Following this advice would be actively harmful. For example,
`domain/src/canonical-json.ts:87`:

```ts
const keys = Object.keys(record).sort();
```

This canonical JSON serialization produces `embedding_profile_id` through SHA-256
(`spec.md` §5.7). `localeCompare` depends on locale: identical structures could
serialize and hash differently on different machines, making indexes
incomparable. Default `.sort()` orders UTF-16 code units deterministically and
independently of locale, which is required here. The other 15 locations also
establish determinism: graph shards, contract suites, golden comparisons and
manifest ordering.

**1× “weak hash algorithm” in `domain/src/identity.ts:62`.**
SHA-1 is not a security primitive there; RFC 4122 requires it for UUIDv5. No
sensitive context is involved.

**1× “PATH variable” in `scripts/check-licenses.mjs:52`.** A helper script, not a
production path.

<a id="was-das-für-x8-bedeutet"></a>

### Implications for X8

The X8 cross-check is useful in both directions: Sonar found a genuine latent
defect missed by more than 1,000 own tests, while 16 recommendations could have
broken a core invariant. External findings therefore never enter Untangle
metrics or quality gates without review.

<a id="gegenprobe-nach-wp-82wp-83-2026-09-05"></a>

## Cross-check after WP-82/WP-83 (2026-09-05)

The first self-analysis returned cognitive **17,365** against **4,284** in this
run, a factor of 4.05. WP-82 identified aggregation double counting, not incorrect
individual metric computation. A `file` scope includes control flow from all
child scopes under the documented nesting context (`spec.md` §16.4); naive
summation counts source text once per enclosing scope.

`pnpm complexity:report` is the reproducible cross-check, executed on commit
`1454843`, the same revision analyzed by Sonar above:

| Quantity | Value |
|---|---:|
| Naive total (every scope's `inclusiveValue`) | 18,130 |
| Double-counted contribution | 8,944 |
| **Function measurement scope (`execution_unit`), all files** | **5,773** |
| **Function measurement scope, excluding test/fixture paths (260 files)** | **4,673** |
| External run above (265 files) | 4,284 |
| Ratio | **1.09×**, with 0.98× the file count |

The ratio falls from 4.05× to 1.09× over practically the same file subset. This
confirmed the diagnosis and satisfied X8's established-tool cross-check for the
cognitive metric.

The remaining 9% reflects documented algorithm differences rather than a
measurement error: `untangle-cognitive-v1` treats `case` as a nesting boundary and
hoists logical groups out of condition headers
(`packages/complexity/src/ir/build-ir.ts`, “CONDITION HOISTING”). Eliminating that
difference would abandon the versioned algorithm definition, contrary to
`vision.md` §10 and X3.

Reproduce with:

```bash
pnpm complexity:report --baseline=4284 --baseline-files=265
```

<a id="zweitbefund-aus-demselben-lauf"></a>

### A second finding from the same run

Scope invariants revealed an own defect: `SymbolScopeFact.symbolScopeId` is not
unique per file. Ordinal counters are local to parent scopes, but IDs contain
only the qualified name. Two anonymous callbacks under anonymous parents both
receive `<anonymous>.<anonymous>` with ordinal 0. Roughly **20%** of scopes are
affected. Deduplication by that ID, required by `spec.md` §16.10, would merge and
silently lose real scopes (E4). The report uses repaired byte-range IDs
(`withUniqueScopeIds`) and reports every collision; the adapter needs the fix.
→ **WP-95** (new).

<a id="drittbefund-dateien-mit-beschädigtem-syntaxbaum-gingen-mit-in-die-zahlen"></a>

### A third finding: damaged syntax trees contributed to totals

The figures above came from a run that recorded but never checked each file's
`parseQuality`. Two repository files parse as `partial`, with ERROR/MISSING
nodes; one had **5,626 of 20,514 bytes** under error nodes. Both damaged trees
contributed to every metric. Three real methods disappeared from analysis, while
a scope appeared at hotspot rank 22 with **54 instead of 7**, directly distorting
repair priorities.

`pnpm complexity:report` now excludes these files from measurements, records
reasons in the skip ledger and lists individual error counts and damage in
section 0b. It additionally verifies that every scanner-supplied file appears in
either measurements or the ledger, otherwise exiting 2. The root cause was
deeper: both engines hardcoded `ComplexityFacts.parseDiagnostics` to `[]`, making
`computeSyntactic()` report `parse_error_node_count: 0` for every file. That is
also fixed.

These historical numbers therefore cannot be compared directly with a current
run, which measures two fewer files and excludes damaged syntax trees.

<a id="offene-punkte"></a>

## Open work

- **WP-95 (new):** make `symbolScopeId` unique per file by deriving it from parent
  ID rather than qualified name. Until fixed, `metrics_scope_id` deduplication
  required by `spec.md` §16.10 is wrong for roughly one fifth of scopes.
- **WP-73:** fix the `reduce()` guard in `chunks.ts`, with an empty-list regression.
- Mark the 16 `localeCompare` findings and UUIDv5 finding as **“Won't fix”, with
  reasons**, in this project's SonarQube profile to prevent repeated open findings.
- Reliability D and Security D arise exclusively from these false positives.
  Remeasurement after marking them is appropriate.
