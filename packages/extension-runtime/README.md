# @untangle-code/extension-runtime

The runtime for analyzer extensions (`extensions.md`, especially §17 “X9”). This package
contains the **runtime**, **manifest schema** and **format parsers**, with **no knowledge
of individual tools**.

> **Untangle knows OUTPUT FORMATS, not TOOLS.**

The package's source contains no tool names (E2). The tool an extension describes appears
only in user data: the manifest the user provides and the tool output the format parser
reads. There is no “if tool X, then …” branch. A third party can therefore publish an
extension without Untangle having to incorporate, maintain or endorse it.

Normative source: [`extensions.md`](../../extensions.md) (takes precedence in conflicts),
supplemented by [`spec.md`](../../spec.md) §25 and [`architecture.md`](../../architecture.md) §23.

---

<a id="die-sicherheitsgrenze-kein-manifest-aus-dem-projektverzeichnis"></a>

## The security boundary: no manifest from the project directory

A manifest describes a **process launch**: program, arguments, container image, network
access. Automatically loading manifests from the project directory would let **every
cloned third-party repository bring a tool that subsequently executes commands without
being requested**. `git clone` would become code execution. These rules therefore apply
without exception:

- Automatic discovery searches **only** user data directories:

  ```text
  ~/.untangle/extensions/<id>/manifest.toml                        (default, cross-platform)
  ~/Library/Application Support/untangle/extensions/<id>/…         (macOS, extensions.md §17)
  $XDG_DATA_HOME/untangle/extensions/<id>/…                        (Linux)
  %APPDATA%\untangle\extensions\<id>\…                             (Windows)
  ```

  `UNTANGLE_EXTENSIONS_HOME` replaces all default roots (tests, special cases).

- A manifest **in the project directory** (including `.untangle/`) is **never** loaded
  automatically. It is reported and ignored (`ExtensionDiscoveryResultV1.ignored`, reason
  `project_local`), rather than silently skipped (E4).
- A project path can be loaded only through an explicit invocation typed by the user:
  `loadExtensionFrom(fs, pfad, { allowProjectLocal: true })`, behind
  `untangle extensions add --from <pfad>`.
- The same applies to **license acknowledgment** (§9.2): it is never read from the
  project directory, because `.untangle/` can be committed and would otherwise pass a
  personal declaration on to the whole team. A same-named project file is ignored
  **and reported as a warning**.

This rule is a security boundary. It is also documented in the header comment of
[`src/paths.ts`](./src/paths.ts) and verified by tests
(`src/paths.test.ts`, `src/manifest/load.test.ts`, `src/license-gate.test.ts`).

---

<a id="die-prozessgrenze-x4--und-warum-sie-eine-lizenzgrenze-ist"></a>

## The process boundary (X4) — and why it is a license boundary

Third-party analysis code is **never linked, bundled or loaded into the Untangle process**.
Only a separate process (an argument array, **never** a shell), a container or an HTTP API
call is permitted.

There are two firm reasons:

1. **License.** Untangle is AGPL-3.0-only (E1). Tools have other, sometimes restrictive
   licenses. Only serialized data crosses a process or network boundary: this is
   aggregation of separate programs, not a combined work. Neither the AGPL extends to
   the tool nor the tool's license to Untangle. Loading third-party code into our process
   would invalidate this reasoning.
2. **Operation.** A tool that crashes, consumes excessive memory or hangs must not take
   down the indexer. Time and output-size budgets can be enforced only outside our process.

The rationale is documented in comments in [`src/process/types.ts`](./src/process/types.ts)
and [`src/process/node-runner.ts`](./src/process/node-runner.ts). `spawn` is called without
`shell`; validation rejects a manifest whose `command` contains shell metacharacters.

---

<a id="modulübersicht"></a>

## Module overview

