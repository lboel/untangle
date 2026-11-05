/**
 * ESLint-Regel `no-forged-completeness` (WP-165, E4).
 *
 * Sie schliesst genau die Luecke, die das TypeScript-Typsystem nicht schliessen
 * kann. `CompletenessClaimV1` (packages/testkit/src/honesty/completeness.ts)
 * traegt eine Pflichteigenschaft unter einem nicht exportierten
 * `unique symbol`; ein Objektliteral kann den Typ deshalb nicht erfuellen --
 * das ist strukturell erzwungen und braucht keine Lint-Regel. Was TypeScript
 * NICHT verhindern kann, ist eine Typumdeutung:
 *
 *     const forged = { level: "complete", ... } as CompletenessClaimV1;
 *     const forged2 = someJson as unknown as CompletenessClaimV1;
 *
 * Genau diese Form verbietet diese Regel. Der einzige vorgesehene Weg zu einer
 * Vollstaendigkeitsaussage ist `claimCompleteness({ subject, evidence })`,
 * das die Stufe aus dem Beleg ABLEITET, oder `parseCompletenessClaim` fuer
 * Daten aus fremder Quelle.
 *
 * Zusaetzlich verboten: ein Objektliteral, das eine `level`-Eigenschaft mit dem
 * Literal `"complete"` neben einer `evidence`- oder
 * `completenessWitness`-Eigenschaft setzt. Das ist die Form, mit der jemand
 * einen Anspruch von Hand nachbaut, um ihn spaeter umzudeuten -- sie ist auch
 * ohne die Umdeutung schon der falsche Weg.
 *
 * Ausgenommen ist die eine Zeile in `completeness.ts` selbst, die den Anspruch
 * baut: der Symbolschluessel existiert nur im Typraum, ein Laufzeitobjekt kann
 * ihn nicht tragen, also ist dort genau eine Umdeutung unvermeidbar. Die
 * Ausnahme wird ueber den Dateipfad gezogen, nicht ueber einen
 * Unterdrueckungskommentar, damit sie nicht wandert.
 */

/** @type {import("eslint").Rule.RuleModule} */
const noForgedCompleteness = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Verbietet das Faelschen einer Vollstaendigkeitsaussage per Typumdeutung oder Objektliteral (E4).",
    },
    schema: [
      {
        type: "object",
        properties: {
          typeName: { type: "string" },
          allowedFilePattern: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forgedCast:
        "A completeness claim must not be produced by a type assertion. Build it with claimCompleteness({ subject, evidence }) -- the level is derived from the evidence, never asserted (E4, WP-165).",
      forgedLiteral:
        'Do not hand-build a completeness claim object literal with level: "complete". Call claimCompleteness({ subject, evidence }); "complete" is derived from the evidence it carries (E4, WP-165).',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const typeName = options.typeName ?? "CompletenessClaimV1";
    const allowedFilePattern = options.allowedFilePattern ?? "honesty/completeness\\.ts$";
    const filename = context.filename ?? context.getFilename();
    if (new RegExp(allowedFilePattern).test(filename.replace(/\\/g, "/"))) {
      return {};
    }

    /** True, wenn die Typannotation (auch verschachtelt) auf `typeName` endet. */
    function mentionsClaimType(node) {
      if (node === null || node === undefined) return false;
      if (node.type === "TSTypeReference") {
        const name = node.typeName;
        if (name.type === "Identifier" && name.name === typeName) return true;
        if (name.type === "TSQualifiedName" && name.right?.name === typeName) return true;
        return (node.typeArguments?.params ?? node.typeParameters?.params ?? []).some(
          mentionsClaimType,
        );
      }
      if (node.type === "TSArrayType") return mentionsClaimType(node.elementType);
      if (node.type === "TSUnionType" || node.type === "TSIntersectionType") {
        return node.types.some(mentionsClaimType);
      }
      if (node.type === "TSParenthesizedType") return mentionsClaimType(node.typeAnnotation);
      return false;
    }

    function checkAssertion(node) {
      if (mentionsClaimType(node.typeAnnotation)) {
        context.report({ node, messageId: "forgedCast" });
      }
    }

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
      TSSatisfiesExpression: checkAssertion,

      ObjectExpression(node) {
        let setsComplete = false;
        let looksLikeClaim = false;
        for (const property of node.properties) {
          if (property.type !== "Property" || property.computed) continue;
          const key =
            property.key.type === "Identifier"
              ? property.key.name
              : property.key.type === "Literal"
                ? String(property.key.value)
                : undefined;
          if (key === undefined) continue;
          if (
            key === "level" &&
            property.value.type === "Literal" &&
            property.value.value === "complete"
          ) {
            setsComplete = true;
          }
          if (key === "evidence" || key === "completenessWitness") {
            looksLikeClaim = true;
          }
        }
        if (setsComplete && looksLikeClaim) {
          context.report({ node, messageId: "forgedLiteral" });
        }
      },
    };
  },
};

export default noForgedCompleteness;

/** Als Flat-Config-Plugin verwendbar: `plugins: { untangle: untanglePlugin }`. */
export const untangleHonestyPlugin = {
  rules: { "no-forged-completeness": noForgedCompleteness },
};
