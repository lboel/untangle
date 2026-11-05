# Untangle — Analyzer Extensions Specification

**Status:** Draft 0.2 (revised after review, 2026-09-04)
**Normative version:** `extensions-v1`
**Product:** Untangle
**Purpose:** Binding specification for analyzer extensions: external analysis tools as evidence sources.
**Related documents:** [`spec.md`](./spec.md) (spec-v1, takes precedence in conflicts) · [`architecture.md`](./architecture.md) · [`product.md`](./product.md) · [`vision.md`](./vision.md) · [`portfolio.md`](./portfolio.md) · [`docs/BUILD_PLAN.md`](./docs/BUILD_PLAN.md) §13 (X1–X8, WP-66–WP-72) · [`docs/PARITY.md`](./docs/PARITY.md) B26–B29

Note on E2: Tool names such as Semgrep and SonarQube appear because they are this document's subject: technical integration targets, not marketing references.

---

## 1. Normative language

**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** apply exactly as defined in
[`spec.md`](./spec.md) §1. An implementation conforms to `extensions-v1` only when all
MUST requirements are satisfied and the section 13 tests pass.

Statements marked **Assumption** are decisions made here where source documents left a
choice open; they remain normative until a revision changes them.

### 1.1 Terminology: analyzer extension

**Extension** already has a meaning in existing documents: `architecture.md` §3 and §23.4
and `spec.md` §2.4 refer to Untangle's **host and IDE extensions** (VS Code extensions and
plugins based on the Plugin SDK). The concept specified here is therefore an
**analyzer extension**. Short glossary:

- **Analyzer extension** (this document): an external analysis tool as an evidence source,
  described by a data manifest and connected through an adapter implemented by Untangle
  (Semgrep, SonarQube, …).
- **Untangle Extension / Plugin** (`architecture.md` §3 diagram node “Untangle Extension / Plugins”,
  §23.4 “Plugin Security”; `spec.md` §2.4 speaks exclusively of “Plugin” and does **not** use
  “Extension”): an IDE/host extension consuming the Untangle engine. Outside this document's scope.

Whenever this document shortens the name to “extension,” it means analyzer extension.
Technical identifiers keep the short form (CLI group `untangle extensions`, configuration
field `extensions`, error codes `EXTENSION_*`, `packages/extensions`) because those namespaces
have no colliding identifier: IDE extensions are managed through neither CLI nor MCP.
However, help and descriptions for the CLI group and MCP tools `untangle_extensions` /
`untangle_extension_run` MUST use the full term “analyzer extension” so the distinction remains
visible even when only the name is read.

---

## 2. Purpose, boundaries and non-goals

### 2.1 Purpose

Untangle MAY connect external analysis tools—SonarQube, Semgrep, Ruff, Bandit, ESLint, jscpd,
OSV-Scanner, Trivy, Syft and others—as **analyzer extensions**: optionally start them during
installation or Docker operation, execute them and collect their findings. The sole purpose
is to make **deep analyses** available that Untangle does not itself measure deterministically
(SAST rules, CVE databases, duplicate detection, SBOM), and connect these findings to Untangle's
own symbol identity, file and symbol graphs, Blast Radius, complexity metrics and change history.

### 2.2 Boundaries

Untangle becomes **neither a meta-linter nor a collection point** for arbitrary tool output.
Every analyzer-extension finding MUST bind to an **Untangle entity** and connect through it
to Untangle's model. Entities are workspace, repository, ref, project (the monorepo project
model), file—including manifests and lockfiles—and symbol. Binding has two levels:

- **Symbol binding** (strongest form, usual for SAST and lint findings): the finding lies
  within a symbol and connects to graph, Blast Radius, complexity and change history (X7).
- **File and project binding:** dependency and SBOM findings (OSV-Scanner §12.7, Trivy §12.8,
  Syft §12.9) bind to manifest/lockfile files and the project model. These are connected,
  not merely displayed: import graphs and project assignment identify which projects—and
  in later versions which symbols—can reach a vulnerable dependency. File/project binding
  is the weaker level of the criterion rather than an exception to it.

Results that achieve neither binding or add no analytical value beyond raw findings remain
out of scope. A tool run whose result would only be displayed without a connection does not
belong in this model.

Earlier versions made **symbol** connection (symbol, graph, Blast Radius) the exclusive
criterion, contradicting the initial OSV-Scanner and Trivy adapters that bind at file/project
level. This revision resolves that contradiction through levels rather than an exception.

### 2.3 Non-goals of `extensions-v1`

- no Untangle-owned SAST/security ruleset; security SAST is not a primary product (`vision.md` §10);
- no automatic application of fixes or remediations from external findings;
- no bundling, vendoring, linking or embedding external code or images (X4);
- no extension marketplace or loading external **code** as an extension: in `extensions-v1`, an extension is a **data manifest** plus an Untangle-implemented adapter, never executable external code inside the Untangle process;
- no adoption of external severity as an Untangle quality judgment; external findings are evidence, not Untangle measurements (X3, `vision.md` §10);
- no aggregation of external findings into `ComplexitySnapshotV1` or other Untangle metrics (X3);
- no automatic container startup without an explicit user instruction (X1);
- no core capability requiring an extension (X2);
- no license compliance analysis capability: the license gate (section 9) protects users against inadvertently violating tool usage terms; it does not assess workspace code.

---

## 3. Guiding decisions X1–X8 (normative)

The eight guiding decisions from `docs/BUILD_PLAN.md` §13 are adopted and expanded normatively.
One error was found and corrected at the source: the original X3 rationale misquoted
`vision.md` §10 as “third-party assessments” instead of the actual wording “present raw
**LLM** assessments as objective quality metrics.” `docs/BUILD_PLAN.md` §13 has carried the
corrected rationale since 2026-09-04; section 7.5 adopts it here. X1–X8 themselves remain valid.

### X1 — Extensions are strictly opt-in

- A container or external binary MUST NOT start without an explicit user instruction.
  `untangle index` without extension configuration MUST behave exactly as it would without this document.
- `untangle extensions enable <id>` enables the extension in configuration but starts nothing itself (section 11.1).
- Rationale: Local-first (`vision.md` §7.4); extensions consume RAM, CPU and startup time—SonarQube alone requires around 2 GB RAM.

### X2 — Untangle remains fully functional without extensions

- A core capability MUST NOT require an extension.
- If a configured extension is unavailable at runtime, the result MUST visibly degrade:
  affected responses list it in `extensionsUnavailable[]` with a reason; the operation
  MUST NOT abort for that reason (`spec.md` §25.2: reads degrade in a controlled way).

### X3 — External findings are `ExternalFindingV1`, never Untangle metrics

- Every external finding MUST be represented as `ExternalFindingV1` and carry `tool`,
  `toolVersion`, `ruleId`, `ruleset`, `rulesetVersion` and `confidence`.
- External findings MUST NOT contribute to `ComplexitySnapshotV1`, `ComplexitySummaryV1`,
  complexity aggregates or Risk Score `untangle-risk-v1`. Full rationale: section 7.5.

### X4 — Invocation only across process or HTTP boundaries

- External code is never linked, bundled or loaded into the Untangle process. Only standalone
  processes (argument arrays, no shell), containers and HTTP API calls are permitted.
- Container images are pulled rather than distributed. This keeps the AGPL boundary (E1)
  clear in both directions; details in section 9.4.

### X5 — License gate before the first run

- Every extension manifest MUST declare licensing and usage restrictions. Tools with
  restrictive terms (such as CodeQL or SSALv1-licensed SonarQube analyzers, section 12.2)
  MUST require explicit persisted acknowledgment before the first run (section 9).

### X6 — Pinned image digests, no `latest` tags

- Every container manifest MUST pin a complete `sha256` digest. `latest` and moving tags
  MUST NOT be used: a moving image silently changes findings. Runtime verification:
  section 6.4 (`EXTENSION_IMAGE_MISMATCH`).
- `container.image` contains only the repository name: no tag or embedded `@sha256:…`.
  A **registry with a port** (`registry.example.invalid:5000/vendor/analyzer`,
  `localhost:5000/analyzer`) is explicitly allowed; its colon belongs to the host.
  Validation MUST separate the registry part before checking tags. Otherwise it rejects
  a correctly pinned reference for an inapplicable reason and misdirects the user
  (added in Wave 10).

### X6a — Provisioning is rendered from the manifest (Wave 12)

- Untangle DOES NOT EXECUTE a supplied Compose file. It renders provisioning on every run
  from the validated manifest. X6 is the reason: an external file may name a moving tag,
  leaving the manifest digest ineffective. An external file also cannot prove to Untangle
  that loopback binding, labels and nonprivileged execution are correct.
- Rendering uses `image@digest`, ports bound only to `127.0.0.1`, both §8.2 labels, named
  volumes prefixed `untangle-ext-<id>-`, `privileged: false`, `cap_drop: ALL` and
  `no-new-privileges`. Output is deterministic.
- The **digest belongs to the extension, not the invocation mode**. A service is provisioned
  as a container and queried over HTTP, so availability probing never enters the container
  branch. `status` and `run` MUST still compare the running digest with its pin; otherwise
  X6 is ineffective precisely when a container is running.
- Untangle itself waits for health through the manifest healthcheck rather than rendering
  a container healthcheck: a container check would assume which program exists inside,
  precisely the tool knowledge X9 keeps out of source code.

### X6b — Ownership check before every intervention (Wave 12)

- Before every intervention, `down`, `logs` and `up` MUST check that the container carries
  BOTH §8.2 labels. `untangle-ext-<id>` is predictable and may name someone else's container.
  Without labels, nothing is touched and the reason is reported; starting alongside it is
  not an alternative.
- `--remove-volumes` is valid only with `--remove-container` and is the sole operation in
  this group that destroys unrecoverable work.
- A call rejected as a CLI usage error MUST NOT have changed anything. Flag validation
  precedes every state mutation.

### X8a — An external measurement declares its meaning or remains unnamed (Wave 11)

- A manifest MAY declare meaning per output key: `[[complexitySignals]]` with `key`,
  `kind` from `cognitive | cyclomatic | sloc | duplication | dependency-cycles |
  dependency-depth | proprietary-composite`, and `scope` from `repository | file | symbol`.
- `comparableTo` names the Untangle metric version for an X8 cross-check. For
  `kind = "proprietary-composite"`, validation MUST REJECT `comparableTo`: a vendor's
  composite formula is undisclosed, so there is nothing to compare against. Such a
  comparison would assert something about external mathematics rather than measure it.
- `comparableTo` MUST name an existing metric version and an actually produced `(kind, scope)`
  pair. `untangle-metrics-v1` supports cognitive/cyclomatic at repository, file and symbol
  scope; SLOC only at file/symbol scope; dependency-cycles/dependency-depth at repository/file
  scope. Duplication and proprietary-composite have no native comparison metric. Domain
  validation enforces this catalog; without `comparableTo`, such values remain valid evidence.
- A measurement whose declared `scope` requires a file or symbol reference but arrives
  without a path MUST NOT carry that meaning; the reason must be recorded (E4).
- An undeclared key remains a named number. It is retained and never compared.

### X8b — Output shape belongs in the manifest, not source code (Wave 11)

- `[outputMapping]` declaratively describes `generic-*` output: `shape` (`entries` |
  `flat-object`), `container` as a dotted entry-list path, and field names `key`, `value`,
  `unit`, `path`, `severity`, `message`, `ruleId`.
- `flat-object` MUST be declared and MUST NOT be guessed: the same object could be one entry.
  `flat-object` is valid only for `generic-metrics`.