| Module | Contents | Normative source |
|---|---|---|
| `versions.ts` | One parser version per FORMAT (`untangle-format-sarif-v1` …), plus `EXTENSION_RUNTIME_VERSION`, rather than one adapter version per tool | X9 |
| `paths.ts` | Search roots, OS data directory, `isProjectLocalManifest` — the security boundary | §17, §9.2 |
| `manifest/shape.ts` | `parseExtensionManifest()` — strict TOML structure checks, then `validateExtensionManifest` from `domain` for semantics | §5.2 |
| `manifest/load.ts` | `discoverExtensions()` (user roots only), `loadExtensionFrom()` (explicit path), provenance and hashes | §17, §6.1 |
| `formats/sarif.ts` | SARIF 2.1.0: rules, levels, regions, byte offsets, multiple locations per result | §17 |
| `formats/junit-xml.ts` | JUnit XML: `<failure>`/`<error>` per test case | §17 |
| `formats/generic-findings.ts` | Untangle's documented finding format (JSON Lines) with declarative field mapping | §17 |
| `formats/generic-metrics.ts` | Metrics as a flat key-value list | §17, X3 |
| `positions.ts` | Line/column → byte range using the generation's file content | §7.1 |
| `normalize.ts` | Raw finding → `ExternalFindingV1`: identity, symbol, severity, confidence | §7 |
| `license-gate.ts` | Tool and ruleset gates, acknowledgment file in the user profile | §9, X5 |
| `process/*` | Process and HTTP boundaries with time/output-size budgets and secret redaction | X4, §8, §10.2 |
| `runtime.ts` | `detectExtension` → `runExtension`: lifecycle, `ExtensionRunV1` | §6 |

---

<a id="die-vier-formatparser"></a>

## The four format parsers

Every parser is **pure**: text in, raw findings out. No I/O, clock or tool knowledge.

```ts
import { parseOutputFormat, normalizeFindings, createLineOffsetResolver } from "@untangle-code/extension-runtime";

const parsed = parseOutputFormat("sarif", stdout);          // RawFindingV1[]
const result = normalizeFindings(parsed, context);          // ExternalFindingV1[]
```

The two stages are deliberate. A format parser cannot invent byte offsets absent from
its input: translating line → byte requires the index generation's file content. Stage 1
therefore reports what the text provides, and stage 2 converts it to `ExternalFindingV1`
using injected resolvers. Call `runExtension` for a single-step interface.

| Format | Representation | Details |
|---|---|---|
| `sarif` | JSON (SARIF 2.1.0) | Rule default level; `region.byteOffset` takes precedence over recalculation; one raw finding **per location** |
| `junit-xml` | XML | `originalSeverity` is the element name (`failure`/`error`); without `type`, the qualified test name becomes the rule identifier |
| `generic-findings` | JSON Lines | Canonical fields plus declarative field mapping with dot paths |
| `generic-metrics` | JSON Lines | Values become `ExternalNumberV1`, never `number` (X3) |

**Tolerance and accountability (E4).** Unknown fields are ignored and never cause errors.
Entries that cannot be accepted are **counted and explained** in `FormatParseResultV1.issues`;
valid entries from the same output are preserved. Only when the **entire output** is unusable
does the parser throw `FormatParseError`, which the runtime turns into `EXTENSION_FAILED`
with `details.reason = "output_parse_failed"`.

<a id="kanonischer-generic-findings-eintrag"></a>

### Canonical `generic-findings` entry

```json
{"path":"src/a.ts","startLine":12,"endLine":14,"ruleId":"no-eval",
 "message":"eval is forbidden","severity":"ERROR","confidence":0.9,"isHeuristic":false}
```

Required: `path`, `startLine`, `ruleId`, `message`, `severity`. Optional: `endLine`,
`startColumn`, `endColumn`, `byteOffset`, `byteLength`, `remediation`, `confidenceOriginal`,
`ruleset`, `rulesetVersion`. If the tool uses different field names, the manifest describes
a field mapping (`{ path: "location.file", severity: "extra.level" }`): pure data, no code.

---

<a id="beispielmanifest-ein-sarif-lieferndes-werkzeug"></a>

## Example manifest: a tool that produces SARIF

