/**
 * Kleine, backend-neutrale Baumabfragen fuer das Tabellenprofil.
 *
 * Sie stehen getrennt von Scope-, Entscheidungs- und Modulregeln, damit jede
 * dieser Verantwortungen dieselbe Iterations- und Reihenfolgelogik benutzt.
 */
import type { SyntaxNode } from "./syntax.js";

export function setOf(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(values ?? []);
}

/** Der Text eines Namensknotens, oder nichts — nie ein erfundener Name. */
export function nameTextsOf(node: SyntaxNode | null): string[] {
  return node === null ? [] : [node.text];
}

/** Erster Kindknoten (in Quelltextreihenfolge), dessen Art in `kinds` liegt. */
export function firstChildOfKinds(node: SyntaxNode, kinds: ReadonlySet<string>): SyntaxNode | null {
  for (const child of node.children) {
    if (kinds.has(child.type)) return child;
  }
  return null;
}

/** Erstes direktes Kind genau einer Art. */
export function firstChildOfKind(node: SyntaxNode, kind: string): SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === kind) return child;
  }
  return null;
}

/**
 * Erstes Kind nach der REIHENFOLGE DER LISTE, nicht nach Quelltextreihenfolge.
 *
 * WOFUER: `using Sys = System.Text;` hat als Kinder `identifier` (Alias) UND
 * `qualified_name` (Pfad), in dieser Reihenfolge. Die Tabelle nennt deshalb
 * `qualified_name` zuerst und meint damit: erst das Genauere.
 */
export function firstChildByKindPriority(
  node: SyntaxNode,
  kinds: readonly string[],
): SyntaxNode | null {
  for (const kind of kinds) {
    const child = firstChildOfKind(node, kind);
    if (child !== null) return child;
  }
  return null;
}

/** Alle Knoten dieser Art im Teilbaum, in Quelltextreihenfolge (iterativ). */
export function descendantsOfKinds(node: SyntaxNode, kinds: ReadonlySet<string>): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as SyntaxNode;
    if (current !== node && kinds.has(current.type)) {
      found.push(current);
      continue;
    }
    const children = current.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index] as SyntaxNode);
    }
  }
  return found.sort((a, b) => a.startIndex - b.startIndex);
}

/** Erster passender Nachfahre, ohne den ganzen Teilbaum zu materialisieren. */
export function firstDescendantOfKinds(
  node: SyntaxNode,
  kinds: ReadonlySet<string>,
): SyntaxNode | null {
  const stack = [...node.children].reverse();
  while (stack.length > 0) {
    const current = stack.pop() as SyntaxNode;
    if (kinds.has(current.type)) return current;
    const children = current.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index] as SyntaxNode);
    }
  }
  return null;
}
