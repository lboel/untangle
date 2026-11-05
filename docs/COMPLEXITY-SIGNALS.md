<a id="komplexitätssignale-aus-fremden-werkzeugen"></a>

# Complexity signals from external tools

How Untangle accepts external analyzer values without confusing them with its own
metrics, and how monitoring is configured for this repository itself.

`extensions.md` is normative; this document is its operating guide.

<a id="das-problem-das-der-vertrag-löst"></a>

## The problem the contract solves

An external tool's measurement initially consists of a key and a number:

```json
{ "quality_signal": 0.4514, "cognitive_complexity": 4284 }
```

A system that knows only keys and numbers cannot distinguish these values.
`cognitive_complexity` measures the same kind of quantity Untangle computes, so a
cross-check can identify a difference. `quality_signal` is a proprietary composite
whose formula is not disclosed. Comparing it directly with an Untangle value
would assert equivalence between different mathematics.

`[[complexitySignals]]` in the manifest records this distinction.

```toml
[[complexitySignals]]
key = "cognitive_complexity"     # Unchanged output key from the tool
kind = "cognitive"               # From a closed set
scope = "repository"             # repository | file | symbol
comparableTo = "untangle-metrics-v1"

[[complexitySignals]]
key = "quality_signal"
kind = "proprietary-composite"   # comparableTo is rejected by validation
scope = "repository"
```

`kind` is one of `cognitive | cyclomatic | sloc | duplication | dependency-cycles |
dependency-depth | proprietary-composite`. `comparableTo` is the only way to
permit a cross-check (X8), and is forbidden for `proprietary-composite`.
`validateExtensionManifest` enforces this rather than relying on manifest authors.

Three rules apply independently:

- **An external value never becomes an Untangle metric** (X3). The parser returns
  `ExternalNumberV1`, which is structurally incompatible with metric fields.
- **Scope is as binding as meaning.** A value declared as file- or symbol-scoped
  but returned without a path does not receive that meaning; the omission is
  reported. Treating it as a file value would assert something the tool did not.
- **An undeclared key remains unnamed.** It is retained and usable as that tool's
  time series, without another claimed meaning.

<a id="ausgabeformen-die-das-manifest-beschreibt"></a>

## Output shapes described by the manifest

Untangle understands four formats (`sarif`, `junit-xml`, `generic-findings`,
`generic-metrics`) rather than individual tools (X9). The manifest describes a
tool's output shape without requiring a tool-specific branch in source code:

```toml
[outputMapping]
shape = "flat-object"              # Object: key = measurement, value = number
# Or:
container = "component.measures"   # Dot path to a web API's entry list
key = "metric"
value = "value"
```

`shape = "flat-object"` is declared, never inferred: the same object could be a
single `key`/`value` entry. Guessing would silently reinterpret the output,
contrary to E4.

<a id="zugang-zu-einer-geschützten-api"></a>

## Access to a protected API

```toml
[http]
authSecretName = "sonar-token"

[[secrets]]
name = "sonar-token"
envVar = "SONAR_TOKEN"
purpose = "API access with the issuing user's permissions"
required = true
```

The scheme is `Authorization: Bearer <value>`. Values come from the environment or
private user configuration, never from the manifest, and are redacted from
messages. Nonempty environment values take precedence. A missing or empty secret
produces no header; an empty bearer would pretend to authenticate the request.
An `authSecretName` without a matching `[[secrets]]` entry is rejected by validation.

<a id="automatische-einrichtung-und-konfiguration"></a>

### Automatic setup and configuration