The example is generic. The tool name is **user input**; Untangle never uses it as a branch
condition. Save it under `~/.untangle/extensions/example-sast/manifest.toml`:

```toml
schemaVersion = 1
id = "example-sast"                 # Also the directory name
displayName = "Example SAST Analyzer"
category = "sast"                   # sast | lint | complexity | dependencies | sbom | quality-platform
invocation = ["binary"]             # Preference order: binary | container | http
languages = ["typescript", "python"]
outputFormat = "sarif"              # sarif | junit-xml | generic-findings | generic-metrics
networkAccess = "none"              # none | loopback | internet (every access needs a reason)
requiresLicenseAcknowledgment = false
defaultRuleset = "curated/default"

[binary]
command = "example-sast"            # Program name only; shell metacharacters are rejected (X4)
versionArgs = ["--version"]
versionPattern = "([0-9]+\\.[0-9]+\\.[0-9]+)"   # Exactly one capture group
minVersion = "1.4.0"
# Placeholders from the closed set {workspace} | {target} | {ruleset}.
# Output is collected from stdout.
analyzeArgs = ["scan", "--sarif", "--config", "{ruleset}", "{target}"]

[resources]                         # Displayed before the first launch (§10.1)
minMemoryMb = 256
recommendedMemoryMb = 1024
recommendedCpus = 2
typicalStartupSeconds = 3

[license]                           # The license gate (X5)
spdxId = "Apache-2.0"
usageRestriction = "none"           # "restricted" requires requiresLicenseAcknowledgment = true
url = "https://example.invalid/license"

[[rulesetSources]]                  # Provenance and license per ruleset (§9.5)
ruleset = "curated/default"
source = "registry"                 # registry | bundled | local
license = "Apache-2.0"
usageRestriction = "none"

[severityMapping]                   # Declarative, not programmed into source
mappingVersion = "untangle-severity-map-v1"
fallback = "medium"                 # Required: an unknown value must neither cause a guess nor disappear
caseInsensitive = true
rules = [
  { from = "none",    to = "info" },
  { from = "note",    to = "low" },
  { from = "warning", to = "medium" },
  { from = "error",   to = "high" },
]

[telemetry]
sendsTelemetry = false
disabledByDefault = true
```

A container manifest also requires a **fully pinned digest** (X6):
`digest = "sha256:<64 hexadecimal digits>"`, with an untagged `image`. A mutable tag silently
changes findings and is rejected. More complete examples are available under
[`fixtures/manifests/`](./fixtures/manifests).

Tools without a standard format provide a **preprocessing command** that converts their
output to `generic-findings`:

```toml
outputFormat = "generic-findings"

[preprocess]
command = "my-converter"
args = ["--to", "untangle-generic-findings"]
```

The runtime passes tool output to `stdin` and reads the result from `stdout`.

---

<a id="lizenz-gate-x5-und-regelsatz-gate-95"></a>

## License gate (X5) and ruleset gate (§9.5)

There are two separate gates:

- The **tool gate** applies to `license.usageRestriction = "restricted"` or
  `requiresLicenseAcknowledgment = true`. Without acknowledgment:
  `EXTENSION_LICENSE_UNACKNOWLEDGED`, **no launch and no pull**.
- The **ruleset gate** applies to each ruleset used, even when the tool itself is
  unrestricted. A ruleset **not** declared in `rulesetSources` is conservatively treated
  as restricted. Purely local rule files trigger **no** gate: the user provides them.

Error messages always name the exact command that would grant acknowledgment. An
acknowledgment expires when `license.restrictionSummary` changes (hash comparison),
when a ruleset's license changes, or after explicit revocation (`revokedAt`).

Storage is exclusively under
`<user-data-directory>/extensions/license-acknowledgments.json`.

---

<a id="untangle-bleibt-ohne-extension-voll-funktionsfähig-x2"></a>

## Untangle remains fully functional without extensions (X2)

No function in this package throws because a tool is missing:

