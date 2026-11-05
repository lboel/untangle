/**
 * @untangle-code/observability — the only public export of this package.
 *
 * Errors (architecture.md §22.1), structured logging (§24.2), redaction
 * (spec.md §24), correlation ids (§24.1), metrics (spec.md §23.3) and
 * `--profile` collection (architecture.md §24.3). No I/O beyond
 * `process.stderr`/`process.memoryUsage`; no network, no filesystem.
 */

// Errors — factories on top of domain's UntangleError, plus envelope mapping.
export * from "./errors.js";

// Redaction.
export * from "./redact.js";

// Correlation ids.
export * from "./correlation.js";

// Structured logger (LoggerPort implementation).
export * from "./logger.js";

// Metrics registry (spec.md §23.3).
export * from "./metrics.js";

// Profiling collector (architecture.md §24.3).
export * from "./profiling.js";
