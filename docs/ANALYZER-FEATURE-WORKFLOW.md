<a id="suche-feature-verantwortung-und-analyzer-gemeinsam-nutzen"></a>

# Use search, feature responsibility and analyzers together

Untangle links a feature's declared responsibility to complete local code/test
measurements. Enabled analyzers add separately identifiable external evidence.
Before a change, agents can inspect the domain boundary, relevant search cases,
tests and additional findings together. An external repository rating does not
thereby become a feature metric or an Untangle combined score.

<a id="schnell-zum-ersten-befund"></a>

## Reach the first finding quickly

These commands require an available Untangle CLI. In a repository build,
`untangle` corresponds to `node /path/to/untangle/apps/cli/dist/index.js`. Public
registry availability is a separate release step.

```sh
untangle init /path/to/project --dry-run --offline
untangle product --root=/path/to/project --format=json
```

Neither step requires embeddings, Qdrant or analyzers. Even without a spec, `init`
reports missing documents and declarations; it confirms no automatically
inferred features. An existing `untangle.features.json` declares feature IDs,
intent sources, complete code/test files, acceptance criteria and owners. The
[feature alignment guide](FEATURE_ALIGNMENT.md) explains the contract and limits
of its domain-level claims.

For an already declared feature ID:

```sh
untangle scan --root=/path/to/project --feature=checkout --format=json
```

The report adds `featureAlignment` beside existing `ownMetrics`,
`externalSignals` and `notMeasured`. It also works with an empty analyzer profile:
own feature metrics and ownership remain visible, while external evidence is not
measured. Without `--feature`, the existing scan report remains unchanged.

A different manifest and existing source-bound test evidence can be selected
explicitly, relative to the chosen root:

```sh
untangle scan --root=/path/to/project --feature=checkout \
  --manifest=docs/features.json --test-evidence=.untangle/tests.json --format=json
```

Both path options require `--feature`. This scan executes no tests. Missing or
stale test evidence is reported as `not_run` or `stale`.

<a id="was-der-agent-damit-entscheidet"></a>

## What the agent can decide

1. `featureAlignment.report` shows declared vision/spec links, owners, acceptance
   criteria, test evidence, complete file measurements including private helpers,
   and specific `agentHints`. Missing, unsupported or partially parsed files are
   not treated as zero complexity.
2. `sourceBinding` compares the accepted local inventory and manifest hash before
   own repository analysis and after analyzer calls. Changes produce `changed`;
   failed or incomplete final checks produce `unverified`. The original
   measurement remains baseline evidence, not a current overall proof.
3. `externalEvidence` references `externalSignals` by `extensionId`, `runId` and
   original result index. Tool version, parser/manifest provenance, raw-data hash,
   run status, errors and skips stay in the original run report.
4. Each external position has an explicit relation: `repository_context`,
   `declared_feature_file`, `other_file` or `unscoped`. Shared files additionally
   list `sharedWithFeatures`. Unknown measurements and missing scope remain visible.
5. `nextSteps` turn missing evidence into a concrete next check. Empty results and
   unexecuted extensions do not count as passed feature gates.

A repository measurement remains `repository_context` even if the tool also
supplies a path. File/symbol measurements are assigned only with explicitly
declared meaning and a returned path matching an exact declared code or test
file. This does not imply causal cost allocation. Shared code is neither divided
nor added repeatedly into a combined total.

The scan remains repository-wide: `--feature` adds domain context but does not
limit the entire own measurement corpus or automatically restrict external
analyzer targets. It runs the same enabled extensions as an ordinary scan. This
additional check needs two local feature analyses; runtime depends on the
repository and analyzers.

<a id="sentrux-als-explizit-gewählte-extension"></a>

## Sentrux as an explicitly selected extension

Tool definitions live in the user profile or come from an explicitly selected
external source. Untangle bundles neither the Sentrux program nor its manifest
(X9). Given an existing reviewed definition:

