// @ts-check
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import importX, { createNodeResolver } from "eslint-plugin-import-x";
import globals from "globals";
import tseslint from "typescript-eslint";

import { untangleHonestyPlugin } from "./packages/testkit/eslint/no-forged-completeness.js";

/**
 * Architecture boundary rules from `architecture.md` §5.2 ("Dependency Rules"),
 * enforced as `no-restricted-imports` per source area. These are deliberately
 * expressed against both the internal package name (`@untangle-code/<name>`)
 * and relative-path fallbacks, since not every internal package is published
 * under its scoped name from day one.
 *
 * Boundaries NOT yet encoded here (out of this task's scope, left for the
 * owning package's own lint config once it exists): "VS-Code-Extension darf
 * keine internen Indexerimplementierungen importieren".
 */
const adapterPackagePatterns = [
  "@untangle-code/storage-*",
  "@untangle-code/embeddings-*",
  "@untangle-code/parser-registry",
  "**/packages/storage-*/**",
  "**/packages/embeddings-*/**",
  "**/packages/parser-registry/**",
];

const mcpCliPackagePatterns = [
  "@untangle-code/cli",
  "@untangle-code/mcp-server",
  "**/apps/cli/**",
  "**/apps/mcp-server/**",
];

const uiPackagePatterns = [
  "vscode",
  "@untangle-code/vscode-extension",
  "**/apps/vscode-extension/**",
  "**/plugins/**",
];

const embeddingsPackagePatterns = ["@untangle-code/embeddings-*", "**/packages/embeddings-*/**"];

export default tseslint.config(
  {
    ignores: [
      // Local indexes and immutable evidence may contain foreign generated code
      // and frozen helper snapshots. Active helpers use `pnpm lint:evidence`.
      ".untangle/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/*.tsbuildinfo",
      "**/node_modules/**",
      "fixtures/**",
      "benchmarks/**",
      "docs/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver(), createNodeResolver()],
    },
    rules: {
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "Date.now() is non-deterministic in domain/analysis logic — inject a Clock port instead (spec.md §5, rule 5).",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            "Math.random() is non-deterministic in domain/analysis logic — inject a Random port instead (spec.md §5, rule 5).",
        },
      ],
    },
  },
  {
    // Die EINE Stelle, an der die Wanduhr gelesen werden darf.
    //
    // Die Determinismusregel oben haelt `Date.now()` aus der Analyse-Logik
    // heraus. Damit sie das kann, muss es genau einen Ort geben, an dem der
    // `Clock`-Port fuer den echten Prozess implementiert wird — sonst waere die
    // Regel nicht streng, sondern unerfuellbar. Die Ausnahme steht hier und
    // nicht als `eslint-disable` im Code, damit sie sichtbar bleibt und sich
    // nicht unbemerkt in weitere Dateien ausbreitet.
    //
    // `Math.random()` ist AUCH HIER nicht erlaubt: `system.ts` benutzt
    // `node:crypto`.
    files: ["apps/cli/src/cli/system.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            "Math.random() is non-deterministic — use node:crypto here (spec.md §5, rule 5).",
        },
      ],
    },
  },
  {
    // architecture.md §5.2: "domain importiert Adapter" ist verboten.
    files: ["packages/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: adapterPackagePatterns.map((group) => ({
            group: [group],
            message:
              "packages/domain must not import storage/embeddings/parser adapters (architecture.md §5.2).",
          })),
        },
      ],
    },
  },
  {
    // architecture.md §5.2: "Parseradapter importieren MCP oder CLI" ist verboten.
    files: ["packages/parser-registry/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: mcpCliPackagePatterns.map((group) => ({
            group: [group],
            message: "Parser adapters must not import MCP or CLI (architecture.md §5.2).",
          })),
        },
      ],
    },
  },
  {
    // architecture.md §5.2: "Storage-Qdrant kennt UI-Typen" ist verboten.
    files: ["packages/storage-qdrant/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: uiPackagePatterns.map((group) => ({
            group: [group],
            message: "storage-qdrant must not import UI types (architecture.md §5.2).",
          })),
        },
      ],
    },
  },
  {
    // architecture.md §5.2: "Complexity Engine ruft Embeddings auf" ist verboten.
    files: ["packages/complexity/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: embeddingsPackagePatterns.map((group) => ({
            group: [group],
            message: "packages/complexity must not import embeddings (architecture.md §5.2).",
          })),
        },
      ],
    },
  },
  {
    // E4 (WP-165): "complete" darf nur ueber `claimCompleteness()` entstehen,
    // das die Stufe aus dem Beleg ableitet. Das TypeScript-Typsystem verhindert
    // das Objektliteral (Pflichtmarke unter einem nicht exportierten
    // `unique symbol`), aber keine Typumdeutung — genau die verbietet diese
    // Regel. Siehe packages/testkit/src/honesty/completeness.ts.
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    plugins: { untangle: untangleHonestyPlugin },
    rules: {
      "untangle/no-forged-completeness": "error",
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.js",
      "**/vitest.config.ts",
      "**/vitest.workspace.ts",
      "eslint.config.js",
      "packages/testkit/eslint/**/*.js",
    ],
    rules: {
      "import-x/no-extraneous-dependencies": "off",
    },
  },
  {
    // typescript-eslint's and eslint-plugin-import-x's own docs use exactly this
    // `import tseslint from "typescript-eslint"; tseslint.configs...` / `import
    // importX from "eslint-plugin-import-x"; importX.flatConfigs...` pattern —
    // import-x's default-vs-named heuristic flags it anyway. False positive for
    // this specific, upstream-documented usage.
    files: ["eslint.config.js"],
    rules: {
      "import-x/no-named-as-default": "off",
      "import-x/no-named-as-default-member": "off",
    },
  },
  prettierConfig,
);
