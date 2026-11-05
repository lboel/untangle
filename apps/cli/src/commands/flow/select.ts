/**
 * Von einem getippten Symbolnamen zum Knoten des Symbolgraphen.
 *
 * DIE REGEL DIESES MODULS IST DIESELBE WIE DIE DES SYMBOLGRAPHEN SELBST: bei
 * mehreren Kandidaten wird KEINER heimlich gewaehlt. `untangle flow` zeigt
 * dann alle und verlangt eine Entscheidung. Ein Werkzeug, das hier raet,
 * beantwortet eine andere Frage als die gestellte — und sagt es nicht.
 *
 * Erlaubte Schreibweisen, von der staerksten zur schwaechsten:
 *   `sym_ab12…`          die Symbol-ID
 *   `Klasse.methode`     der qualifizierte Name
 *   `pfad/datei.ts:name` Name in einer bestimmten Datei
 *   `name`               der blosse Name
 */
import type { SymbolNodeV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

export type SymbolSelectionV1 =
  | {
      status: "found";
      node: SymbolNodeV1;
      matchedBy: "symbol_id" | "qualified_name" | "file_and_name" | "name";
    }
  | { status: "ambiguous"; candidates: SymbolNodeV1[]; matchedBy: string }
  | { status: "absent"; near: SymbolNodeV1[] };

function order(left: SymbolNodeV1, right: SymbolNodeV1): number {
  return (
    compareCodepoints(left.filePath, right.filePath) ||
    left.startLine - right.startLine ||
    compareCodepoints(left.id, right.id)
  );
}

/** Beschreibt einen Kandidaten so, dass der Nutzer ihn eindeutig nachtippen kann. */
export function describeSymbol(node: SymbolNodeV1): string {
  return `${node.qualifiedName}  ${node.filePath}:${String(node.startLine)}  [${node.kind}]`;
}

export function selectSymbolNode(nodes: readonly SymbolNodeV1[], query: string): SymbolSelectionV1 {
  const trimmed = query.trim();

  const byId = nodes.filter((node) => node.id === trimmed);
  if (byId.length === 1) {
    return { status: "found", node: byId[0] as SymbolNodeV1, matchedBy: "symbol_id" };
  }

  const byQualified = nodes.filter((node) => node.qualifiedName === trimmed);
  if (byQualified.length === 1) {
    return { status: "found", node: byQualified[0] as SymbolNodeV1, matchedBy: "qualified_name" };
  }
  if (byQualified.length > 1) {
    return {
      status: "ambiguous",
      candidates: [...byQualified].sort(order),
      matchedBy: "qualified_name",
    };
  }

  // `pfad/datei.ts:name` — der Doppelpunkt trennt nur, wenn rechts davon kein
  // Pfadtrenner mehr steht.
  const separator = trimmed.lastIndexOf(":");
  if (separator > 0 && !trimmed.slice(separator + 1).includes("/")) {
    const filePart = trimmed.slice(0, separator).replaceAll("\\", "/");
    const namePart = trimmed.slice(separator + 1);
    const inFile = nodes.filter(
      (node) =>
        (node.name === namePart || node.qualifiedName === namePart) &&
        (node.filePath === filePart || node.filePath.endsWith(`/${filePart}`)),
    );
    if (inFile.length === 1) {
      return { status: "found", node: inFile[0] as SymbolNodeV1, matchedBy: "file_and_name" };
    }
    if (inFile.length > 1) {
      return {
        status: "ambiguous",
        candidates: [...inFile].sort(order),
        matchedBy: "file_and_name",
      };
    }
  }

  const byName = nodes.filter((node) => node.name === trimmed);
  if (byName.length === 1) {
    return { status: "found", node: byName[0] as SymbolNodeV1, matchedBy: "name" };
  }
  if (byName.length > 1) {
    return { status: "ambiguous", candidates: [...byName].sort(order), matchedBy: "name" };
  }

  const lowered = trimmed.toLowerCase();
  const near = nodes
    .filter(
      (node) =>
        node.name.toLowerCase().includes(lowered) ||
        node.qualifiedName.toLowerCase().includes(lowered),
    )
    .sort(order)
    .slice(0, 10);
  return { status: "absent", near };
}