```sh
untangle extensions add --from "$HOME/untangle-extension-sources/sentrux/manifest.toml"
untangle extensions enable sentrux
untangle extensions status sentrux
untangle scan --feature=checkout --format=json
```

`add` and `enable` start no program. `status` may probe availability. An explicit
scan launches enabled binary analyzers according to their manifests. Before the
first run, review arguments, write effects, telemetry, license and measurement
scope. A flat measurement object is interpreted only through declared
`outputMapping.shape = "flat-object"`; no vendor-specific parser branch exists.
Proprietary composites remain external evidence.

**Specific local limitation recorded on 19 October 2026:** the external Sentrux
manifest present here uses `sentrux gate --save {workspace}` and reads the saved
measurement file. The locally checked version 0.5.7 describes `--save` as saving
current values as a new baseline. This definition captures a baseline and may
replace an existing one; it does not prove a comparison with the previously
retained baseline. The user manifest was not changed and no real Sentrux scan was
started for that development. Regression checks first require an explicitly
chosen external provider workflow and retained baselines. New or changed analyzer
artifacts inside the accepted source inventory are visible to local source
comparison.

<a id="sonar-als-separat-betriebene-analysequelle"></a>

## Sonar as a separately operated analysis source

The user also adds a Sonar definition. Untangle provides the runtime, manifest
contract and format parsers; server, analyzer, license decisions and credentials
remain separate prerequisites. With an existing reviewed external definition:

```sh
untangle extensions add --from "$HOME/untangle-extension-sources/sonarqube/manifest.toml"
untangle extensions list
```

If license acknowledgment is required, Untangle displays the exact command. It
never imports that acknowledgment from a project. The user then enables the
selected extension, configures credentials privately and checks status:

```sh
untangle extensions enable sonarqube
untangle extensions configure sonarqube
untangle extensions status sonarqube
untangle scan --feature=checkout --format=json
```

A configured container is not provisioned without explicit `--yes`. A scan
without consent may therefore report `consent_withheld` or missing setup or
credentials. Intended provisioning and credential setup require a separate,
resource-consuming invocation; this recipe never adds `--yes` automatically.
See [COMPLEXITY-SIGNALS.md](COMPLEXITY-SIGNALS.md).

The local manifest reads existing project measures with GET. It starts no new
Sonar scan. `component.measures` is described through `outputMapping.container`,
`key` and `value`. A successful HTTP response proves neither the correct project
nor a current branch or commit. Before interpretation, check project key,
branch, analyzed revision, analysis time and corpus in the analyzer. Credentials
belong in private configuration or the environment, never the feature manifest
or report.

`analyzerSourceIdentity` therefore remains `not_independently_proven`, even with
unchanged local inventory and HTTP 200. Retrieval time does not prove freshness
of the underlying analysis. Repository cognitive values are neither subtracted
from nor added to own feature values. Metric definitions and corpora retain
their differences; no Sonar parity is inferred.

<a id="zusammen-mit-echter-suche-verwenden"></a>

## Combine this with real search

`product` and feature scans require no search index. Suggested symbol, lexical,
semantic or hybrid queries do require a compatible fresh index. The agent uses
`agentHints.search`, its file scope and `requireFresh`, checks callers and graph
context, and confirms the correct target. Feature IDs may also be declared links
in Search Journeys. External repository values do not explain a specific search
failure; repeated search friction adds evidence about responsibility that needs
inspection.

<a id="prüfumfang-dieser-erweiterung"></a>

## Verification scope of this extension

New CLI tests create small temporary projects with actual local parser analysis
and declared ownership. HTTP is injected at the transport boundary; tests start
no external program, server, container or credential setup. Coverage includes
flat/nested metric shapes, provenance, file scope, shared files, empty/invalid
output, HTTP failure, missing/unsupported feature scopes, manifest/source
changes, failed final checks, cancellation and unchanged default behavior. This
verifies the integration contract rather than real vendor analysis or general
feature equivalence.