Since 2026-09-10, the locally installed SonarQube extension has an external
`[setup]` provider. It creates a `USER_TOKEN` for the configured administrator
through SonarQube's API and verifies authentication. This token has that
administrator's permissions; the earlier description as read-only was wrong.
See [SonarQube: Managing tokens](https://docs.sonarsource.com/sonarqube-server/user-guide/managing-tokens).

```sh
untangle extensions setup sonarqube --yes
untangle scan --yes
```

Both commands provision the declared service and create credentials when missing.
`setup` additionally verifies the result with an analysis invocation. An existing
token is reused. Under X9, the provider remains outside this repository at
`~/untangle-extension-sources/sonarqube/setup.mjs`; the installed manifest points
to it.

A new local instance initially uses the
[initial credentials](https://docs.sonarsource.com/sonarqube-server/instance-administration/user-management/introduction).
For an existing instance, configure its administrator credentials:

```sh
untangle extensions configure sonarqube
```

The command creates a private JSON template and displays its path. On macOS this
is `~/Library/Application Support/untangle/extension-secrets/sonarqube.json`.
Its `secrets` object accepts either `sonar-token` directly, or `sonar-admin-user`
and `sonar-admin-password` for automatic token creation. Alternatively,
`configure sonarqube --from=/private/path/secrets.json` imports a JSON object with
these keys. The file and directory use permissions `0600` and `0700`; credentials
do not belong in project configuration.

`SONAR_TOKEN`, `SONAR_ADMIN_USER` and `SONAR_ADMIN_PASSWORD` override their stored
counterparts. Administrator credentials are marked `setupOnly = true` in the
manifest and are not passed to the analyzer. `status` creates no tokens. Failed
administrator authentication never changes a password; `setup_failed` names the
configuration step.

<a id="der-lauf-für-dieses-repository"></a>

## The run for this repository

Both manifests live outside the repository in the user profile at
`~/.untangle/extensions/<id>/manifest.toml`. This enforces X9: a bundled tool
definition would effectively become part of the product even if never executed.

```bash
untangle extensions add --from ~/untangle-extension-sources/sentrux/manifest.toml
untangle extensions enable sentrux
untangle extensions status sentrux
untangle extensions run sentrux --format json
```

<a id="strukturelle-kennzahlen-lokales-programm-mit"></a>

### Structural measurements (local program, MIT)

Invoked as a program with flat-object output; telemetry is declared in the
manifest and disabled locally. The 2026-09-07 run against this repository returned
ten measurements:

| Key | Value | Meaning |
|---|---:|---|
| `quality_signal` | 0.4514 | `proprietary-composite`; evidence, never comparable |
| `coupling_score` | 0.0138 | `proprietary-composite`; evidence |
| `cycle_count` | 3 | `dependency-cycles`, **eligible for cross-checking** |
| `max_depth` | 28 | `dependency-depth`, **eligible for cross-checking** |
| `complex_fn_count` | 89 | `cyclomatic`, tool threshold unknown → no `comparableTo` |
| `total_import_edges` | 2,608 | Undeclared; unnamed but retained |
| `cross_module_edges` | 621 | Undeclared |
| `god_file_count` | 2 | Undeclared |
| `hotspot_count` | 0 | Undeclared |
| `timestamp` | 1788795318 | Undeclared |

<a id="qualitätsplattform-container-von-untangle-bereitgestellt-eingeschränkte-lizenz"></a>

### Quality platform (Untangle-provisioned container, restrictive license)

The manifest describes both a `[container]` block for provisioning the service and
`invocation = ["http"]` for analysis. The container is the service; the API is the
measurement path.

```bash
untangle extensions enable sonarqube --acknowledge-license
untangle extensions run sonarqube --yes       # Provision and measure
untangle extensions status sonarqube          # Show pin and running digest
untangle extensions logs sonarqube --tail 50
untangle extensions disable sonarqube --remove-container
```

Untangle renders the Compose file from the manifest rather than executing
supplied YAML. This enforces X6: the previous profile file specified
`image: <repo>:community`, a mutable tag. A manifest digest would pin nothing if
the actual image were pulled by that tag. Rendering uses `image@digest`, binds
ports only to `127.0.0.1`, sets both labels and starts the container without
privileges or capabilities.

Without `--yes`, nothing starts; the cost is displayed instead:

```text
"sonarqube" needs a container to be provisioned before it can run.
  memory  at least 2048 MB, recommended 4096 MB
  cpus    recommended 4
  image   sonarqube@sha256:62930c7f…
```

**Ownership check.** `down` and `logs` never rely on the name alone.
`untangle-ext-<id>` is predictable, and a foreign container could use that name.
Both §8.2 labels are required; missing labels prevent action and produce a reason.

**The digest belongs to the extension, not its invocation path.** With
`invocation = ["http"]`, availability probing never enters the container branch,
which could leave the running container's pin unchecked. `status` and `run`
therefore inspect it independently of invocation mode:

```text
  pinned digest    sha256:62930c7f510534bb2bf551ca69ad3ee6f8e12b4116d394597c64cefccbb3313b
  running digest   sha256:62930c7f510534bb2bf551ca69ad3ee6f8e12b4116d394597c64cefccbb3313b (matches the pin)
```

A mismatch stops the run with `EXTENSION_IMAGE_MISMATCH` before measurement.

The 2026-09-08 Measures API run returned five measurements:

| Key | Value | Meaning |
|---|---:|---|
| `cognitive_complexity` | 13,640 | `cognitive`, **eligible for cross-checking** |
| `complexity` | 23,143 | `cyclomatic`, **eligible for cross-checking** |
| `ncloc` | 133,759 | `sloc`; evidence, no repository-wide Untangle SLOC comparison metric |
| `duplicated_lines_density` | 1.6 | `duplication`; evidence |
| `comment_lines_density` | 10.9 | Undeclared |

An open license gate prevents pulling, starting and endpoint access, including
probes.

<a id="warum-hier-noch-kein-delta-steht"></a>

## Why no delta is reported yet

Both measurement axes are machine-readable, but subtracting them would be
misleading. Own analysis reports cognitive **18,938** across 856 files, or
**16,361** excluding test/fixture paths; the platform reports **13,640**. A delta
would be meaningless for two reasons:

1. **Different corpora.** The 856 files differ from a scanner run over
   `packages,apps,scripts` with its own exclusions. Until the file sets match,
   the comparison measures exclusion rules rather than complexity.
2. **Different measurement scopes.** Execution-unit aggregation and summing every
   function are different quantities even when both are called cognitive complexity.

`comparableTo` permits a comparison of the measurement kind. It does not prove
that two particular runs are comparable. Matching corpora and reporting systematic
differences as test findings are WP-70 and remain outstanding; the own report
already provides a cross-check context section (X8).

<a id="was-hier-noch-nicht-steht"></a>

## What remains absent

- **The cross-check itself.** It first requires the same file set and measurement
  scope (X8, B28, WP-70).
- **Triggering a scan.** Untangle provisions the service and reads measurements;
  it does not yet initiate the scan producing them. That would be another
  extension with `invocation = ["container"]`.
- **Symbol-scoped measurements.** The values measured here are repository-wide.
  The contract already supports file- and symbol-scoped values, but no run has
  supplied them yet.

<a id="gemeinsamer-bericht-2026-09-10"></a>

## Combined report (2026-09-10)

`untangle scan --yes --format=json` separates own metrics, external signals and
explained failures. Details: [SCAN.md](SCAN.md).

Correction of the earlier declaration: repository-wide `ncloc` is not eligible
for cross-checking because Untangle produces no repository-wide SLOC total.
`comparableTo` was removed from the user manifest; domain validation now rejects
such claims and unknown metric versions. Cycles and depth remain eligible.
