import { defineWorkspace } from "vitest/config";

/**
 * Root Vitest workspace: auto-collects every package's own `vitest.config.ts`.
 *
 * A package only needs to exist with that filename to be picked up — nothing here
 * needs editing when a new package/app is added. Deliberately excluded by
 * convention (not by this file):
 * - live/network suites, which packages expose as a *separate* config file
 *   (e.g. `vitest.live.config.ts`, run explicitly via that package's
 *   `test:live` script, see `spec.md` §27 / `docs/BUILD_PLAN.md` R3);
 * - `fixtures/` and `benchmarks/`, which are data/eval workspaces, not test
 *   suites, and are invoked via their own `pnpm --filter <name> run ...` scripts.
 *
 * Running `vitest run` (or `pnpm run test:unit`) from the repo root uses this
 * file automatically and executes every collected package in one process.
 *
 * The root `vitest.config.ts` is included as a project too (it matches zero
 * test files by itself, `passWithNoTests` covers that) purely so the
 * workspace has at least one resolved project before any package exists yet
 * — Vitest treats a workspace that resolves to zero projects as a hard
 * startup error, which would otherwise break `pnpm run test:unit` on a fresh
 * checkout of this scaffold.
 */
export default defineWorkspace([
  "vitest.config.ts",
  "packages/*/vitest.config.ts",
  "apps/*/vitest.config.ts",
]);
