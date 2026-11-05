# @untangle-code/watcher

Untangle's watcher (WP-14): a native recursive filesystem watcher with debouncing/coalescing,
periodic reconciliation as a safety net for missed events, and cross-process locks per
`repo_id:ref_id:watch`. Internal package (`private: true`), consumed by the indexing pipeline
(later WPs), not directly by end users.

Normative sources: [`spec.md`](../../spec.md) §12.3 (in full; takes precedence in a conflict), §12.1,
[`architecture.md`](../../architecture.md) §21.1, [`docs/BUILD_PLAN.md`](../../docs/BUILD_PLAN.md)
(WP-14).

Dependencies: **only** `@untangle-code/domain` (`workspace:*`), `@untangle-code/testkit`
(`workspace:*`, `devDependency` only). No other Untangle packages; in particular no
`@untangle-code/scanner` dependency despite that package already being complete (see decision 2).

<a id="architektur"></a>

## Architecture

`RepoWatcher` (`watcher.ts`) is the sole orchestrator, composing four independently testable
building blocks:

```text
NativeWatcherPort     thin wrapper over node:fs/promises watch(root, {recursive:true})
                       (production: NodeNativeWatcher; tests: FakeNativeWatcher)

PathDebouncer          debouncing + coalescing (spec §12.3): one reset timer per path
                       through the injected SchedulerPort

reconcileTree /        reconciliation (spec §12.1, §12.3): comparison against the
evaluatePath           watcher's own per-path snapshot (size, mtime, content hash);
                       ONLY the content hash decides unchanged status

LockProvider           cross-process lock "repo:<repoId>:<refId>:watch"
(domain, injected)     (architecture.md §21.1), with periodic lease renewal
```

`NativeWatcherPort` and `SchedulerPort` are package-local contracts, not in `packages/domain`.
The same decision as `ScannedFileV1` in `@untangle-code/scanner`: tests replace them with
`FakeNativeWatcher`/`FakeScheduler` (`src/testing/`, not publicly exported) without requiring domain
to know a watcher-specific port.

<a id="modulübersicht"></a>

## Module overview

| Module | Contents | Source |
|---|---|---|
| `types.ts` | `NativeChangeEventV1`, `NativeWatcherPort`, `SchedulerPort`/`TimerHandle`, `ContentHasher`, `WatchedFileSnapshotV1`, `WatcherEventV1`, `WatcherStatus`: package-local contracts | WP-14 decision |
| `watcher.ts` | `RepoWatcher`, `RepoWatcherOptions`, `buildWatchLockKey()`: orchestrator | spec §12.1, §12.3; arch §21.1 |
| `debouncer.ts` | `PathDebouncer`: one reset timer per path, coalescing event storms into exactly one `onDue` | spec §12.3 |
| `reconciler.ts` | `reconcileTree()`, `evaluatePath()`: full-tree or single-path comparison against the snapshot | spec §12.1, §12.3 |
| `content-hash.ts` | `hashBytes()`, `defaultContentHasher`: SHA-256 through `FileSystemPort` | spec §12.1 |
| `native-watcher.ts` | `NodeNativeWatcher`: production adapter over `node:fs/promises` `watch()` | spec §12.3 |
| `scheduler.ts` | `NodeScheduler`: production adapter over real `setTimeout`/`setInterval` | internal |
| `paths.ts` | `normalizeRelativePath()`, `joinRelative()`, `isDotGitPath()` | internal |
| `errors.ts` | `toWatcherError()`: normalization to `UntangleError` (see decision 3) | arch §22.1 |
| `noop-logger.ts` | `noopLogger`: default `LoggerPort` when none is injected | internal |
| `testing/fake-native-watcher.ts` | `FakeNativeWatcher`: controllable `NativeWatcherPort` for tests (not exported) | test infrastructure |
| `testing/fake-scheduler.ts` | `FakeScheduler`: deterministic `SchedulerPort`, coupled to a `FakeClock` (not exported) | test infrastructure |

<a id="verwendung"></a>

## Usage

```ts
import { RepoWatcher, NodeNativeWatcher, NodeScheduler } from "@untangle-code/watcher";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs"; // caller's own choice
// lockProvider, clock: production adapters wired by the composition root (later WP)

const watcher = new RepoWatcher({
  repoId: "repo-1",
  refId: "ref-1",
  rootPath: "/abs/path/to/repo",
  fs,
  nativeWatcher: new NodeNativeWatcher(),
  scheduler: new NodeScheduler(),
  clock,
  lockProvider,
  initialSnapshots: lastPersistedSnapshots, // typically rebuilt from the last FileManifestV1 set
  ignore: (relativePath) => myIgnoreEngine.isIgnored(relativePath),
});

watcher.onChange((events) => {
  // events: WatcherEventV1[] — "added" | "modified" | "deleted", debounced/coalesced
});
watcher.onStatusChange(({ status, error }) => {
  // "starting" | "running" | "degraded" | "stopped"
});

await watcher.start();
// ...
await watcher.stop();
```

