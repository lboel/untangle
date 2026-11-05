/**
 * Selbsttest der Lint-Regel: sie muss die Umgehungen fangen, die das
 * Typsystem nicht fangen kann, und darf den vorgesehenen Weg nicht behindern.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import rule from "./no-forged-completeness.js";

const ruleTester = new RuleTester({
  languageOptions: {
    // eslint-disable-next-line import-x/no-named-as-default-member -- tseslint.parser ist die von typescript-eslint dokumentierte Form
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

describe("no-forged-completeness", () => {
  it("catches every forgery the type system cannot", () => {
    ruleTester.run("no-forged-completeness", rule, {
      valid: [
        {
          code: 'const claim = claimCompleteness({ subject: "a.ts", evidence });',
          filename: "packages/chunker/src/x.ts",
        },
        {
          code: 'const claim = parseCompletenessClaim(json, "from disk");',
          filename: "packages/chunker/src/x.ts",
        },
        {
          // Andere Typumdeutungen bleiben erlaubt.
          code: "const value = raw as SourceRange;",
          filename: "packages/chunker/src/x.ts",
        },
        {
          // Ein Literal mit level:"complete" ohne Anspruchs-Umfeld ist harmlos.
          code: 'const status = { level: "complete", note: "n" };',
          filename: "packages/chunker/src/x.ts",
        },
        {
          // Die eine unvermeidbare Stelle im Modul selbst ist ausgenommen.
          code: "return built as CompletenessClaimV1;",
          filename: "packages/testkit/src/honesty/completeness.ts",
        },
      ],
      invalid: [
        {
          code: 'const forged = { level: "complete" } as CompletenessClaimV1;',
          filename: "packages/chunker/src/x.ts",
          errors: [{ messageId: "forgedCast" }],
        },
        {
          code: "const forged = json as unknown as CompletenessClaimV1;",
          filename: "packages/chunker/src/x.ts",
          errors: [{ messageId: "forgedCast" }],
        },
        {
          code: "const forged = <CompletenessClaimV1>json;",
          filename: "packages/chunker/src/x.ts",
          errors: [{ messageId: "forgedCast" }],
        },
        {
          code: "const forged = claims satisfies CompletenessClaimV1[];",
          filename: "packages/chunker/src/x.ts",
          errors: [{ messageId: "forgedCast" }],
        },
        {
          code: 'const forged = { level: "complete", evidence: { expected: 1, accountedFor: 0 } };',
          filename: "packages/chunker/src/x.ts",
          errors: [{ messageId: "forgedLiteral" }],
        },
        {
          code: 'const forged = { completenessWitness: "untangle.completeness.v1", level: "complete" };',
          filename: "packages/chunker/src/x.ts",
          errors: [{ messageId: "forgedLiteral" }],
        },
      ],
    });
  });
});
