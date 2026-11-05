import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

/**
 * Fast, network-free unit suite. `*.integration.test.ts` files talk to a
 * real Ollama instance and must never be part of this default run (rule 6) —
 * they live in a separate `vitest.integration.config.ts` invoked explicitly
 * via `pnpm test:integration`.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.integration.test.ts"],
    },
  }),
);
