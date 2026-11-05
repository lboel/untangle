import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

/**
 * Separate config for the real-Ollama integration suite (rule 6). It is not
 * referenced by the root vitest.workspace.ts, which only auto-collects each
 * package's plain "vitest.config.ts" — so this file is never picked up by
 * the root `test:unit` / `pnpm -r run test` runs, only by this package's
 * explicit `pnpm --filter @untangle-code/embeddings-ollama run test:integration`.
 * The suite self-skips (via `describe.skipIf`) when 127.0.0.1:11434 does not
 * answer, so an accidental invocation in an environment without Ollama still
 * exits green instead of failing the run.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/**/*.integration.test.ts"],
      testTimeout: 60000,
    },
  }),
);
