import { defineConfig } from "vitest/config";

/**
 * Shared Vitest base configuration for every Untangle package.
 *
 * Packages import and extend this file instead of repeating these defaults:
 *
 * ```ts
 * // packages/<name>/vitest.config.ts
 * import { defineConfig, mergeConfig } from "vitest/config";
 * import baseConfig from "../../vitest.config.ts";
 *
 * export default mergeConfig(
 *   baseConfig,
 *   defineConfig({
 *     test: {
 *       // package-specific overrides only
 *     },
 *   }),
 * );
 * ```
 *
 * Rationale for the defaults below:
 * - `environment: "node"` — Untangle's engine is a Node.js library/CLI/MCP server;
 *   no DOM emulation is needed in unit tests.
 * - `globals: false` — tests import `describe`/`it`/`expect` explicitly, keeping
 *   type-checking strict (`verbatimModuleSyntax`) and avoiding ambient globals.
 * - `coverage.provider: "v8"` — no extra instrumentation dependency, accurate enough
 *   for gating, and fast on large monorepos.
 * - `testTimeout: 20000` — generous enough for fixture-heavy parser/graph tests
 *   without masking real hangs; live-network suites (`@live`) run in their own,
 *   separately invoked config and are not covered by this default.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 20000,
    restoreMocks: true,
    // The workspace is bootstrapped before any package exists yet (WP-00).
    // Without this, a fresh checkout with zero matched test files fails
    // `vitest run` outright instead of reporting a harmless empty pass.
    passWithNoTests: true,
    // Root-level project in vitest.workspace.ts: intentionally matches only
    // top-level test files plus `scripts/`, never `**`. Every package brings its
    // own `vitest.config.ts` project with its own `src/**/*.test.ts` include;
    // without this restriction the root project's default recursive include
    // would independently re-collect and re-run every package's tests a
    // second time in the same workspace run (see packages/domain's WP-01
    // report: 162 instead of 81 tests).
    // `scripts/**` gehoert keinem Paket und braeuchte sonst ein eigenes
    // Workspace-Projekt; die Aufnahme hier verdoppelt nichts, weil unter
    // `scripts/` keine Paket-Tests liegen.
    include: ["*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      exclude: ["**/*.d.ts", "**/*.config.ts", "**/dist/**", "**/fixtures/**"],
    },
  },
});
