# @untangle-code/observability

An internal private package, not published to npm. It builds error, logging, redaction,
correlation, metric and profiling components on `@untangle-code/domain`. Its only direct I/O is
`process.stderr` for logging and `process.memoryUsage()` for profiling; no network or filesystem.

Normative sources: [`spec.md`](../../spec.md) §23 (health/observability), §24 (security/privacy),
§25.1 (error classes), taking precedence in conflicts; [`architecture.md`](../../architecture.md)
§22 (error architecture) and §24 (observability).

Every exported domain type (`UntangleError`, `ErrorCode`, `ERROR_CODES`, `LoggerPort`, `LogEvent`,
`LogLevel`, `Clock`, `Random`, `ToolResponseEnvelopeV1`, …) is imported from
`@untangle-code/domain`, never redefined locally.

<a id="modulübersicht-alles-re-exportiert-aus-srcindexts"></a>

## Modules (all re-exported from `src/index.ts`)

| Module | Contents | Normative source |
|---|---|---|
| `errors.ts` | `ERROR_FACTORIES` (one factory per `ErrorCode`, generated from `ERROR_CODES`) and 28 named convenience exports (`configInvalidError`, `lockHeldError`, …); `toErrorEnvelope(error)` maps **any** thrown value to `ToolResponseEnvelopeV1.error`; domain re-exports `UntangleError`, `ErrorCode`, `ERROR_CODES`, `isUntangleError`, `isErrorCode` | spec §25.1, §21.2; portfolio §15; arch §22.1 |
| `redact.ts` | Pure `redact(value, options?)`, recursive over objects/arrays; masks known secret keys and secret-like values, suppresses source fields by default (opt in through `includeSourceText`) | spec §24, §23.2 |
| `correlation.ts` | `createRequestContext({ clock, random })`, IDs exclusively through injected `Clock`/`Random` ports | arch §24.1 |
| `logger.ts` | `createLogger(options): Logger`, implementing `LoggerPort`: stderr JSON lines, level filtering, `child()` with inherited context, automatic redaction before writing | arch §24.2 |
| `metrics.ts` | `MetricsRegistry`, exactly the 11 counters from spec §23.3 (8 counters, 1 histogram, 2 ratio gauges); pure-object `snapshot()` | spec §23.3 |
| `profiling.ts` | `ProfileCollector`: stage timing through injected `Clock`, file counts, cache-hit rates, embedding/Qdrant latency and bytes, parser/language breakdown, memory high-water mark through `process.memoryUsage()` | arch §24.3 |

<a id="verwendung-durch-andere-packages"></a>

## Use by other packages

- **core-engine** throws `UntangleError` using `*Error` factories at adapter boundaries and builds
  `ToolResponseEnvelopeV1.error` through `toErrorEnvelope()`.
- **cli/mcp-server** create a `RequestContext` (`createRequestContext`) and child logger
  (`logger.child({ requestId, workspaceId, … })`) per tool invocation for the operation's lifetime.
- **index-pipeline** increments `MetricsRegistry` counters during scanning/chunking and populates
  a `ProfileCollector` with `--profile`.

<a id="entscheidungen"></a>

## Decisions

Choices left open by spec.md/architecture.md; additive extensions are welcome, local redefinitions are not:

1. **`toErrorEnvelope()` for non-`UntangleError` values.** spec.md §21.2 defines the error shape,
   not behavior for raw `Error`, string or object throws. Such values receive
   `code: "UNKNOWN_ERROR"` (exported as `UNKNOWN_ERROR_CODE`) and `retryable: false`, never one of
   the 28 known `ErrorCode` values. Spec §25.2 forbids equating absence and infrastructure failure,
   and a raw `Error` cannot be safely assigned to either. Envelope `error.code` is specified as
   `string`, not `ErrorCode`, so this conforms to the spec.
2. **Generated factory map rather than 28 handwritten classes.** `ERROR_FACTORIES` derives from
   domain's `ERROR_CODES`, so factories cannot diverge from the code list. The 28 named exports
   (`configInvalidError`, …) alias map entries rather than provide another source of truth.