<a id="entscheidungen"></a>

## Decisions

1. **`SchedulerPort`/`NativeWatcherPort` are package-local, not domain contracts.** Neither
   architecture.md §21 nor the contract register in `docs/BUILD_PLAN.md` §3 lists watcher/timer
   ports. Domain's `LockProvider`, `Clock`, and `FileSystemPort` already cover the *domain* ports
   the watcher actually needs. Native watching itself is infrastructure local to this package,
   analogous to `@untangle-code/scanner` defining `ScannedFileV1` locally rather than imposing it
   on domain (see its README, decision 1). `FakeNativeWatcher`/`FakeScheduler` therefore live in
   `src/testing/` and, like scanner's `MemoryFileSystem`, deliberately are NOT exported through
   `src/index.ts`.

2. **No content hashing/reconciliation walk through `@untangle-code/scanner`, despite its
   completion.** The assignment explicitly limits dependencies to `domain` (always), `testkit`
   (dev), and `observability`/`config` “as needed”. `scanner` is absent from that list. Excluding
   “packages being developed concurrently in this wave” is the only explicit exception, not
   “other completed packages are automatically allowed”. Two deliberate, documented consequences:
   - `content-hash.ts` minimally reimplements `hashBytes()`/the default `ContentHasher` (SHA-256
     through `FileSystemPort`) rather than importing `@untangle-code/scanner`'s `hashing.ts`.
   - `reconcileTree()` is a simple locally written recursive `FileSystemPort` walk with symlink
     cycle protection through visited real paths (scanner's `visitedRealDirs` technique,
     independently reimplemented), WITHOUT spec §6.2's full `.gitignore`/`.untangleignore` priority
     cascade. Callers needing real ignore semantics (the indexing pipeline) supply them through
     `RepoWatcherOptions.ignore`, typically connected to scanner's own `IgnoreEngine`. Only `.git`
     exclusion is built in (see `isDotGitPath`). Persistently watching a VCS system directory has
     no useful purpose and would create unnecessary reconciliation load on every `git` command.

3. **`INDEX_INCOMPLETE` is the degraded signal for watcher/reconciliation failures, rather than
   a new ErrorCode.** `ERROR_CODES` (spec.md §25.1 ∪ portfolio.md §15) has no code for “the native
   watcher backend is currently broken”; `packages/domain` is outside the assigned paths, and
   BUILD_PLAN §3 makes the code set an additive-only contract that one WP cannot extend alone.
   `INDEX_INCOMPLETE` is the closest existing semantic fit: a watcher/reconciliation failure means
   exactly that the index could silently drift. Crucially for spec.md §25.2's prohibition on
   confusing “not found” with “infrastructure error”, it is clearly NOT a “not found” code. These
   errors are also never thrown to callers (see decision 4); they serve only as the payload for
   structured logging and `onStatusChange`. Listed in `openIssues`: a dedicated
   `WATCHER_DEGRADED` code would be cleaner once someone with write access to `packages/domain`
   coordinates it.

4. **Error isolation is structurally enforced, not merely conventional.** `runWatchLoop()` catches
   EVERY error from the `for await` iteration over `NativeWatcherPort.watch()`. No path in that
   method throws an exception out of the loop: an error is logged (`reportDegraded`), status
   becomes `"degraded"`, and after `restartDelayMs` the loop opens a new `watch()` session itself.
   The same isolation applies to `runReconciliationSafely()`, `flushPath()`, and
   `renewLockSafely()` (the latter additionally stops the watcher cleanly because loss of lock
   exclusivity is serious). The only error actually thrown from a public method is from `start()`
   itself (`LOCK_HELD` during lock acquisition, `JOB_CANCELLED` for an aborted `options.signal`).
   Throwing there is correct: `start()` is not yet the running watch loop whose resilience
   spec §12.3 requires.

5. **Reconciliation ALWAYS hashes; no size/mtime fast path.** spec.md §12.1: “Only the content
   hash may determine final unchanged status.” `evaluatePath()` therefore reads and hashes full
   content on every reconciliation pass, even when size and mtime exactly match the snapshot.
   A `reconciler.test.ts` case proves this literally: file content is replaced with different
   text of equal length WITHOUT advancing `FakeClock`, leaving snapshot size and mtime identical.
   Only the hash differs, and only this lets `reconcileTree()` detect the change. An mtime fast
   path (skip hashing if size/mtime match) would be the obvious optimization for large repositories,
   but would directly contradict this specification sentence, so it is deliberately NOT
   implemented (see “Known limits”).