- A declared `container` path that resolves to nothing is a FINDING rather than an empty
  result: “nothing there” and “not a list there” are different statements.
- Before Wave 11, parsers contained this reading helper but no manifest could access it;
  it worked only for source-level callers.

### X8c — `authSecretName` (Wave 11)

- The scheme is `Authorization: Bearer <value>`. The value comes from the environment or
  private user configuration, never the manifest (§8.5), and also enters the redacted values.
  Nonempty environment values take precedence.
- A missing or empty secret yields NO header: an empty Bearer would pretend authentication.
- `authSecretName` MUST reference a declared `[[secrets]]` entry; dangling references fail
  validation. Previously the field was declared but ineffective: requests went out
  unauthenticated and the 401 did not identify the cause.

### X7 — External findings are first-class filter and change dimensions

- `untangle query --finding <tool>:<rule>`, `--severity` and `--has-findings` MUST execute
  as store payload filters (section 11.4). Change analysis MUST report new and removed
  findings per symbol (section 11.5).

### X8 — Cross-validation instead of duplication

- When an external tool measures the same quantity as Untangle (cyclomatic complexity in
  SonarQube, lizard, radon), it serves as a **cross-check** of native values in the test suite,
  rather than a replacement or parallel display value. Systematic differences are test
  findings (section 13.3).

---

## 4. Identity model

In addition to [`spec.md`](./spec.md) §5:

### 4.1 Extension ID

`extension_id` is a short, stable lowercase manifest identifier (e.g. `semgrep`, `sonarqube`,
`osv-scanner`). It MUST be stable across workspaces and MUST NOT depend on version or digest.

### 4.2 Run ID

```text
extension_run_id = UUIDv5(
  workspace_id + extension_id + adapter_version + started_at_iso + random_run_nonce
)
```


**Assumption:** A run is an event rather than content-derived; it therefore includes a
`random_run_nonce` (through the `Random` port). Two runs over identical content are two runs.

### 4.3 Finding ID

```text
finding_id = UUIDv5(
  extension_run_id + tool + rule_id + normalized_file_path +
  start_byte + ordinal_within_identical_location
)
```


`finding_id` identifies a finding **within a run**. Comparisons between two runs
(Change Analysis, section 11.5) additionally use the line-independent **matching key**:

```text
finding_match_key = tool + rule_id + (symbol_id | normalized_file_path) + SHA256(normalized_message)
```


Line numbers MUST NOT enter the matching key, so pure line shifts do not create apparently
new findings (the same logic as `spec.md` §5.5).

---

## 5. Data contracts

Every contract carries `schemaVersion` and provenance. Field and type names are English (E3).
`SourceRange` and `NormalizedSeverity` are exported from `packages/domain` (additive contract
registry, `docs/BUILD_PLAN.md` §3).

### 5.1 Shared base types

```ts
type ExtensionCategory =
  | "sast"
  | "lint"
  | "complexity"
  | "dependencies"
  | "sbom"
  | "quality-platform";

type ExtensionInvocationMode = "binary" | "container" | "http";

type NormalizedSeverity = "info" | "low" | "medium" | "high" | "critical";

interface ExtensionProvenanceV1 {
  extensionId: string;
  adapterVersion: string;      // e.g. "untangle-ext-semgrep-v1"
  toolVersion: string;
  imageDigest?: string;        // set for container invocations
  invocation: ExtensionInvocationMode;
  rawLocation?: string;        // pointer into the raw tool output (path or JSON pointer)
}
```


### 5.2 `ExtensionManifestV1`

A manifest is a pure data artifact (JSON) describing an extension completely. In
`extensions-v1`, Untangle supplies the initial-adapter manifests (section 12); additional
local manifests MAY be loaded through configuration but MUST validate against the JSON
schema and always reference an Untangle-implemented adapter (`adapterVersion`), never external code.

```ts
interface ExtensionManifestV1 {
  schemaVersion: 1;
  id: string;                          // extension_id, e.g. "semgrep"
  displayName: string;                 // e.g. "Semgrep"
  category: ExtensionCategory;
  adapterVersion: string;              // versioned Untangle adapter, e.g. "untangle-ext-semgrep-v1"

  // invocation preference order; the first available mode wins (detect, section 6.1)
  invocation: ExtensionInvocationMode[];

  binary?: {
    command: string;                   // executable name resolved via PATH, never a shell string
    versionArgs: string[];             // e.g. ["--version"]
    versionPattern: string;            // regex with one capture group for the version
    minVersion?: string;               // semver-ish minimum, adapter-checked
  };

  container?: {
    image: string;                     // repository name WITHOUT tag, e.g. "semgrep/semgrep"
    digest: string;                    // pinned "sha256:…" digest (X6); MUST be complete
    ports: {
      name: string;                    // e.g. "http"
      containerPort: number;
      hostPortDefault: number;         // loopback binding only, section 8.1
    }[];
    volumes: {
      name: string;                    // named volume, prefixed "untangle-ext-<id>-"
      mountPath: string;
      readOnly: boolean;
    }[];
    workspaceMount: {
      mountPath: string;               // where the workspace root appears inside the container
      readOnly: boolean;               // MUST be true unless a documented reason exists
      writableReason?: string;         // required when readOnly=false
    };
    healthcheck: {
      kind: "http" | "command";
      httpPath?: string;               // for kind "http", against the loopback host port
      command?: string[];              // for kind "command", executed inside the container
      intervalMs: number;
      timeoutMs: number;
      retries: number;
    };
    environment?: Record<string, string>; // static, non-secret environment
  };

  http?: {
    defaultUrl?: string;               // e.g. an already running quality platform
    authSecretName?: string;           // references an entry in `secrets`
  };

  setup?: {
    command: string;                   // external credential provider, no shell
    args: string[];                    // no secret values; see section 8.5
  };

  resources: {
    minMemoryMb: number;
    recommendedMemoryMb: number;
    recommendedCpus: number;
    typicalStartupSeconds?: number;    // shown before provisioning (section 10.1)
  };

  languages: string[];                 // supported languages; empty array = language-independent

  license: {
    spdxId: string;                    // e.g. "LGPL-2.1-only"; "NOASSERTION" if not an SPDX license
    usageRestriction: "none" | "restricted";
    restrictionSummary?: string;       // required when usageRestriction = "restricted"
    url?: string;                      // license or terms URL
  };
  requiresLicenseAcknowledgment: boolean; // MUST be true when usageRestriction = "restricted"

  secrets: {
    name: string;                      // logical name, e.g. "sonarToken"
    envVar: string;                    // environment variable to read, e.g. "UNTANGLE_EXT_SONAR_TOKEN"
    required: boolean;
    setupOnly?: boolean;              // bootstrap credential; never passed to the analyzer
    purpose: string;
  }[];

  defaultRuleset?: string;             // e.g. "p/ci" for Semgrep
  rulesetSources?: {
    ruleset: string;                   // e.g. "p/ci"; local rule files are covered by rulesetPaths
    source: "registry" | "bundled" | "local";
    license: string;                   // e.g. "Semgrep Rules License v1.0" (research state, verify before use)
    usageRestriction: "none" | "restricted";
    restrictionSummary?: string;       // required when usageRestriction = "restricted"
  }[];
  outputFormat: string;                // versioned identifier of the parsed format, e.g. "semgrep-json"

  networkAccess: "none" | "loopback" | "internet";
  networkJustification?: string;       // required when networkAccess != "none"

  telemetry: {
    sendsTelemetry: boolean;           // does the tool phone home by default?
    disableMechanism?: string;         // flag/env/config key the adapter sets, e.g. "--metrics=off"
    disabledByDefault: boolean;        // MUST be true when a disable mechanism exists
  };
}
```


Requirements:

- `container.digest` MUST be present and complete when `invocation` contains `container` (X6).
  Validation MUST reject a manifest using a tag instead of a digest.
- `requiresLicenseAcknowledgment` MUST be `true` when `license.usageRestriction` is
  `"restricted"`; validation MUST enforce this relationship.
- `networkAccess` MUST be declared; an adapter MUST NOT use more access than declared (section 8.6).
- Secrets are declared only as environment references; their values never appear in the manifest.
- `telemetry` MUST be declared. If a disabling mechanism exists, `telemetry.disabledByDefault`
  MUST be `true`, and the adapter MUST apply the mechanism on every run (section 8.7).
  Validation MUST reject `sendsTelemetry: true` with an existing `disableMechanism` and
  `disabledByDefault: false`.
- Rule sources MUST be declared **per ruleset**, not just per tool. Every registry ruleset
  in `defaultRuleset` or requested at runtime MUST appear in `rulesetSources`. An undeclared
  registry ruleset is conservatively `usageRestriction: "restricted"` and triggers the
  ruleset gate (section 9.5).

### 5.3 `ExternalFindingV1`

```ts
interface ExternalFindingV1 {
  schemaVersion: 1;
  findingId: string;                   // section 4.3
  workspaceId: string;
  repoId: string;
  refId: string;
  projectId?: string;                  // monorepo project (monorepo.md, A3), when resolvable

  fileId?: string;                     // absent ONLY when the file is not part of the index
  fileIdMissingReason?: string;        // required when fileId is absent (E4)
  filePath: string;                    // "/"-normalized, repo-relative
  sourceRange: SourceRange;            // startLine/endLine plus startByte/endByte where derivable

  symbolId?: string;                   // enclosing symbol, when resolvable (section 7.2)
  symbolFqn?: string;
  symbolResolution: "symbol" | "file_only";
  symbolResolutionNote?: string;       // reason when "file_only"

  tool: string;                        // e.g. "semgrep"
  toolVersion: string;
  ruleId: string;                      // tool-native rule identifier
  ruleset?: string;                    // e.g. "p/ci"
  rulesetVersion?: string;

  severity: {
    normalized: NormalizedSeverity;    // section 7.3
    original: string;                  // untouched tool value, e.g. "BLOCKER"
    mappingVersion: string;            // "untangle-severity-map-v1"
  };

  message: string;
  remediationHint?: string;

  confidence: {
    value: number;                     // [0,1]
    basis: "tool" | "mapped";          // "tool" when the tool emits confidence, else "mapped"
    original?: string;                 // untouched tool value, e.g. Bandit "HIGH"
  };
  isHeuristic: boolean;                // true when the rule/engine is heuristic by nature

  detectedAt: string;                  // ISO timestamp of the run (Clock port)
  extensionRunId: string;
  provenance: ExtensionProvenanceV1;
}
```


### 5.4 `ExtensionRunV1`

```ts
interface ExtensionRunV1 {
  schemaVersion: 1;
  runId: string;
  extensionId: string;
  adapterVersion: string;
  toolVersion: string;
  imageDigest?: string;

  ruleset?: string;                    // effective ruleset of this run (instance config or defaultRuleset)
  rulesetVersion?: string;             // registry version, when the tool reports one
  rulesetHash?: string;                // "sha256:..." over the resolved rule content (see requirements)

  workspaceId: string;
  repoIds: string[];
  refIds: string[];
  projectIds?: string[];
  indexGenerationId?: string;          // generation used for symbol resolution (section 7.2)

  startedAt: string;
  finishedAt?: string;
  exitStatus: "completed" | "failed" | "timeout" | "cancelled";
  errorCode?: string;                  // error class from section 6.5 when not "completed"

  filesAnalyzed: number;
  filesSkipped: {                      // E4: every skipped file WITH a reason
    filePath: string;
    reason: string;                    // e.g. "not_in_ruleset_scope", "binary", "too_large"
  }[];

  findingCounts: Record<NormalizedSeverity, number>;
  findingsTotal: number;

  resources: {
    wallTimeMs: number;
    maxMemoryMb?: number;              // when the runtime can measure it
    cpuTimeMs?: number;
  };

  artifacts?: {
    kind: "raw_output" | "sbom" | "report";
    path: string;                      // under .untangle/extensions/<id>/runs/<runId>/
    format: string;                    // e.g. "semgrep-json", "cyclonedx-json"
  }[];

  errors: { code: string; message: string }[];
}
```


