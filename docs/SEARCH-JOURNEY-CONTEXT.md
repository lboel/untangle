<a id="search-journey-kontext-und-erfolglose-aufgaben"></a>

# Search Journey context and unsuccessful tasks

Untangle observes search work when a caller explicitly starts a journey. An
accepted target provides search effort up to that target. It measures neither
the target's domain correctness nor a causal relationship with code quality.

<a id="gleiche-aufgabenbedingungen-ausdrücklich-angeben"></a>

## Declare comparable task conditions explicitly

Starting a journey optionally accepts `executionContext`. The format is
independent of any specific agent or harness:

```json
{
  "action": "start",
  "goal": "Find the code and tests responsible for password reset",
  "featureId": "auth.password-reset",
  "executionContext": {
    "agentModel": "model-with-exact-version",
    "harness": "my-coding-harness-v2",
    "searchStrategy": "hybrid-then-symbol-and-graph-v1",
    "taskClass": "find-feature-code-and-tests",
    "taskMix": "fixed-eight-task-suite-v1",
    "priorContext": "fresh-session-no-open-files"
  }
}
```

When context is supplied, `agentModel`, `harness`, `searchStrategy` and `taskClass`
are required; `taskMix` and `priorContext` are optional. Values must be nonempty,
trimmed identifiers of at most 256 UTF-16 code units. Task classes should remain
stable across repetitions. `taskMix` may identify a versioned task selection
recorded outside the journey; Untangle controls neither that selection nor the
truth of these declarations.

The same lifecycle works without context, and old sessions remain readable.
Untangle does not invent retrospective model, harness or task declarations.
`not-recorded` and `uncontrolledDimensions` expose missing conditions. Missing
values also differ from an explicitly supplied `unknown`.

<a id="fingerprints-und-kohorten"></a>

## Fingerprints and cohorts

Sessions retain `schemaVersion: 1`. The additive `executionContext` has
`schemaVersion: 1`, `source: "caller-declared"` and a workspace-local HMAC-SHA-256
per dimension. Dimensions use separate HMAC domains even for identical labels.
Before using persisted context, Untangle validates its shape and retention
contract.

The report derives a text-free execution fingerprint from dimension fingerprints.
For sessions with context, cohort identity includes both the existing retrieval
measurement context and this fingerprint. Changing the model, harness, strategy,
task class, task mix or prior context therefore produces another cohort. Without
execution context, the existing cohort identity remains unchanged. Stored
individual assessments and retrieval identifiers are not rewritten.

Cohort-report `executionContext` contains only status, fingerprint and missing
dimensions. `callerConditionsControlled: true` means only that all six dimensions
were explicitly declared; it is no independent verification of controlled
experimental conditions.

`sufficientEvidence` retains its narrower meaning: at least three completions
with complete, compatible retrieval evidence. It may be `true` without declared
caller conditions and therefore does not establish comparable agent behavior.
Both evidence axes must be interpreted separately. Feature mappings use the same
context-dependent cohort contract.

<a id="fehlgeschlagene-und-abgebrochene-arbeit-sichtbar-halten"></a>

## Keep failed and abandoned work visible

`cohorts` and `featureMappings[*].search` continue to measure completed tasks only.
Their medians and denominators are not redefined. `outcomeCohorts` additionally
includes every recorded session, separated by retrieval context, execution
context and optional feature mapping:

- `sessionCounts` reports total, active, completed, abandoned and terminal
  sessions. Terminal means completed plus abandoned.
- `terminalCompletionRate` is completed divided by terminal. Without a terminal
  session it remains `null`. Active sessions remain separate; this is a recording
  rate, not benchmark accuracy.
- `statusEffort` reports session count, sessions with searches, all search calls,
  failed search calls, navigation events, their combined total and median search
  calls per status. Sessions with zero searches count in their status median.
  A status with no sessions receives `null`.
- `abandonmentReasons` counts controlled reason codes. A missing code is
  `not-recorded`; free-form failure or cancellation text is not emitted here.

For example, an accepted task used one search while an abandoned task in the
same context used three. The completed-task median remains one search. The
outcome report also shows one of two terminal tasks completed, three searches
for the abandoned task and its reported reason. This must not be interpreted as
all tasks needing one search.

Outcome effort explicitly covers the entire recording. If completion selects an
earlier `acceptedAttemptId`, the individual assessment may stop counting there;
the outcome report retains subsequently observed searches and navigation. These
values have different definitions and need not match.

Unknown retrieval contexts are never retrospectively assigned to a successful
cohort. Tasks without searches or with only failed retrieval can therefore belong
to another incomplete cohort. Overall evaluation must include all outcome
cohorts and their denominators. Untangle does not automatically normalize task
mix, sampling or model differences, and provides neither automatic time trends
nor ROI evidence.

<a id="datenschutz"></a>

## Privacy

By default, only context fingerprints are stored. Normalized context labels are
retained locally only with `retainText: true`; aggregate context reports never
emit those labels even then. Existing explicit consent and the separately stored
local HMAC key file still apply.

This is pseudonymization, not anonymization or encryption. Full local access,
including the key, allows testing guessed values. Labels should therefore be
stable comparison identifiers without secrets, prompts, source text or personal
descriptions.

<a id="gezielt-geprüft"></a>

## Targeted verification

Additional domain and service tests cover new and existing V1 sessions,
different models and harnesses, all six dimensions, missing optional values,
consent, HMAC domain separation, malformed persistence, unsuccessful search
calls, abandonment, active and zero-search sessions, and explicit earlier target
acceptance. Existing regression assertions are unchanged. These are contract
tests with controlled search observations; they measure neither real task time
nor an agent's success improvement.