- `discoverExtensions` reports a nonexistent root as `{ exists: false }`, the normal
  state without extensions.
- `createNodeProcessRunner` returns `outcome: "spawn_failed"` with a reason for a missing
  program, rather than throwing `ENOENT`.
- `runExtension` always returns an `ExtensionRunV1` with `exitStatus` and `errorCode`;
  its `error` field carries the `UntangleError`. **The caller decides** whether this is
  visible degradation (a read operation: add the extension to `extensionsUnavailable[]`
  and still return the result) or an error (an explicit `extensions run`).

---

<a id="e4--nichts-wird-stillschweigend-übersprungen"></a>

## E4 — nothing is silently skipped

Every point where information cannot be accepted produces an **explained** entry:

| What | Where | Reason |
|---|---|---|
| Unreadable raw-output entry | `FormatParseResultV1.issues` | `invalid_entry`, `missing_required_field`, `invalid_number`, `no_location`, `unsupported_version` |
| Present but unusable field (confidence outside `[0,1]`, `isHeuristic` as free text, unreadable `line`) | Same location | `unreadable_field` — the raw value is retained as `originalConfidence`; a default does **not** silently replace it |
| Tool reports its own failure in output (SARIF `invocations[].executionSuccessful: false`, error notifications) | Same location | `tool_reported_failure`, recorded on the run as `TOOL_REPORTED_FAILURE` |
| Malformed `run` or `results` element | Same location | `invalid_entry` — valid `runs` from the same file remain |
| Location without a file (purely logical, address only) | Same location | `no_location`, **per location**, not just per `result` |
| Position without a measured line (JUnit without `line`, SARIF without `region`) | `RawPositionV1.lineUnknown` + run warning | Finding retained and anchored at the file start; the substitute position is marked and distinguishable from a measurement |
| Process exits ≠ 0 or is terminated by a signal | `run.errors` as `TOOL_EXIT_NONZERO` with exit status and redacted stderr; **if output contains no entries, the run fails** with `EXTENSION_FAILED` / `exit_status` | For many tools, a nonzero exit status means “I found something”; this justifies retaining the run, but not concealing the failure |
| HTTP response outside `2xx` | `EXTENSION_FAILED` / `http_error` with status and body excerpt | Reporting `401`/`404` as “0 findings” would imply a clean codebase |
| Metric with a path that is not repository-relative | `NormalizationResultV1.skipped` + raw record in `.unresolvedMeasurements` | `resolution_failed` |
| Finding without a resolvable byte range | `NormalizationResultV1.skipped` (`SkipLedgerEntryV1`) + raw record in `.unresolved` | `missing_index_entry` |
| Path that cannot become repository-relative | Same location | `resolution_failed` |
| Severity matched by no rule | `severityFallbackCount` + warning + `severity.mappingMatched = false` | — |
| File absent from the index | `fileIdMissingReason` on the finding | — |
| No enclosing symbol | `symbolResolution: "file_only"` + `symbolResolutionNote` | — |
| Rejected manifest | `ExtensionDiscoveryResultV1.rejected` with field path per issue | — |
| Ignored manifest | `.ignored` | `project_local`, `no_manifest`, `duplicate_id` |
| Truncated output | `stdoutTruncated` / `bodyTruncated` + `failureDetail` | — |

`resolvePosition` returns `null` instead of inventing zero byte offsets. The finding does
not disappear: its raw record remains in `unresolved`.

---

<a id="x3--externe-befunde-sind-niemals-untangle-metriken"></a>

## X3 — external findings are never Untangle metrics

`generic-metrics` values become `ExternalNumberV1` **objects**, making them **structurally**
incompatible with every Untangle metric position (`ComplexitySummaryV1`, `MetricContribution`,
`RiskScoreV1`). There is no function to unwrap them into `number`, only
`formatExternalNumber` for display; `assertUntangleMetricNumber` additionally protects
aggregation paths at runtime. If an external tool measures the same quantity as Untangle,
that is a **cross-check in the test suite** (X8), never a second displayed metric.

---