Requirements:

- `filesSkipped` MUST list every file skipped by tool or adapter with a reason (E4).
  An empty array means nothing skipped, never not assessed.
- Raw output SHOULD be saved as a bounded `raw_output` artifact under
  `.untangle/extensions/<id>/runs/<runId>/`. **Assumption:** default maximum 64 MB; larger
  artifacts are discarded with a warning.
- `ruleset`, `rulesetVersion` and `rulesetHash` MUST be set whenever a run was configured with
  a ruleset, including zero findings and discarded oversized raw output. Run provenance
  MUST NOT depend on its output (traceability, section 14).
- `rulesetHash` is `sha256` over resolved rule content: for local `rulesetPaths`, all rule
  file contents in deterministic order (sorted, `/`-normalized paths); for registry rulesets,
  the definition actually downloaded if the adapter receives it. Otherwise the hash is
  absent and `rulesetVersion` MUST carry the registry version. Local rule files often have
  no version number; their content hash IS their version. Comparability checks (section 11.5)
  thereby distinguish silent rule changes from code changes.

### 5.5 `ExtensionHealthV1`

```ts
interface ExtensionHealthV1 {
  schemaVersion: 1;
  extensionId: string;
  checkedAt: string;

  available: boolean;
  effectiveInvocation?: ExtensionInvocationMode;
  endpoint?: string;                   // e.g. "http://127.0.0.1:19000", secrets redacted
  binaryPath?: string;                 // resolved binary for mode "binary"
  toolVersion?: string;

  imageDigest?: string;                // digest of the RUNNING container
  digestMatchesManifest?: boolean;     // false => EXTENSION_IMAGE_MISMATCH on run

  licenseGate: "not_required" | "acknowledged" | "unacknowledged" | "revoked";

  lastSuccessfulRunAt?: string;
  lastError?: { code: string; message: string; at: string };
}
```


### 5.6 Configuration

`UntangleConfigV1` (`spec.md` §4.2) gains optional field `extensions` (normative definition
here; addition to `spec.md` in section 15):

```ts
interface ExtensionsConfig {
  enabled?: string[];                        // extension ids; default [] (X1)
  manifestPaths?: string[];                  // additional local manifest files (validated)
  runAfterIndex?: string[];                  // ids to run after a completed index generation; opt-in
  defaults?: {
    timeoutMs?: number;                      // default 900000 (assumption, section 10.2)
    keepContainersRunning?: boolean;         // default false; true keeps server extensions warm
  };
  perExtension?: Record<string, ExtensionInstanceConfig>;
}

interface ExtensionInstanceConfig {
  invocation?: ExtensionInvocationMode[];    // overrides the manifest preference order (section 8.8)
  ruleset?: string;                          // overrides manifest defaultRuleset
  rulesetPaths?: string[];                   // local rule files/directories
  timeoutMs?: number;
  memoryLimitMb?: number;                    // container memory limit; default recommendedMemoryMb
  hostPorts?: Record<string, number>;        // port name -> loopback host port override
  env?: Record<string, string>;              // static, non-secret environment for the tool
  keepRunning?: boolean;                     // for server extensions (e.g. SonarQube)
}
```


- Secrets MUST NOT appear in this configuration; they come only through manifest-declared
  environment variables or the secret store (section 8.5).
- `runAfterIndex` is the sole automatic execution form, and acts only for extensions also
  listed in `enabled` whose license gate is satisfied (X1, X5).

### 5.7 Persistence

**Assumption:** External findings are persisted in a dedicated collection:

```text
{prefix}findings_v1
```


Payload follows `CodeChunkPayloadV1` conventions (`spec.md` §10.3, snake_case):

```ts
interface ExternalFindingPayloadV1 {
  schema_version: 1;
  point_type: "external_finding";
  workspace_id: string;
  repo_id: string;
  ref_id: string;
  project_id?: string;
  file_id?: string;
  file_path: string;
  start_line: number;
  end_line: number;
  start_byte?: number;
  end_byte?: number;
  symbol_id?: string;
  symbol_fqn?: string;
  tool: string;
  tool_version: string;
  rule_id: string;
  ruleset?: string;
  ruleset_version?: string;
  severity_normalized: NormalizedSeverity;
  severity_original: string;
  confidence_value: number;
  is_heuristic: boolean;
  message: string;
  detected_at_epoch_ms: number;
  extension_run_id: string;
  finding_match_key: string;           // section 4.3
}
```


Keyword indexes MUST exist at least for:

```text
point_type, workspace_id, repo_id, ref_id, project_id, file_id, file_path,
symbol_id, tool, rule_id, severity_normalized, extension_run_id, finding_match_key
```


Numeric indexes SHOULD exist for `confidence_value` and `detected_at_epoch_ms`.
Findings need no dense vectors; whether the collection is vectorless or has an empty vector
schema is a storage-adapter detail, not normative. `ExtensionRunV1` and `ExtensionHealthV1`
are stored through `MetadataStore`.

---

## 6. Lifecycle

Every extension follows `detect → provision → health → run → collect → normalize → teardown`.
Each step defines requirements, prohibitions and its failure code (section 6.5).

### 6.1 detect

- MUST determine availability per invocation mode in manifest preference order: `binary`
  (resolve PATH command, read version through `versionArgs`/`versionPattern`, check
  `minVersion`), `container` (runtime reachable), `http` (endpoint configured).
- MUST record tool version and effective mode in `ExtensionHealthV1`.
- MUST NOT start containers, pull images or access networks beyond a local runtime socket.
- With gate state `unacknowledged` or `revoked`, MUST return **without any probe**:
  `available: false`, with a gate reason per invocation mode. Version queries start an
  external program and endpoint probes contact an external service; X5 permits both only
  after acknowledgment. This rule belongs in this function rather than caller ordering:
  `run`, `status`, MCP and future callers invoke `detect` themselves and could each order
  their steps differently (added in Wave 10).
- No available mode ⇒ `EXTENSION_UNAVAILABLE`. Read operations visibly degrade
  (`extensionsUnavailable[]`); explicit `extensions run` fails.

### 6.2 provision

Only for `container` mode, enabled extensions and a satisfied license gate.

- MUST show manifest resource guidance before first startup and request confirmation in
  interactive contexts (section 10.1).
- MUST pull the image only by its pinned digest (`image@digest`, X6).
- MUST create persistent named manifest volumes (`untangle-ext-<id>-…`).
- MUST start the container with section 8.2 labels, loopback port bindings and manifest
  workspace mount; `readOnly` applies as declared.
- MUST NOT start privileged containers, touch foreign containers or volumes, or bind host
  ports outside `127.0.0.1`.
- Pull/start failure ⇒ `EXTENSION_UNAVAILABLE`; unacknowledged license gate ⇒
  `EXTENSION_LICENSE_UNACKNOWLEDGED`.

### 6.3 health

- MUST execute the manifest healthcheck with its interval/timeout/retries and persist the
  result as `ExtensionHealthV1`.
- MUST read running containers' actual image digests and compare them with the manifest.
- MUST NOT “repair” a failed healthcheck by recreating or deleting containers (following
  `spec.md` §25.2: no destructive automatic recovery).
- Failure ⇒ `EXTENSION_UNAVAILABLE`; digest mismatch ⇒ `EXTENSION_IMAGE_MISMATCH`
  (the run MUST NOT start).

### 6.4 run

- MUST invoke the tool through an argument array (never a shell string), container exec
  or HTTP, with time/memory budgets (section 10.2) and `AbortSignal`.
- MUST track a separate job that never blocks the core index (section 10.3).
- MUST record the latest completed `indexGenerationId` for later normalization.
- MUST NOT change workspace files, pass secrets as arguments (environment only), or use more
  network access than declared.
- Time budget exceeded ⇒ `EXTENSION_TIMEOUT`; other failure (exit status, memory violation,
  process error) ⇒ `EXTENSION_FAILED` with `details.reason`.

### 6.5 collect

- MUST collect complete raw output (file, stdout or paginated HTTP; all pages up to the
  documented maximum MUST be read).
- MUST tolerate unknown output fields: read known fields only; unknown data never aborts parsing.
- SHOULD save size-bounded raw output as an artifact (section 5.4).
- MUST NOT silently discard subsets from partially readable output. Unparseable data is
  counted and recorded as a run error (E4).
- Entirely syntactically unusable output ⇒ `EXTENSION_FAILED` with
  `details.reason = "output_parse_failed"`.

### 6.6 normalize

- MUST map every raw finding to `ExternalFindingV1` under section 7 and persist it.
- MUST complete `ExtensionRunV1` with counts, skips and resource use.
- MUST NOT write findings without provenance or original severity.
- Persistence failure ⇒ the storage error class (`QDRANT_UNAVAILABLE`, etc., `spec.md`
  §25.1), not `EXTENSION_FAILED`; the cause MUST remain distinguishable.

### 6.7 teardown

- MUST stop started one-shot containers; server extensions with `keepRunning=true` continue.
- MUST NOT automatically delete volumes, or stop/remove foreign containers without an
  Untangle label (`architecture.md` §23.3).
- Teardown errors are warnings and MUST NOT overwrite the run result.
- Explicit container removal, optionally including volumes, is available only through
  `untangle extensions disable <id> --remove-container [--remove-volumes]` (section 11.1).

### 6.8 Error classes

In addition to [`spec.md`](./spec.md) §25.1 (shared `ErrorCode` enum in `packages/domain`):

```text
EXTENSION_UNAVAILABLE            extension absent, cannot start or healthcheck persistently failing;
                                 read results visibly degrade instead of aborting (X2)
EXTENSION_FAILED                 run started but failed: exit status, memory violation,
                                 unusable output (details.reason distinguishes the cause)
EXTENSION_LICENSE_UNACKNOWLEDGED license gate unacknowledged or revoked; no start (X5)
EXTENSION_TIMEOUT                run time budget exceeded; cancellation through AbortSignal
EXTENSION_IMAGE_MISMATCH         running-container digest ≠ pinned manifest digest (X6)
```


The principles in `spec.md` §25.2 remain unchanged: not found ≠ infrastructure error;
error responses include retryability and an actionable next step.

---

## 7. Normalization

### 7.1 Position mapping: line → byte range

External tools usually return line-based positions, sometimes with columns. Normalization MUST:

1. determine the run's file content state: use the file `content_hash` in the run's
   `indexGenerationId`. If current content differs, still resolve against that generation
   and record drift as a run warning;
2. translate line range through the file's line index (File Manifest) to a byte range:
   `startByte` is start-line beginning or column offset; `endByte` is end-line ending or
   column offset;
3. use columns when supplied by the tool, otherwise entire lines.

### 7.2 Symbol resolution

Then the generation's symbol index MUST identify the **enclosing symbol**: the smallest
symbol whose byte range fully contains the finding's byte range. Result rules:

- Exactly one smallest enclosing symbol ⇒ `symbolId`, `symbolFqn`, `symbolResolution: "symbol"`.
- No enclosing symbol (file preamble, configuration files, lockfiles, languages without
  `deep`/`structural` support) ⇒ `symbolResolution: "file_only"` with `symbolResolutionNote`
  (e.g. `"no_enclosing_symbol"`, `"language_support_text"`). The finding remains valid at file level.