6. **`start()` is idempotent; a failed start can be retried.** A second `start()` while running
   is a no-op, not an error. The assignment specifies no multiple-call behavior, and a no-op is
   least surprising for this lifecycle method. If lock acquisition fails (`LOCK_HELD`), internal
   `started` is reset and status restored to `"stopped"` before throwing. Otherwise the idempotence
   guard would permanently block a later legitimate `start()` after the other watcher calls
   `stop()`. A test (`watcher.test.ts`, “stop() releases the lock so a new watcher can acquire it”)
   covers the full cycle.

7. **`RepoWatcherOptions.reconciliationIntervalMs` has no specification-derived default.**
   spec.md §12.3 supplies a concrete default only for debouncing (2000 ms). Reconciliation is merely
   “periodic”, with no number. The selected default (30,000 ms) is a documented WP-14 decision,
   balancing responsiveness to missed events and I/O from full-tree passes on large repositories.
   Listed in `openIssues`: once `@untangle-code/config` supplies a schema field, the default
   should come from effective configuration instead of being hardcoded here.

8. **`Clock` is a genuine tested constructor dependency, not a formality.** It supplies every
   `LogEvent` timestamp (`clock.nowIso()` in `reportDegraded()` and `emitChanges()`'s error path),
   never `Date.now()` (BUILD_PLAN rule 5; ESLint `no-restricted-syntax` enforces this repository-wide
   anyway). Tests also couple it to `FakeScheduler`: `FakeScheduler.advance()` advances the exact
   `FakeClock` instance passed to `RepoWatcher` as `clock`. Tests therefore see one consistent
   simulated time for debounce timers, reconciliation intervals, lock-lease renewal AND log
   timestamps.

<a id="verifikation"></a>

## Verification

```bash
pnpm --filter @untangle-code/watcher run typecheck   # tsc, 0 errors (including tests)
pnpm --filter @untangle-code/watcher run test        # vitest, 22 passing tests
pnpm --filter @untangle-code/watcher run build       # emit to dist/, 0 errors
```

Actually executed (see `verification` in the task report): `npx tsc --noEmit -p
tsconfig.typecheck.json` (0 errors), `npx tsc -p tsconfig.json` (0 errors; dist/ subsequently removed,
see `.gitignore`), `npx vitest run --reporter=verbose` (22/22 passing across 5 files:
`content-hash.test.ts`, `debouncer.test.ts`, `reconciler.test.ts`, `watcher.test.ts`,
`native-watcher.integration.test.ts`). The latter passed on macOS with actual
`node:fs/promises` `watch({recursive:true})` against a temporary directory (no platform skip needed).
The self-skip path for `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` (e.g. Linux) exists in code but was
never exercised on this platform.

The six fake-watcher/fake-clock scenarios required by the assignment are in `watcher.test.ts`:
debouncing coalesces events; an event storm produces exactly one update; reconciliation finds a
missed change; a watcher error does not terminate the process and reports degraded; two watchers on
the same ref block each other through the lock. Two additional cases further protect the same
mechanism (lock renewal survives the original lease duration; `stop()` frees the lock for a new
watcher).

<a id="bekannte-grenzen-siehe-openissues-im-task-report"></a>

## Known limits (see `openIssues` in the task report)

- No port contract from `packages/testkit/src/contracts/` applies here: this package implements
  none of the six domain ports (`VectorStore`, `MetadataStore`, `GraphStore`, `LockProvider`,
  `FileSystemPort`, `EmbeddingProvider`). It CONSUMES `LockProvider`, `FileSystemPort`, and `Clock`
  through dependency injection, but creates no adapter for them. `NativeWatcherPort`/`SchedulerPort`
  are package-owned contracts without corresponding contract suites (see decision 1).
- `reconcileTree()` ignore support is a simple predicate, not the full
  `.gitignore`/`.untangleignore` priority cascade (see decision 2). Callers needing real ignore
  semantics must inject a suitable function, typically scanner-backed.
- No mtime/size fast path before hashing during reconciliation (see decision 5). Very large
  repositories with infrequent changes are fully rehashed on every reconciliation pass.
  Specification-compliant, but a performance trade-off a later WP could address, e.g. through
  an explicit “trust mtime” opt-in.
- The `reconciliationIntervalMs` default (30,000 ms) is a WP-14 number without a specification
  requirement (see decision 7); a candidate for an `@untangle-code/config` schema field.
- Reusing `INDEX_INCOMPLETE` for watcher/reconciliation degraded signals (see decision 3) is a
  compromise within the existing additive-only code set. A dedicated `WATCHER_DEGRADED` code in
  `packages/domain` would be cleaner.
- The real-filesystem integration test passed only on macOS in this verification. Documented
  self-skips for platforms without `recursive:true` support (e.g. Linux,
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`) and filesystems delivering no event despite platform
  support (network mounts, some container overlays) were not verified on those platforms, only
  inspected in code.

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