3. **Correlation IDs beyond `requestId`/`jobId` belong in `context`.** Domain's fixed `LogEvent`
   (architecture.md §24.2) has only these two top-level fields. `generationId`, `workspaceId`,
   `repoId`, `refId` from §24.1 have no dedicated slots and enter `context` under those names through
   `logger.child({...})`; the nearer `child()` wins collisions. This does not break or extend the
   domain-pinned `LogEvent` shape.
4. **`createRequestContext()` creates only `requestId`.** `jobId`/`generationId` belong to the
   subsystem actually starting a job/generation (job engine/index pipeline), not blind advance
   generation without an existing job. Those subsystems should use the same injected `Random`
   (`random.uuid()`) once built. `workspaceId`/`repoId`/`refId` are content-addressed domain
   identities (`buildWorkspaceId` etc.), not random IDs; callers attach them to request context.
5. **Three metric kinds, not two.** Spec §23.3 calls all eleven names counters, but
   `search_latency_ms` is a distribution (histogram), and
   `resolved_import_ratio`/`resolved_call_ratio` are snapshot ratios, not monotonic counts. A true
   counter would misrepresent them. The remaining eight are cumulative counters. The name set
   stays exactly the eleven from spec §23.3 and cannot be extended with new names.
6. **Redaction-key and source-field lists are local choices, not normatively prescribed.**
   Spec §24 lists apiKey, token, password, authorization, cookie as examples and generally requires
   no unsolicited logging of secrets or complete source. `SECRET_KEY_PATTERN` and
   `SOURCE_TEXT_KEYS` (mirroring `CodeChunkPayloadV1`/`CodeChunkDraft`) are additive WP-04 choices.
   Later packages with more secret/source fields should extend these lists rather than implement
   another redactor.
7. **`Logger` is a superset of domain's `LoggerPort`.** `Logger extends LoggerPort` adds
   `error()/warn()/info()/debug()/trace()` convenience methods that obtain timestamps from injected
   `Clock`. Domain's `log(event: LogEvent)` remains the low-level interface, used internally by
   convenience methods; every `createLogger()` instance stays fully `LoggerPort`-conformant.
8. **Redaction runs inside the logger, not at call sites.** `createLogger()` automatically applies
   `redact()` to every `context` before writing, so callers need not remember it.
   `debugIncludeSourceText` defaults to `false` and provides spec §24's explicit opt-in exception
   for source fields; secret keys remain masked regardless.

<a id="offene-punkte"></a>

## Open issues

- `docs/BUILD_PLAN.md` had not been created in this working directory when this package was built
  (only spec.md, architecture.md, product.md, vision.md, portfolio.md existed). The package
  therefore follows the requested spec.md §23/§25.1 and architecture.md §22/§24 only. A later
  `docs/BUILD_PLAN.md` contract register should be checked against these decisions, not silently
  overwrite them.
- Root `tsconfig.json` reference orchestration is outside this package's ownership. The root owner
  must add `{ "path": "packages/observability" }` to `references` for `tsc -b tsconfig.json` to
  include it. Its own scripts (`pnpm --filter @untangle-code/observability run typecheck/test`)
  are independent and pass.
- No external metric exporter such as Prometheus: optional under spec §23.3 and deliberately
  unbuilt. `snapshot()` returns a pure object callers can export themselves.

<a id="lizenz"></a>

## License


**AGPL-3.0-only.** This package includes the complete license in [`LICENSE`](./LICENSE), the
license-choice rationale in [`NOTICE`](./NOTICE), and licenses for all third-party production
dependencies in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). All three ship in the npm
tarball: AGPL-3.0-only §4 and §5 require recipients to receive the license; a README alone is not
a copy of the license.

Local use alone does not trigger an obligation. Copyleft obligations apply to redistribution and
providing a network service (AGPL §13).

Corresponding TypeScript source ships under `src/` in the same tarball; the complete repository
is available at <https://github.com/lboel/untangle>.