- File absent from index (e.g. scanner-excluded but tool-analyzed) ⇒ `fileId` absent,
  `fileIdMissingReason` MUST be set (E4); no symbol resolution.
- A finding MUST NOT be silently dropped because resolution fails.

### 7.3 Severity normalization

Each tool severity maps to the shared scale `info | low | medium | high | critical`.
Mapping is versioned (`mappingVersion: "untangle-severity-map-v1"`), and the unchanged original
MUST remain in `severity.original`: normalization adds a view rather than replacing data.

Binding initial-adapter mapping (`untangle-severity-map-v1`):

| Tool | Original values | Normalized |
|---|---|---|
| Semgrep | `INFO` / `WARNING` / `ERROR` | `info` / `medium` / `high` |
| SonarQube | `INFO` / `MINOR` / `MAJOR` / `CRITICAL` / `BLOCKER` | `info` / `low` / `medium` / `high` / `critical` |
| Ruff | no own severity; rule prefix | `low`; security rules (`S…`) `medium` |
| Bandit | `LOW` / `MEDIUM` / `HIGH` | `low` / `medium` / `high` (Bandit confidence → `confidence`) |
| ESLint | `1` (warn) / `2` (error) | `low` / `medium` |
| jscpd | no severity | `info` |
| OSV-Scanner / Trivy | CVSS or `UNKNOWN`/`LOW`/`MEDIUM`/`HIGH`/`CRITICAL` | CVSS < 4.0 `low`, 4.0–6.9 `medium`, 7.0–8.9 `high`, ≥ 9.0 `critical`; `UNKNOWN` `info`; string values directly |
| Syft | produces no findings | — |

Changing the table MUST increment `mappingVersion`; existing persisted findings keep their
old version and are not rewritten (`architecture.md` §2.3: versioned data production).

### 7.4 Confidence

- If a tool supplies confidence (Bandit, Semgrep metadata), map it to `[0,1]`, with
  `basis: "tool"` and original in `confidence.original`.
- Otherwise the adapter assigns a documented default per rule class, `basis: "mapped"`.
  **Assumption:** default 0.8 for deterministic lint rules, 0.5 for heuristic SAST/duplication findings.
- `isHeuristic` MUST be `true` when a rule or engine is heuristic (taint heuristics,
  similarity detection); payload filters and gates MAY filter on it.

### 7.5 Why external findings never contribute to `ComplexitySnapshotV1` (X3)

Untangle metrics are **deterministic, versioned and reproducible from source alone**:
same input and `metrics_version` ⇒ same result, guarded by golden tests (`spec.md` §16,
`architecture.md` §2.3). External findings satisfy none of these properties: they depend
on tool version, ruleset, ruleset version, tool configuration and sometimes external
databases (CVE feeds), and can change without a source change. Adding them to
`ComplexitySnapshotV1` would mean:

- complexity deltas (`spec.md` §17.4) could express a tool update instead of a code change,
  producing false regressions in delta-first Quality Gates (`spec.md` §18.1);
- snapshots across dates and repositories would no longer be comparable;
- Complexity Engine golden tests would depend on external software.

`vision.md` §10 literally prohibits presenting “raw LLM assessments as objective quality
metrics,” not “third-party assessments”; the earlier misquote is corrected
(`docs/BUILD_PLAN.md` §13, correction 2026-09-04). Applying that principle to tool findings
is a deliberate **extension**, not a deduction. X3 rests on the argument above rather
than that quote: Untangle complexity values are deterministic, versioned and golden-tested
(`architecture.md` §2.3, §15.2), an external value is none of these, and mixing them would
destroy reproducibility and delta-first gates (`spec.md` §18.1).

External findings therefore remain evidence with separate identity and a separate filter
dimension (`ExternalFindingV1`), connected to the same entities but tracked separately.
Where an external tool measures the same quantity, it is a test-suite cross-check (X8,
section 13.3), never a second display value.

---

## 8. Security and operation

### 8.1 Network boundaries

- Managed extension containers MUST bind host ports only to `127.0.0.1` (loopback-only,
  `architecture.md` §23.3).
- **Assumption:** Initial-adapter default ports use `19000–19099` to avoid Qdrant
  (16333/16334) and Ollama (11434/11435) collisions; each manifest declares exact defaults,
  overridable through `hostPorts`.

### 8.2 Container rules

- Every managed container MUST carry `dev.untangle.managed=true` and
  `dev.untangle.extension=<extension_id>`.
- Privileged containers MUST NOT start; no extra capabilities, host networking or Docker
  socket mounts inside the extension.
- Only digest-pinned images (X6); mismatches yield `EXTENSION_IMAGE_MISMATCH`.
- Persistent named volumes (`untangle-ext-<id>-…`); automatic deletion is forbidden.
- Foreign containers, even with the same image, MUST NOT be stopped, changed or deleted;
  every mutating container operation MUST check the Untangle label.

### 8.3 Workspace access

- An extension receives only the workspace path or configured repository roots as mounts,
  never home/configuration directories or `.untangle/` caches outside its own run directory.
- The workspace mount MUST be read-only wherever supported (`readOnly: true` is the mandatory
  default). A writable mount requires manifest `writableReason` and MUST appear in
  `extensions status`.
- Tool-output paths MUST validate against workspace roots before normalization to
  `filePath`/`fileId` (no path traversal through manipulated output; `spec.md` §24).

### 8.4 Output is untrusted input

Tool output crosses a trust boundary (`architecture.md` §3.1) and MUST be treated like
MCP input: tolerate schema additions, validate values, check paths and bound sizes.
Finding content (messages, remediation hints) is stored as data and MUST NOT be
interpreted as commands, path sources or configuration.

### 8.5 Secrets

- Secrets such as SonarQube tokens come only from environment variables or the secret store;
  project configuration and manifests contain only environment-variable **names**.
- Secrets MUST NOT appear in effective configuration dumps, `extensions status`, logs,
  crash reports or run artifacts (`spec.md` §24, `architecture.md` §23.2); redaction MUST be tested.
- Processes receive secrets through environment variables, never CLI arguments (process lists are readable).

**Implementation 2026-09-10:** The private store is `<OS-user-data>/untangle/extension-secrets/<id>.json`,
outside all project roots. Directory and file belong to the user and have Unix modes `0700`
and `0600`; symlink files and overly broad permissions are rejected. Files bind values to
extension ID and HTTP endpoint. Nonempty environment values override configuration.
A complete environment override requires no stored values. `extensions configure <id>`
creates an empty template or shows the existing path and occupancy status.
`--from=<private-json-file>` imports an object keyed by declared secret names; output never contains values.

An optional `[setup]` process may generate missing credentials. License gates must be
satisfied and `--yes` set. The container must be healthy, running, Untangle-owned and
digest-matched. Setup targets only the declared loopback endpoint at the published port.
The provider process is external user data (X9), runs without a shell in the private user-data
directory and receives only `PATH`, `HOME`, `LANG`, declared secrets, `UNTANGLE_SETUP_URL` and
`UNTANGLE_SETUP_ID`. Its private stdout response is:

```json
{ "schemaVersion": 1, "secrets": { "declared-secret-name": "generated-value" } }
```


Untangle validates this response, writes it atomically with `0600` and uses it for the
subsequent analysis. An exclusive lock prevents concurrent token generation; existing
credentials are reused. A lock left after a hard interruption is reported with its path
and must be removed after inspection. The runtime cannot undo external token generation
if subsequent local writing fails.

`setupOnly = true` marks bootstrap credentials. They go only to the setup process, never
the analyzer or its HTTP authentication. Provider output is withheld entirely on errors.
`status` creates no tokens; `logs` redacts both stored and environment-provided values.

### 8.6 Extension network access

- Manifest `networkAccess` is binding: `none` ⇒ container without outgoing network
  (isolated `network_mode`); `loopback` ⇒ host loopback only; `internet` ⇒ outgoing access
  allowed (needed for OSV-Scanner/Trivy CVE databases).
- `internet` MUST be justified with `networkJustification` and shown in `extensions list`
  and `extensions status` before activation.

### 8.7 Tool telemetry

- Every manifest MUST declare whether the tool sends telemetry, metrics or phone-home data
  (`telemetry`, section 5.2), including its disabling mechanism.
- Untangle MUST **disable telemetry by default** wherever possible, through a flag,
  environment variable or configuration key applied by the adapter on every run, rather
  than requiring user action (`vision.md` §7.4, `spec.md` §24).
- If telemetry cannot be disabled, `extensions list`/`status` MUST disclose that, and
  activation requires the same explicit persisted acknowledgment as a `restricted`
  license gate (section 9.2 applied accordingly).
- Initial-adapter telemetry information is **research as of 2026-09-04** and must be
  verified before use. Known: Semgrep sends registry-ruleset metrics (`--metrics=off`,
  section 12.1); SonarQube sends daily server telemetry (`sonar.telemetry.enable=false`,
  section 12.2); Syft performs an update check (disableable by environment, section 12.9).
  This research found no telemetry for Ruff, Bandit, ESLint, jscpd, OSV-Scanner, Trivy,
  lizard or radon; manifests declare `telemetry.sendsTelemetry: false`, and each adapter
  MUST recheck when pinning a tool version. OSV.dev queries and Trivy database downloads
  are functional rather than telemetry traffic, governed by `networkAccess` (section 8.6).

### 8.8 Limits of `binary` mode

Sections 8.1–8.3 and 8.6 describe container mechanisms, but seven of ten initial adapters
prefer direct host `binary` invocation. The specification distinguishes enforcement from declarations:

**Technically enforced (MUST):**

- Invocation only through an argument array via `ProcessRunner`, never a shell; tool output
  is never interpreted as commands, path sources or configuration (section 8.4).
- Working directory is the workspace root; path arguments validate against workspace roots.
- Minimal environment: an allowlist (`PATH`, `HOME`, locale variables, tool-required `env`
  instance variables) plus only manifest-declared secrets, never Untangle's entire environment.
- Time budget with process termination through `AbortSignal` (section 10.2); bounded output
  (sections 5.4, 6.5); output remains untrusted (section 8.4).

**Declarative or best effort only (explicitly NOT enforced):**

- **Filesystem boundary:** A host process reads with the user's permissions. Workspace
  confinement (section 8.3) is an expectation of the tool in `binary` mode, not enforcement.
  Untangle applies no OS sandboxing (seccomp, sandbox profiles), which would be platform-specific,
  fragile and could break the tools.
- **Network boundary:** `networkAccess` is declarative in `binary` mode and enforced only
  for containers (`network_mode`, section 8.6).
- **Memory budget:** without cgroups, observation only (polling with best-effort termination);
  hard limits exist only through container memory limits.

**Why `binary` remains the default preference:** Docker MUST remain optional (`spec.md` §2.3).
Locally installed tools directly use project configuration/installation (ESLint, Ruff) and
start without pulling or provisioning. Trust equals the user's manual invocation of the
same tool: Untangle starts tools from validated manifests with adapter-constructed arguments,
never arbitrary commands. Users who need the stronger boundary force it with
`perExtension.<id>.invocation: ["container"]` (section 5.6), overriding manifest preferences.
With effective `binary` mode, `extensions list` and `status` MUST disclose that network
and filesystem boundaries are declarative.

---

## 9. License gate

### 9.1 Declaration