<a id="determinismus"></a>

## Determinism

- No `Date.now()` or `Math.random()`: time comes through the `Clock` port, the run nonce
  through the `Random` port (a run is an event, not a content derivation — §4.2).
- No `String#localeCompare`: sorting uses `compareCodepoints` from `@untangle-code/domain`.
- `findingId` is `UUIDv5` over run, tool, rule, path, `startByte` and the ordinal within
  an identical location (§4.3). Line numbers do **not** enter `finding_match_key`, so
  simple shifts do not create apparently new findings.
- The same text produces the same parser result twice (verified by tests).

---

<a id="abhängigkeiten"></a>

## Dependencies

| Package | Version | License | Purpose |
|---|---|---|---|
| `smol-toml` | 1.8.0 | BSD-3-Clause | Read TOML manifests |
| `fast-xml-parser` | 5.11.1 | MIT | Read JUnit XML |

Both licenses are on the allowlist in `scripts/check-licenses.mjs`. Versions are pinned exactly.

---

<a id="bekannte-grenzen"></a>

## Known limits

- **Container runs are not implemented.** The package validates and pins the digest (X6)
  and provides the contract shapes, but launches no container: a container runtime port
  is missing, and Untangle deliberately includes no container runtime. `detectExtension`
  reports the mode as unavailable unless a `containerProbe` is injected; `runExtension`
  refuses it with an explanation. Provisioning and teardown (§6.2, §6.7) belong in a
  separate adapter.
- **Output is collected from stdout.** Tools that write only to files need an appropriate
  argument or a `preprocess` step. There is deliberately no `{output}` placeholder while
  the runtime does not read files.
- **`rulesetHash` is not computed.** The value is passed through; callers hash local rule
  files. When neither `rulesetVersion` nor `rulesetHash` is present, the runtime marks the
  run `comparabilityLimited` with a reason (§9.2 addendum); it must then not serve as a
  comparison baseline for change analysis.
- **JUnit XML without a file produces no findings.** Many test runners provide no `file`
  attribute. These failures are counted and explained as `no_location`, rather than guessed.
- **JUnit XML without a `line` attribute produces a substitute position.** The finding is
  anchored at the file start and marked `lineUnknown`; normalization adds a run warning.
  It is deliberately retained because file, rule and message are evidenced, but its line
  is not a measurement. Nested `<testsuite>` elements are fully traversed; an inner suite
  without its own `file` inherits the outer suite's file.
- **`detectExtension` accepts `404` at the root URL as available.** APIs serving only
  subpaths regularly respond this way. `401`/`403` mean unavailable: the service denies
  access for lack of authorization, and no path will respond without valid credentials.
  The analysis run also independently checks the status of its own response.
- **Entity expansion in XML** is limited only by the output-size ceiling, not by a
  separate XML parser check.
- **Concurrency and locks** (§10.3, lock namespace `extension:<workspace>:<extension>`)
  belong to `packages/jobs`, not this package.

---

## Tests

```bash
pnpm --filter @untangle-code/extension-runtime run test
pnpm --filter @untangle-code/extension-runtime run typecheck
```

All tests run without networking, containers or an installed tool. Format parsers are
checked against real committed examples under [`fixtures/`](./fixtures); the process
boundary is checked against a **real** subprocess (`process.execPath` with `-e`), so time
budgets, output limits and cancellation have execution evidence.

<a id="lizenz"></a>

## License

**AGPL-3.0-only.** This package includes the full license text in [`LICENSE`](./LICENSE),
the rationale for the license choice in [`NOTICE`](./NOTICE), and the licenses of all
third-party production dependencies in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).
All three files are part of the npm tarball — AGPL-3.0-only §4 and §5 require every recipient
to receive the license, and a README alone is not a copy of the license.

Local use creates no obligation. Copyleft obligations apply to redistribution and provision
as a network service (AGPL §13).

The corresponding TypeScript source is included under `src/` in the same tarball; the full
repository is available at <https://github.com/lboel/untangle>.
