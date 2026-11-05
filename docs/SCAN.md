<a id="ein-analysebericht-über-untangle"></a>

# One analysis report through Untangle

```sh
untangle scan
untangle scan --root=/path/to/project --yes --format=json > scan.json
```

The command uses the local analysis from `complexity` and the same extension
execution path as `extensions run`. Agents can collect own metrics and enabled
external indicators through Untangle for each fix. Own measurements require no
index.

<a id="drei-getrennte-blöcke"></a>

## Three separate sections

- `ownMetrics`: own code totals, separately measured prose and the complete skip
  ledger. External values never contribute to these totals.
- `externalSignals`: extension ID, run status, provenance, measurements, findings,
  warnings and discarded entries. Failed runs remain visible as failures. A
  successful report without findings remains a successful run.
- `notMeasured`: disabled, missing, rejected or ignored extensions, open license
  gates, missing consent, missing secrets, failed provisioning and failed runs,
  each with a reason and next step.

`comparableTo` permits a cross-check in tests when the metric version matches and
an own comparison metric exists. It creates no difference, ratio or combined
report score. File scope, measurement scope and freshness must also match for a
cross-check. In particular, an HTTP extension only reads its manifest's endpoint;
this does not automatically initiate another source-code scan by the external
service.

<a id="zustimmung-status-und-abbruch"></a>

## Consent, status and cancellation

Without `--yes`, no containers are provisioned. Enabled binary and HTTP extensions
without a container block may run. `--yes` applies across the scan to all enabled
container extensions; resources and the pinned image appear on stderr before
each provisioning action. If an external `[setup]` provider is declared, `--yes`
also permits missing-credential setup on the verified local service. Existing
tokens are read from private user configuration or the environment and reused.
This does not acknowledge a license. An already running owned container is reused.

Exit code 0 means **report created**, including individual extension failures.
Automation must inspect `notMeasured` and individual run statuses. Invalid
arguments, an impossible own analysis and cancellation remain failures.
Cancellation does not produce an apparently successful partial report. Actual run
results update the user's last-run record; a write failure becomes a warning in
the report, which remains available.

The project boundary follows `--root`, even when invoked from another directory.
Extension search paths are canonicalized before boundary checks so symlinks and
path aliases cannot bypass the boundary.

<a id="korrektur-der-eigenen-summen"></a>

## Correcting own totals

`complexity` and `scan` use `totalsReading: "execution_unit"` from the existing
scope aggregation: outermost functions contribute their inclusive value; scopes
outside a function contribute only their self value. Nested functions are not
added twice. `executionUnits` counts every function unit; `executionUnitRoots`
counts only outermost units. Hotspots remain individual symbols. Cyclomatic
includes the base per selected scope, as defined by the existing aggregation.
Control flow outside functions remains included.

The earlier CLI summed every inclusive function value and therefore counted
nested functions twice. A regression test demonstrates the difference with an
outer and inner function: cognitive **3 instead of 4**, while both hotspots remain
visible. Old repository totals need a newly measured baseline; individual symbol
values and their threshold gates remain unchanged.

<a id="abnahme-am-2026-09-10"></a>

## Acceptance on 2026-09-10

The first built run returned ten Sentrux measurements and reported SonarQube as
`secret_missing` because no token was available. With the subsequently added
credential setup, Untangle created an administrator user token on the existing
instance, stored it privately and fetched five SonarQube measurements. Another
`scan --yes` reuses that token. SonarQube values come from the service's existing
analysis; fetching them starts no new external source-code scan. Setup and
configuration options are described in
[COMPLEXITY-SIGNALS.md](COMPLEXITY-SIGNALS.md#automatische-einrichtung-und-konfiguration).

Tests cover multiple failures followed by a successful run, license gates before
every invocation, cost disclosure before scan-wide provisioning, digest mismatch
before analysis, secret redaction, cancellation, the `--root` project boundary,
unchanged external provenance and separate aggregation.

Final checks: **3,246 tests passed, 4 skipped**; build, typecheck, package tests,
lint, formatting, license checks, publishability and E2E smoke also passed. Three
existing status tests exceeded their 5-second limit in one run under heavy VM
load; the isolated rerun and subsequent full run passed without changing tests
or timeouts.

On the same source revision, scan, `complexity` and
`scripts/complexity-report.mjs` all returned cognitive **19,075**, cyclomatic
**18,439** and **4,055** outermost execution units. This is an internal aggregation
cross-check, not a comparison against an external metric.

After credential setup: **3,263 tests passed, 4 skipped**, plus seven external
provider tests. Build, typecheck, formatting, license checks, publishability and
E2E smoke passed; lint had no errors and 14 existing warnings. The complete final
run used `--maxWorkers=2`. Status tests are now independent of the real container
daemon. A timing-sensitive lease test passed in isolation and in the complete
final run after failing under heavy parallelism. Live `scan --yes` contained ten
Sentrux and five SonarQube measurements; the private token file remained unchanged
and outputs contained no credentials.