Every manifest declares `license` (SPDX ID, `usageRestriction`, summary, URL) and
`requiresLicenseAcknowledgment`. `usageRestriction: "restricted"` means tool use has
conditions beyond ordinary open-source licensing, such as open-source-project-only use,
commercial-use prohibitions or a required account. CodeQL is a prominent example: its CLI
terms restrict analysis outside specified cases, particularly outside public open-source
repositories. A CodeQL adapter MUST therefore declare `usageRestriction: "restricted"`
and `requiresLicenseAcknowledgment: true` (section 12.11). The second mandatory case,
among initial adapters, is SonarQube: analyzers bundled in Community Build use Sonar
Source-Available License v1.0 (SSALv1; section 12.2; research as of 2026-09-04, verify before use).

### 9.2 Acknowledgment

- Before the first run of an extension with `requiresLicenseAcknowledgment: true`, explicit
  user acknowledgment MUST exist. Otherwise ⇒ `EXTENSION_LICENSE_UNACKNOWLEDGED`, no start or pull.
- Acknowledge interactively through `untangle extensions enable <id>` or explicitly with
  `--acknowledge-license` in noninteractive environments and CI.

**Fallback for unresolved ruleset identity (addition to section 5.4).** If a registry ruleset
provides neither resolved content (for `rulesetHash`) nor a registry version, the run MUST
set `rulesetVersion: "unresolved"`, `rulesetHash: null` **and** `comparabilityLimited: true`
with a reason. It MUST NOT serve as a delta baseline under section 11.5; change analysis
MUST skip it and report why. Silent comparison against unknown rules is forbidden because
it would present rule changes as code changes (E4: make uncertainty visible).

**Ruleset gate in the interface (addition to section 9.5).** The ruleset gate is separate
from the tool gate and applies even with tool `usageRestriction: 'none'`, commonly Semgrep
with default `p/ci`. It MUST therefore have its own acknowledgment path:

- Interactive: `untangle extensions enable <id>` asks for tool and ruleset acknowledgment
  **separately**, naming source and license per ruleset.
- Noninteractive: repeatable `--acknowledge-ruleset <ruleset-id>` acknowledges exactly one
  ruleset. `--acknowledge-license` acknowledges **only** the tool and does NOT replace the ruleset gate.
- `untangle extensions run <id> --ruleset <r>` with an unacknowledged ruleset MUST fail with
  `EXTENSION_LICENSE_UNACKNOWLEDGED` and name the exact acknowledgment command in its error.
- Acknowledgment is stored per `(extensionId, rulesetId, rulesetLicense)`. A ruleset license
  change invalidates it and MUST require acknowledgment again.

This makes the section 9.2 CI case achievable for default rulesets without weakening the gate.

- Acknowledgment MUST persist in the **OS-specific user-data directory** (Linux:
  `$XDG_DATA_HOME/untangle/` or `~/.local/share/untangle/`; macOS:
  `~/Library/Application Support/untangle/`; Windows: `%APPDATA%\untangle\`), in
  `extensions/license-acknowledgments.json`. Each entry contains `extensionId`, optional
  `ruleset` (section 9.5), `spdxId`, `restrictionSummary` hash, `acknowledgedAt`,
  `acknowledgedBy` (OS username). The `.untangle/` fallback from `spec.md` §2.1 explicitly
  does NOT apply: project state can be committed, inheriting acknowledgments to teammates
  and making the gate bypassable.
- Acknowledgment MUST NEVER be read from a project directory, including `.untangle/`, even
  when a same-named file exists. Such a file MUST be ignored with a warning. Acknowledgment
  is a personal user declaration, not shareable project state.
- A manifest `restrictionSummary` hash change MUST require renewed acknowledgment.

### 9.3 Revocation

`untangle extensions disable <id> --revoke-license` MUST invalidate acknowledgment; gate
state becomes `revoked` and another run requires fresh acknowledgment. `extensions status`
MUST show `not_required | acknowledged | unacknowledged | revoked`.

**Correction 2026-09-07 (Wave 10).** The original text required *removing* the entry and
simultaneously reporting `revoked`. Both cannot hold: a deleted row retains no memory,
leaving only `unacknowledged` and making this section's second sentence unreachable.
Revocation therefore writes `revokedAt` into the existing entry instead of deleting it.
Security is unchanged—both deny execution—but the user can distinguish never acknowledged
from acknowledged then withdrawn. `untangle extensions remove <id>` still deletes the row:
the extension and the declaration's subject disappear together.

### 9.4 AGPL boundary

Untangle is AGPL-3.0-only (E1). Analyzer extensions preserve the licensing boundary because
Untangle **neither bundles nor links** external code:

- Tools run as separate processes, containers or HTTP services (X4), exchanging only
  serialized data across process/network boundaries. This is aggregation of separate
  programs rather than a combined work: Untangle's AGPL does not extend to tools, nor do
  tool licenses extend to Untangle. Specific licensing assignments—LGPL for SonarQube core
  and Semgrep OSS engine, SSALv1 for bundled SonarQube analyzers, restrictive CodeQL and
  registry-ruleset terms—are **research as of 2026-09-04 and must be verified before use**,
  as in sections 9.1, 12.2 and 12.11. The aggregation argument does **not** depend on a
  particular tool license, provided the process/network boundary is preserved. Misjudging
  a tool license therefore affects lawful use of that tool rather than Untangle's AGPL
  status; the license gate addresses that risk.
- Users pull container images at runtime; Untangle does not distribute them. Releases
  contain only native adapters (output parsers) and manifests (data).
- Adapters in `packages/extensions` are entirely native code (clean room, `vision.md` §14,
  `architecture.md` §2.4) and read only documented output formats.

The license gate additionally protects **users** against unknowingly violating tool terms
through Untangle (X5).

### 9.5 Ruleset gate

The license gate applies per **ruleset** as well as per tool:

- If a run resolves `usageRestriction: "restricted"` rules (declared in `rulesetSources`,
  section 5.2, or conservatively assumed for undeclared registry rulesets), explicit
  acknowledgment MUST precede the first run, even when the tool is `usageRestriction: "none"`
  and explicitly for an unchanged `defaultRuleset` (Semgrep `p/ci`, section 12.1).
  Without it ⇒ `EXTENSION_LICENSE_UNACKNOWLEDGED`, no start or rule download.
- Acknowledgments persist per `(extensionId, ruleset)` in the same section 9.2 file (`ruleset`
  field); location, reacknowledgment after changed `restrictionSummary` and revocation follow
  sections 9.2 and 9.3 unchanged.
- Local rule files (`rulesetPaths`) trigger NO gate: users supply them and bear licensing responsibility.

---

## 10. Resource policy and concurrency

### 10.1 Display before startup

Before first provisioning, manifest resource guidance MUST be displayed: minimum/recommended
RAM, CPU recommendation, typical startup time and network access. Interactive contexts MUST
request confirmation. Noninteractive contexts (CI, MCP `background`) treat existing `enable`
configuration as confirmation; explicit `enable` preserves X1.

### 10.2 Per-run budgets

- Every run has a **time budget** (`timeoutMs`; **Assumption:** default 900000 ms = 15 minutes)
  and **memory budget** (`memoryLimitMb`; default manifest `recommendedMemoryMb`, enforced
  as a container memory limit for containers).
- Timeout ⇒ cancellation through `AbortSignal` (kill process or stop the run process,
  not the server container), and `EXTENSION_TIMEOUT`.
- Memory exceeded (container/process OOM kill) ⇒ `EXTENSION_FAILED` with
  `details.reason = "memory_limit_exceeded"`.
- Every public extension API MUST accept `AbortSignal` (`spec.md` §22); cancellation MUST
  leave `ExtensionRunV1` with `exitStatus: "cancelled"`.

### 10.3 Concurrency — the core index is never blocked

- Extension runs are separate scheduler jobs (`packages/jobs`) with their own job type
  and lock namespace `extension:<workspace_id>:<extension_id>`.
- An extension run MUST NOT hold or request the index lock (`spec.md` §12.3). It reads
  symbol index and File Manifests only from the last **completed** `indexGenerationId`.
- Extension jobs continue during full/update indexing; normalization binds to the generation
  fixed at startup. A newer generation appearing during the run adds `staleGeneration`
  warning rather than cancelling it.
- **Assumption:** Default concurrency is one extension run per workspace (configurable),
  keeping memory budgets predictable; index jobs take priority in resource contention.
- Runs are exclusive per extension (lock); two simultaneous runs of the same extension
  in one workspace ⇒ `LOCK_HELD`.

---

## 11. Interface

### 11.1 CLI

New command group (global `spec.md` §20.1 options apply, especially `--format`):

```text
untangle extensions list [--category <c,...>] [--available-only]
untangle extensions enable <id> [--acknowledge-license] [--acknowledge-ruleset <ruleset-id>] [--set <key>=<value> ...]
untangle extensions disable <id> [--revoke-license] [--remove-container] [--remove-volumes]
untangle extensions status [<id>]
untangle extensions configure <id> [--from=<private-json-file>]
untangle extensions setup <id> --yes
untangle extensions run <id> [--repo <id,...>] [--ref <name,...>] [--project <id>]
                             [--paths <glob,...>] [--ruleset <name>]
                             [--timeout <ms>] [--memory-limit <mb>]
                             [--background] [--yes]
untangle extensions logs <id> [--run <runId>] [--follow] [--tail <n>] [--since <ts>]
```


Requirements:

- `list` shows each extension's ID, displayName, category, invocation modes, availability,
  license and `usageRestriction`, `networkAccess`, resource guidance and enabled state.
- `enable` writes `extensions.enabled` and performs required license acknowledgment;
  it starts **no** container (X1). `--set` writes `perExtension.<id>` values (e.g. `--set ruleset=p/ci`).
- `disable` removes the entry; `--remove-container` stops/removes only Untangle-labeled
  containers with matching `dev.untangle.extension`; `--remove-volumes` needs additional
  destructive-action confirmation. Without these flags, containers remain stopped and volumes remain.
- `status` returns `ExtensionHealthV1` plus latest `ExtensionRunV1`: endpoints, image digest
  and comparison, license state, last successful run, with secrets redacted.
- Before required provisioning, `run` shows resource guidance and asks; `--yes` provides
  noninteractive confirmation. `--background` returns a job ID immediately; progress through
  `untangle status --job <id>`.
- `logs` reads only owned container/run logs, verified by labels.
- `setup --yes` uses the same path as `run --yes`: provision service, generate missing
  credentials through `[setup]`, then verify through analysis. `scan --yes` follows the
  same path for enabled extensions. Credential-setup failure appears as `setup_failed`
  with configuration guidance.
- Exit codes follow the general `untangle` CLI, not Quality Gates: `0` success; `1`
  operational failure (invalid manifest, missing extension, failed run); `2` usage error;
  `4` environment not ready, explicitly including `EXTENSION_LICENSE_UNACKNOWLEDGED`, since
  an open gate is missing environment state rather than a run error; `130` cancelled.
  Findings never change exit codes (X3).

  **Correction 2026-09-07 (Wave 10).** Earlier text assigned `2` to infrastructure errors
  and cited `spec.md` §18.3, which governs **Quality Gates** (`0 = passed`, `1 = gate failed`),
  not the general CLI, where `2` means usage errors. This text now follows actual binary
  output, measured with an open license gate on `untangle extensions run`: exit `4`.

### 11.2 MCP tools

Two new tools (envelope under `spec.md` §21.2):

```text
untangle_extensions
untangle_extension_run
```


#### `untangle_extensions`

```ts
interface ExtensionsInputV1 {
  workspaceId?: string;
  extensionId?: string;          // restrict to one extension
  includeHealth?: boolean;       // default true (runs detect/health read-only)
  includeLastRun?: boolean;      // default true
}

interface ExtensionsResultV1 {
  schemaVersion: 1;
  extensions: {
    manifest: ExtensionManifestV1;
    enabled: boolean;
    health?: ExtensionHealthV1;
    lastRun?: ExtensionRunV1;
  }[];
  warnings: string[];
}
```


`untangle_extensions` is read-only: it MUST NOT start containers or pull images.

#### `untangle_extension_run`

```ts
interface ExtensionRunInputV1 {
  extensionId: string;
  workspaceId?: string;
  repositories?: string[];
  refs?: string[];
  projectId?: string;
  paths?: string[];              // globs, workspace-validated
  ruleset?: string;
  timeoutMs?: number;
  background?: boolean;          // default true: return jobId immediately
}

interface ExtensionRunResultV1 {
  schemaVersion: 1;
  jobId?: string;                // when background
  run?: ExtensionRunV1;          // when completed synchronously
  warnings: string[];
}
```


MCP safety (addition to `spec.md` §21.3): `untangle_extension_run` starts processes/containers
and is therefore mutating for scope-display purposes; its text segment MUST name extension,
invocation mode and analysis scope. It does not violate the arbitrary-external-command ban:
only extensions from validated manifests with pinned digests or known binaries can start;
adapters construct commands and arguments, never callers. Unacknowledged gates yield
`EXTENSION_LICENSE_UNACKNOWLEDGED`. MCP cannot acknowledge the gate (CLI only, deliberate:
acknowledgment is a user declaration, not an agent step).

### 11.3 Programmatic API

`@untangle-code/core` SHOULD add (all methods with `AbortSignal`):

```ts
interface UntangleEngine {
  // existing methods from spec.md §22 …
  listExtensions(request: ExtensionsInputV1): Promise<ExtensionsResultV1>;
  runExtension(request: ExtensionRunInputV1): AsyncIterable<JobEvent>;
}
```


### 11.4 Query interface integration

`untangle query` (query-v1) and `SearchRequestV1` gain finding filters:

```text
--finding <tool>[:<ruleId>]     only hits with at least one matching finding
--severity <min>                only hits with a finding >= normalized minimum severity
--has-findings                  only hits with at least one external finding
```


```ts
interface SearchRequestV1 {
  // existing fields from spec.md §13.1 …
  findings?: {
    tool?: string;
    ruleId?: string;
    minSeverity?: NormalizedSeverity;
    hasFindings?: boolean;
  };
}
```


Execution rules:

- Filtering MUST run as store payload filters rather than after retrieval in memory:
  first read matching `symbol_id`/`file_id` sets from `{prefix}findings_v1` through payload
  filters, then pass them to code queries.
- Finding-filtered hits MUST report associated findings or severity counts, including
  `tool`, `ruleId` and `extensionRunId` provenance.
- Findings from an older `indexGenerationId` than the search MUST yield a staleness warning
  (X2 degradation, not an error).
- If a required extension never ran, return empty results with `no_extension_run_for_tool`
  warning: not found ≠ infrastructure error.

### 11.5 Change analysis integration

`untangle changes analyze` MUST report new and removed external findings per matched symbol
(`spec.md` §17.3 cascade) when comparable Base and Head runs exist:

```ts
interface ExternalFindingDeltaV1 {
  schemaVersion: 1;
  tool: string;
  toolVersion: { base: string; head: string };
  rulesetVersion?: { base?: string; head?: string };
  rulesetHash?: { base?: string; head?: string };  // section 5.4: content hash of the resolved rules
  comparable: boolean;               // false when toolVersion, rulesetVersion or rulesetHash differ
  caveats: string[];                 // e.g. "toolVersion differs; delta may reflect tool changes"
  newFindings: ExternalFindingV1[];  // matchKey present in head, absent in base
  resolvedFindings: ExternalFindingV1[]; // matchKey present in base, absent in head
}
```


- Compare through `finding_match_key` (section 4.3), not line numbers.
- Different `toolVersion`, `rulesetVersion` or `rulesetHash` between Base and Head MUST set
  `comparable: false` with a caveat. Display the delta but mark it as possibly tool/ruleset-
  driven. `rulesetHash` distinguishes silent local rule changes without version numbers
  from code changes.
- When one side lacks a run, omit the delta with a visible `extensionsUnavailable[]` note,
  never silently (X2, E4).
- External findings do NOT contribute to `untangle-risk-v1` (X3); they form a separate
  section alongside Risk Score.

### 11.6 Quality Gate integration

`QualityGateConfig` (`spec.md` §4.7) gains an optional rule group:

```ts
interface ExternalFindingsGateConfig {
  mode: "off" | "warn" | "fail";           // default "off"
  tools?: string[];                        // restrict to specific tools; default: all with runs
  maxNewFindings?: Partial<Record<NormalizedSeverity, number>>;
  ignoreExistingFindings: boolean;         // default true (delta-first, spec.md §18.1)
  requireComparableRuns: boolean;          // default true: incomparable runs => "incomplete"
}
```


- `ignoreExistingFindings: true` counts only **new** findings (`ExternalFindingDeltaV1.newFindings`).
- Every externally sourced gate violation MUST carry `tool`, `ruleId`, normalized/original
  severity and symbol/file reference.
- If runs are missing or incomparable and `requireComparableRuns` is `true`, gate state is
  `incomplete` (`spec.md` §18.2), not `failed`: infrastructure problems must not falsify a gate judgment.

### 11.7 Docker integration

Compose fragments live as separate opt-in files under `docker/extensions/<id>.yml`
(owned by WP-71 within apps/cli's `docker/` ownership). Every fragment MUST mirror digest
pinning, loopback ports, labels, named volumes and healthcheck from the manifest: the
manifest is normative; the fragment is derived.

---

## 12. Initial adapters

Each adapter is native Untangle code (`packages/extensions/src/adapters/<id>`), versioned
through `adapterVersion`, with golden tests against real committed tool output (section 13.1).
License and telemetry details below are **research as of 2026-09-04** and MUST be verified
before first use against the terms current when pinning a version; manifests declare the
verified state. Where an image digest is required, `sha256:<RESOLVE-BEFORE-USE>` is a
placeholder and MUST be replaced before first use with the chosen version's actual digest.

### 12.1 Semgrep (`semgrep`, category `sast`)

- **Invocation:** `binary` if in PATH, otherwise `container` (`semgrep/semgrep@sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** `semgrep scan --json` (objects with `check_id`, `path`, `start`/`end` line,
  column and offset, `extra.severity`, `extra.message`, `extra.metadata.confidence`).
- **Mapping:** `check_id` → `ruleId`; use byte offsets directly where present, otherwise
  line/column → byte range (section 7.1); symbol resolution through the symbol index—the
  finding belongs to the enclosing symbol, not merely the file. Configurable ruleset
  (`p/ci` as `defaultRuleset`, local rules through `rulesetPaths`).
- **License (research 2026-09-04; verify before use):** Engine LGPL-2.1 (Semgrep OSS/opengrep
  lineage), engine `usageRestriction: none`. Registry rulesets (`p/…`), including default
  `p/ci`, use **Semgrep Rules License v1.0** (internal business use only; prohibition against
  competing SaaS offerings). The manifest MUST declare rule sources **per ruleset** in
  `rulesetSources`, including `p/ci` as `usageRestriction: "restricted"`. The first restricted
  ruleset run, explicitly including the unchanged default, triggers the ruleset gate
  (section 9.5). **Reasoned decision:** `p/ci` remains default rather than substituting an
  unrestricted ruleset: no equivalent unrestricted set exists, and a silently weaker
  default would misrepresent coverage. An honest first-run gate is preferable to silent
  degradation. Local `rulesetPaths` are treated as user-licensed and trigger no gate.
- **Telemetry:** Registry rulesets send metrics to semgrep.dev by default (research
  2026-09-04); the adapter MUST set `--metrics=off` (section 8.7).
- **Resources:** minimum 512 MB, recommended 1024 MB RAM, 1 CPU.
- **Limits:** OSS cross-file/taint analysis is limited; findings are rule-based heuristics
  (`isHeuristic` per rule class). `networkAccess: "internet"` is required only for runtime
  registry-ruleset downloads (`p/…`); local rules use `none`.

### 12.2 SonarQube (`sonarqube`, category `quality-platform`)

- **Invocation:** `container` server (`sonarqube@sha256:<RESOLVE-BEFORE-USE>`, Community
  Build) plus scanner (`sonar-scanner-cli@sha256:<RESOLVE-BEFORE-USE>`); alternatively
  `http` to an existing server.
- **Output:** Web API JSON (paginated `/api/issues/search`: `rule`, `severity`, `component`,
  `textRange`, `message`; `/api/qualitygates/project_status` for the platform gate).
- **Mapping:** `rule` → `ruleId` (e.g. `typescript:S1067`); `textRange` lines/offsets →
  byte range → symbol; `severity` follows table 7.3. SonarQube's own quality gate is run
  information (`ExtensionRunV1` artifact `report`), NOT an Untangle gate result. Tokens
  come from environment (`UNTANGLE_EXT_SONAR_TOKEN`), never project configuration.
- **License (research 2026-09-04; verify before use):** distinguish components. SonarQube
  **core** (server without analyzers) is LGPL-3.0. SonarSource moved **bundled analyzers**—the
  actual rule and scanning engine—to **Sonar Source-Available License v1.0 (SSALv1)** on
  2024-11-29, a restrictive non-OSI license comparable to CodeQL's situation. Because every
  useful run executes analyzers, manifests MUST declare `license.spdxId: "NOASSERTION"`
  (mixed licensing; distinguish core and analyzers in `restrictionSummary`),
  `license.usageRestriction: "restricted"`, `requiresLicenseAcknowledgment: true`. The gate
  is mandatory like CodeQL's (section 12.11). Earlier blanket “Community Build LGPL-3.0”
  declarations in this document were incorrect.
- **Telemetry/network:** SonarQube sends daily telemetry to SonarSource by default (project
  characteristics, finding counts; research 2026-09-04). The manifest MUST fix
  `sonar.telemetry.enable=false` in `container.environment` (section 8.7) and declare
  `networkAccess: "loopback"`: scanner/Untangle reach the server only through loopback,
  and local operation needs no outgoing internet; isolate the container accordingly (section 8.6).
- **Resources:** minimum 2048 MB, recommended 4096 MB RAM, 2 CPUs; typical startup 60–120 s;
  persistent embedded-database volume (**Assumption:** embedded DB suffices for local v1;
  external Postgres is outside `extensions-v1`). `keepRunning: true` is the useful mode.
- **Limits:** Community Build branch/PR analysis is limited; runs bind to the main project
  state. SonarQube's cyclomatic/cognitive values serve as X8 cross-checks, NOT imported
  `ExternalFindingV1` (only rule-based issues are imported). **Assumption:** default host port 19000.

### 12.3 Ruff (`ruff`, category `lint`, languages: Python)

- **Invocation:** `binary`, otherwise `container` (`sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** `ruff check --output-format json` (`code`, `filename`, `location`/
  `end_location` with `row`/`column`, `message`, `fix`).
- **Mapping:** `code` → `ruleId`; optional `fix` → `remediationHint`; severity follows
  table 7.3. Existing `pyproject.toml`/`ruff.toml` MUST be reused where present.
- **License:** MIT.
- **Resources:** minimum 128 MB, recommended 256 MB RAM, 1 CPU; very fast.
- **Limits:** lint only, no dataflow analysis; `networkAccess: "none"`.

### 12.4 Bandit (`bandit`, category `sast`, languages: Python)

- **Invocation:** `binary`, otherwise `container` (`sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** `bandit -f json` (`test_id`, `issue_severity`, `issue_confidence`, `filename`,
  `line_range`, `issue_text`).
- **Mapping:** `test_id` → `ruleId`; `issue_severity` follows table 7.3; `issue_confidence`
  → `confidence` (`basis: "tool"`; HIGH/MEDIUM/LOW → 0.9/0.6/0.3, **Assumption**);
  `isHeuristic: true` for all findings.
- **License:** Apache-2.0.
- **Resources:** minimum 128 MB, recommended 512 MB RAM, 1 CPU.
- **Limits:** known high false-positive rate makes separate confidence mandatory;
  `networkAccess: "none"`.

### 12.5 ESLint (`eslint`, category `lint`, languages: JS/TS/JSX/TSX)

- **Invocation:** `binary`, preferring the **project-installed** instance
  (`node_modules/.bin/eslint`) to reuse configuration and plugins; container fallback
  only without a project installation.
- **Output:** `eslint -f json` (per-file `messages[]`: `ruleId`, `severity`, `line`, `column`,
  `endLine`, `endColumn`, `message`, `fix`).
- **Mapping:** `ruleId` including plugin prefix → `ruleId`; severity 1/2 follows table 7.3;
  presence of `fix` → `remediationHint`.
- **License:** MIT; plugins may differ and belong to the user's project, not Untangle.
- **Resources:** minimum 512 MB, recommended 1024 MB RAM (type-aware rules use substantial
  memory), 1 CPU.
- **Limits:** Project ESLint executes workspace code (JavaScript configuration/plugins).
  This is the same trust level as a local user build, but MUST be disclosed in
  `extensions list`; container execution uses the read-only workspace mount.

### 12.6 jscpd (`jscpd`, category `lint`)

- **Invocation:** `binary` (npx/project installation), otherwise `container`
  (`sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** JSON reporter (`duplicates[]` with `firstFile`/`secondFile`, each with
  `start`/`end`, `format`, `lines`, `tokens`).
- **Mapping:** Each duplicate produces **two** `ExternalFindingV1`, one per location,
  referencing each other in `message`; `ruleId = "duplicate-code"`, severity `info`,
  `isHeuristic: true` (token similarity).
- **License:** MIT.
- **Resources:** minimum 256 MB, recommended 512 MB RAM, 1 CPU.
- **Limits:** token-based duplication detection misses semantically identical but textually
  different blocks; `networkAccess: "none"`.

### 12.7 OSV-Scanner (`osv-scanner`, category `dependencies`)

- **Invocation:** `binary`, otherwise `container` (`sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** `osv-scanner --format json` (`results[].packages[].vulnerabilities[]` with
  `id`, `summary`, CVSS `severity`, package and lockfile source).
- **Mapping:** Findings bind to **manifest/lockfile** (`filePath` = lockfile), never symbols
  (`symbolResolution: "file_only"`, note `"dependency_finding"`); `id` (e.g. `GHSA-…`) →
  `ruleId`; CVSS follows table 7.3; affected package/version range in `message`.
- **License:** Apache-2.0.
- **Resources:** minimum 128 MB, recommended 256 MB RAM, 1 CPU.
- **Limits:** `networkAccess: "internet"` for OSV.dev queries MUST be declared and justified;
  offline only with a local database snapshot. Scanner results do not assess whether
  vulnerable code is actually called; graph connection is Untangle's value, but v1 remains
  at file level (import evidence, file/project binding under section 2.2), **Assumption**.

### 12.8 Trivy (`trivy`, category `dependencies`)

- **Invocation:** `binary`, otherwise `container` (`aquasec/trivy@sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** `trivy fs --format json` (`Results[].Vulnerabilities[]` with `VulnerabilityID`,
  `Severity`, `PkgName`, `InstalledVersion`, `FixedVersion`).
- **Mapping:** OSV-Scanner-style manifest/lockfile `file_only` binding;
  `VulnerabilityID` → `ruleId`; `FixedVersion` → `remediationHint`; severity strings follow table 7.3.
- **License:** Apache-2.0.
- **Resources:** minimum 512 MB, recommended 1024 MB RAM (in-memory vulnerability DB), 1 CPU.
- **Limits:** first-run database download of several hundred MB (`networkAccess: "internet"`),
  persistent database volume. Overlap with OSV-Scanner is deliberate; both opt-in, neither default.

### 12.9 Syft (`syft`, category `sbom`)

- **Invocation:** `binary`, otherwise `container` (`anchore/syft@sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** CycloneDX JSON preferred, or SPDX JSON.
- **Telemetry:** Syft checks for updates at startup by default (research 2026-09-04);
  the adapter MUST disable this with `SYFT_CHECK_FOR_APP_UPDATE=false` (section 8.7).
- **Mapping:** Syft creates **no findings**, only an SBOM: `findingsTotal: 0` and
  `{ kind: "sbom", format: "cyclonedx-json" }` in `ExtensionRunV1.artifacts`. The portfolio
  pillar MAY read it as additional evidence (`evidenceKind: "container"`-analogous
  provenance; integration section 15.5).
- **License:** Apache-2.0.
- **Resources:** minimum 256 MB, recommended 512 MB RAM, 1 CPU.
- **Limits:** SBOM quality depends on ecosystem catalogers; `networkAccess: "none"`.

### 12.10 lizard / radon (`lizard`, `radon`, category `complexity`) — X8 cross-check

- **Invocation:** `binary` (pip installation), otherwise `container` (`sha256:<RESOLVE-BEFORE-USE>`).
- **Output:** lizard CSV/XML (per function: file, name, start line, CCN, NLOC); radon `cc -j`
  (per-file JSON: functions with `complexity`, `lineno`, `endline`).
- **Mapping:** These adapters produce **no** `ExternalFindingV1`. Values go only to the
  cross-check suite (section 13.3): match functions by file + line range to Untangle symbols
  and compare `cyclomatic_classic`. External complexity values are not persisted and appear
  in no query response; parallel complexity numbers would be precisely the mixing X3 forbids.
- **License:** lizard MIT; radon MIT.
- **Resources:** minimum 128 MB, recommended 256 MB RAM, 1 CPU.
- **Limits:** lizard CCN has its own documented, slightly different definition (e.g. `case`
  branches and logical operators). The suite MUST use documented tolerances and a
  per-language difference explanation table instead of requiring equality.

### 12.11 Mandatory license-gate cases: CodeQL and SonarQube

CodeQL is **not** an initial `extensions-v1` adapter, but is normatively retained as a planned
case requiring the gate: CodeQL CLI terms essentially limit analysis to public open-source
repositories or appropriately licensed GitHub use. Its manifest MUST declare
`license.usageRestriction: "restricted"`, `requiresLicenseAcknowledgment: true` and a
`restrictionSummary` naming the restriction. Without persisted acknowledgment the adapter
MUST never run (`EXTENSION_LICENSE_UNACKNOWLEDGED`), regardless of binary/container availability.

SonarQube is an initial adapter and the second mandatory case. Community Build analyzers
use SSALv1 (section 12.2; research 2026-09-04, verify before use). Its manifest MUST declare
`license.usageRestriction: "restricted"` and `requiresLicenseAcknowledgment: true`; without
persisted acknowledgment, neither server provisioning nor scanner execution may begin.
Rulesets with separate terms, particularly Semgrep default `p/ci`, additionally require
section 9.5's ruleset gate.

---

## 13. Test requirements

Unit tests use no network, Docker or installed tools (testkit ports, `docs/BUILD_PLAN.md`
build rules). Real-tool integration tests are separately marked `@integration` and skip
cleanly with a visible reason when the tool is absent.

### 13.1 Per-adapter golden tests

- At least one real committed tool output per adapter, produced by a fixture run with the
  tool version in its fixture name, and expected `ExternalFindingV1[]` including symbol
  assignment, normalized/original severity and provenance.
- Golden changes require review because they can change mapping meaning.

### 13.2 Behavioral tests (per adapter and runtime)

1. **Missing extension:** detect without binary/container/endpoint ⇒ `EXTENSION_UNAVAILABLE`;
   finding-filtered reads visibly degrade (`extensionsUnavailable[]`) rather than abort (X2).
2. **Budget exceeded:** simulated execution beyond `timeoutMs` ⇒ `AbortSignal`, process exits,
   `ExtensionRunV1.exitStatus = "timeout"`, `EXTENSION_TIMEOUT`; a concurrent index job
   continues uninterrupted (concurrency assertion, section 10.3).
3. **Broken output:** invalid JSON ⇒ `EXTENSION_FAILED`, `details.reason = "output_parse_failed"`;
   invalid entries in partial output are counted and recorded without losing valid entries (E4).
4. **Unknown fields:** additional output fields parse successfully while known fields remain
   correct (golden variant per adapter).
5. **License gate:** no acknowledgment ⇒ `EXTENSION_LICENSE_UNACKNOWLEDGED`, no process start
   (spy); after acknowledgment it runs; after revocation it does not; changed
   `restrictionSummary` invalidates acknowledgment.
6. **Digest check:** mismatched running-container digest ⇒ `EXTENSION_IMAGE_MISMATCH`, no run.
7. **Label protection:** `disable --remove-container` rejects unlabeled containers; volumes
   survive every teardown without explicit `--remove-volumes`.
8. **Secret redaction:** tokens appear in no status, log or configuration dump.
9. **Fake-extension lifecycle:** a testkit fake adapter completes `detect → … → teardown`
   without Docker (WP-67 acceptance).
10. **Symbol resolution:** findings within symbols bind to the smallest enclosing symbol
    with `symbolResolution: "symbol"`; preamble/unindexed-file findings follow documented
    `file_only`/`fileIdMissingReason` paths.
11. **Project-local acknowledgment ignored:** project `license-acknowledgments.json`, including
    under `.untangle/`, is demonstrably never read. Runs still require acknowledgment and
    warn about the ignored file (section 9.2).
12. **Ruleset gate:** unchanged Semgrep default `p/ci` without ruleset acknowledgment ⇒
    `EXTENSION_LICENSE_UNACKNOWLEDGED`, no process; local `rulesetPaths` run without a gate
    (section 9.5).
13. **Run provenance without findings:** zero-finding runs carry `ruleset` and
    `rulesetVersion`/`rulesetHash`; changing a local rule demonstrably changes `rulesetHash`
    (section 5.4).
14. **Telemetry disabled:** every run applies declared disabling mechanisms (argument/env spies:
    Semgrep `--metrics=off`, SonarQube `sonar.telemetry.enable=false`, Syft
    `SYFT_CHECK_FOR_APP_UPDATE=false`). Validation rejects `sendsTelemetry: true` with
    existing `disableMechanism` and `disabledByDefault: false` (sections 5.2, 8.7).

### 13.3 Cross-check suite (X8)

- Runs on required fixtures (at least `01-ts-monorepo`, `02-python-workspace`,
  `05-large-function`) with lizard and/or radon for Python as external measurement tools;
  marked skipped when tools are absent.
- Per function/symbol: file + line-range mapping, compare Untangle `cyclomatic_classic`
  against external CCN.
- Documented versioned tolerance/explanation table per language adapter, including known
  differences such as `case` branches, logical operators and comprehensions.
- **Systematic** differences—beyond tolerance without explanation, or constant bias across
  many symbols—are **test findings**. The suite writes JSON (symbol, both values,
  difference, explanation status) and exits nonzero. Reports inform `packages/complexity`
  hardening, never adoption of the external number.

### 13.4 Contract and interface tests

- MCP contracts for `untangle_extensions` and `untangle_extension_run` (envelope, errors,
  scope displayed in text).
- CLI snapshots for `extensions list|status|run` in `text` and `json`.
- Payload-filter test: `--finding`/`--severity` demonstrably create store filters rather
  than memory post-filters (`VectorStore` spy).
- Change delta: known Base/Head findings ⇒ correct per-symbol `newFindings`/`resolvedFindings`;
  differing `toolVersion` ⇒ `comparable: false` with caveat.
- Gate: new high finding with `mode: "fail"`, `maxNewFindings.high = 0` ⇒ `failed` violation
  including `tool`/`ruleId`; missing run with `requireComparableRuns` ⇒ `incomplete`.

---

## 14. Definition of Done for `extensions-v1`

The extensions pillar is functionally complete when:

1. `packages/extensions` implements the full `detect → provision → health → run → collect →
   normalize → teardown` lifecycle and all section 6.8 errors; the fake-adapter test passes
   without Docker (WP-67);
2. `untangle index` without extension configuration is byte-identical in behavior to before
   and no core capability requires extensions (X1, X2);
3. versioned `ExtensionManifestV1`, `ExternalFindingV1`, `ExtensionRunV1`, `ExtensionHealthV1`
   exist in `packages/domain` and validate against JSON schema;
4. Semgrep and SonarQube adapters (WP-68, WP-69) pass golden tests on real output, including
   symbol mapping and secret redaction;
5. at least Ruff, Bandit, ESLint, jscpd, OSV-Scanner, Trivy and Syft (WP-70) each pass a golden test;
6. X8 cross-check suite (section 13.3) runs and reports systematic differences as findings
   with nonzero exit;
7. tests prove license acknowledgment, persistence, renewed acknowledgment for changed
   restrictions and revocation (X5), including ruleset gating (section 9.5) and ignored
   project-local acknowledgments (section 9.2);
8. all container runs are loopback-only, label-checked, nonprivileged and digest-pinned,
   with `EXTENSION_IMAGE_MISMATCH` on mismatch (X6);
9. `untangle extensions list|enable|disable|status|run|logs` and both MCP tools work with
   versioned JSON contracts and show resource guidance before startup (WP-71);
10. `--finding`, `--severity`, `--has-findings` use store payload filters, change analysis
    reports per-symbol new/removed findings, and Quality Gates support external findings
    delta-first (X7, WP-72);
11. no external finding enters `ComplexitySnapshotV1`, complexity aggregates or
    `untangle-risk-v1` (X3, negative test);
12. extension runs demonstrably execute concurrently with indexing without blocking its
    progress (section 10.3);
13. every placeholder digest (`sha256:<RESOLVE-BEFORE-USE>`) is replaced by a real verified digest;
14. `docs/PARITY.md` B26–B29 can be assessed through self-executed runs (E5);
15. every initial-adapter manifest declares telemetry and tests prove disableable telemetry
    is disabled during execution (section 8.7, spies).

---

## 15. Integration into existing documents

This document does not change existing documents. The following additions are due at their
next revision:

### 15.1 `spec.md` (spec-v1 → spec-v1.1)

- **§4.2 Main schema:** add `extensions?: ExtensionsConfig;` to `UntangleConfigV1`,
  referencing `extensions.md` §5.6.
- **§10.1 Collection strategy:** add `{prefix}findings_v1`, created only after at least one
  extension run.
- **§10.4 Payload indexes:** add the indexes from `extensions.md` §5.7.
- **§13.1 Query Input:** add the `findings?` block from `extensions.md` §11.4 to `SearchRequestV1`.
- **§17.2 Change Entity:** add optional `externalFindingDeltas?: ExternalFindingDeltaV1[]`
  to `ChangeEventV1`.
- **§18 Quality Gates:** add `externalFindings?: ExternalFindingsGateConfig` to
  `QualityGateConfig` (§4.7), and `tool`/`ruleId` violations (§18.2).
- **§20.2 Commands:** add `untangle extensions list|enable|disable|status|run|logs`.
- **§21.1 Tool names:** add `untangle_extensions` and `untangle_extension_run`.
- **§21.3 MCP safety:** add “`untangle_extension_run` starts only extensions from validated
  manifests with pinned digests or known binaries; adapters construct commands and
  arguments, never callers.”
- **§25.1 Error classes:** add the five codes from `extensions.md` §6.8.
- **§27.2 Required fixtures:** add versioned real tool output per initial adapter.
- **§28 Definition of Done:** add analyzer extensions under `extensions-v1` (lifecycle,
  license gate, finding filters, cross-checks) as a Beta criterion.
- **§29 Out of scope:** clarify that an own SAST ruleset and a meta-linter/collection point
  for arbitrary tool output remain excluded.

### 15.2 `architecture.md` (architecture-v1 → v1.1)

- **§5 Monorepo structure:** add `packages/extensions` and `docker/extensions/`.
- **§6 Core modules:** describe Extensions Runtime (lifecycle, adapters, ports:
  `ProcessRunner`/container runtime behind a port boundary).
- **§3 System context / §3.1 Trust Boundaries:** add external analyzers with the boundary
  “tool output = untrusted input.”
- **§23.3 Managed Containers:** explicitly apply the same rules to extension containers,
  with additional label `dev.untangle.extension=<id>`.
- **§24 Observability:** add events and counters `extension_runs_total`,
  `extension_findings_total`, `extension_run_duration_ms`.

### 15.3 `product.md`

- **§5 Product surfaces:** add “Analyzer extensions—optional deep analysis through existing
  tools; distribution: Compose fragments + CLI `untangle extensions`.”
- **§2.4 Main differentiation:** add external findings connected to symbols, Blast Radius
  and change history, without external-product marketing comparisons (E2).
- **§4 User journeys:** add enabling deep analysis: enable → resource guidance → license
  gate → run → query filters.

### 15.4 `vision.md`

- **§7.1 Evidence-first:** add external findings with tool, rule and ruleset versions.
- **§10 Non-goals:** clarify that security SAST as the main product remains excluded;
  connecting existing SAST tools as evidence sources is unaffected.

### 15.5 `portfolio.md` (portfolio-v1 → v1.1)

- **§6 Technology inventory:** confirm quality tools (repository Semgrep/Ruff/ESLint/Sonar
  configuration) as a captured category and name `ExtensionRunV1` history as optional
  evidence (“which project uses which quality tools,” WP-72).
- **§13 Optional online enrichment:** note that Syft SBOM artifacts MAY provide local
  evidence without registry queries.

### 15.6 `docs/PARITY.md`

- Rows B26–B29 already exist; after WP-67 onward is implemented, status changes require
  a self-executed test run (E5).

---

## 16. Outside `extensions-v1`

- CodeQL adapter (only its license-gate behavior is specified, section 12.11);
- loading external adapter **code** as third-party extension plugins;
- central extension catalog or marketplace;
- automatically applying fixes from external findings;
- importing external complexity values as displayable metrics (X3, X8);
- orchestrating external tools across multiple machines;
- continuous background scans (extensions run on demand or through `runAfterIndex`,
  not as daemon watchers).

---

## 17. Addendum: analyzer extensions are outside the repository (X9)

**This addendum corrects sections 5 and 12.** The original design placed per-tool adapter
source in `packages/extensions/src/adapters/<tool>` and Compose fragments in
`docker/extensions/`. That was wrong.

### X9 — Untangle provides the runtime, not the tools

> **The extension runtime contains a manifest schema and a small set of format parsers,
> not tool parsers or external analyzer dependencies. An analyzer extension is an external
> artifact that the user deliberately loads.**

CLI setup adds an **optional setup catalog** to this runtime. It may name verified
installation sources and, after deliberate selection, generate local Compose recipes,
MCP templates or declarative format manifests. These offers are explicitly maintained CLI
product scope and require their own versions, digests, tests and documented limits.
Tools, rulesets and binaries themselves are neither distributed with Untangle nor linked.
Generated manifests pass the same project-trust, digest, license and credential gates as
manual imports. Neither cloning a repository nor noninteractive init enables these offers
automatically.

Rationale:

- **Optional means optional.** X1 requires deliberate selection and review; the setup catalog
  installs or starts nothing without a confirmed plan.
- **Clear licensing boundary.** A Compose fragment with SSALv1 analyzers or restricted
  rulesets does not belong in the AGPL repository. X4 continues to permit only process/network
  invocation. CLI offers replace neither license review nor separate usage permission.
- **Scale.** Otherwise every tool would require a repository change and release. Third
  parties can publish and maintain external extensions without inclusion or endorsement.
- **Clear responsibility.** Catalog recipes and generated format definitions are verified;
  external analyzer semantics, remote source freshness and finding correctness retain
  their external provenance.

### What remains in the repository

| Component | Location | Reason |
|---|---|---|
| Extension runtime (lifecycle, budgets, errors, normalization) | `packages/extensions` | native Untangle functionality |
| Versioned **manifest schema** | `packages/extensions` + `schemas/` | contract for third-party authors |
| **Format parsers**, not tool parsers | `packages/extensions/src/formats` | see below |
| License gate, telemetry requirement, sandbox | `packages/extensions` | safety and licensing mechanics |

### Format parsers instead of tool adapters

The decisive boundary: Untangle knows **output formats**, not tools.

```text
sarif            SARIF 2.1.0 — Semgrep, CodeQL, Trivy and many others
junit-xml        test reports
generic-findings documented JSON schema with declarative field mapping
generic-metrics  measurements as a flat key/value list
```


A manifest says how to invoke, that output is SARIF, and how to map severity. This is
**pure data**; no external code runs inside Untangle. Tools without standard output
need a small manifest preprocessor command that transforms output to `generic-findings`;
that is the extension author's responsibility.

### Extension locations

```text
$XDG_DATA_HOME/untangle/extensions/<id>/manifest.toml    (Linux)
~/Library/Application Support/untangle/extensions/<id>/  (macOS)
%APPDATA%\untangle\extensions\<id>\                      (Windows)
```


Extensions can additionally be loaded from any directory with `--from <path>`.
A manifest **in a project directory** is explicitly **not** loaded automatically;
a cloned repository must not introduce a tool without consent. The same principle governs
license-acknowledgment storage (§9.2).

### Consequences for work packages

- **WP-68 through WP-70 and WP-104 no longer provide repository adapters.** Semgrep,
  SonarQube, Ruff, Bandit, Trivy, OSV, Syft, lizard/radon and Sentrux become
  **example manifests**, documented and created by users rather than source code here.
- **New WP-108:** `sarif`, `junit-xml`, `generic-findings`, `generic-metrics` format parsers
  with declarative field mapping.
- **New WP-109:** `untangle extensions add --from <path>` / `remove`, manifest-schema
  validation and loaded-extension listing with provenance.
- X8 cross-checks (Complexity, Acyclicity, Depth) remain valid: they run against user-loaded
  extensions and skip when none are loaded.

## Aggregate invocation: `untangle scan` (2026-09-10)

`scan` uses the same execution path as `extensions run`. It measures native complexity
and invokes enabled extensions; missing, denied, gated and failed extensions appear in
the report with reasons. Scan-wide `--yes` permits provisioning each enabled extension
with a container block. Resources and image appear on stderr beforehand. License gates
and digest checks remain independent of that consent.

`ownMetrics`, `externalSignals` and `notMeasured` remain separate JSON fields;
`comparableTo` creates no comparison columns. Every attempted run retains provenance,
status and diagnostics. Actual results are also saved as the last run in the user profile.
Individual extension failures do not change the completed report's exit code 0. Usage
errors, analysis errors and cancellation remain errors. See [SCAN.md](docs/SCAN.md).
