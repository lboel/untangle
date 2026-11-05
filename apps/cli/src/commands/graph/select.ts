/**
 * Von dem, was ein Nutzer tippt, zu dem Knoten, den er meint.
 *
 * Ein Nutzer tippt `src/orders.ts`, `./services/api/src/orders.ts`,
 * `/abs/pfad/services/api/src/orders.ts` oder `orders.ts` — der Graph kennt
 * nur repo-relative, `/`-normalisierte Pfade. Diese Datei uebersetzt das, und
 * zwar unter einer Bedingung: SIE WAEHLT NIE. Passen mehrere Dateien, kommt
 * die Liste zurueck und der Befehl fragt nach; passt keine, ist das ein
 * benannter Fehlschlag und keine leere Antwort (E4).
 */
import type { FileNodeV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

export type FileSelectionV1 =
  | { status: "found"; node: FileNodeV1; matchedBy: "path" | "suffix" | "file_id" }
  | { status: "ambiguous"; candidates: FileNodeV1[] }
  | { status: "absent"; near: FileNodeV1[] };

/** `"/"`-Normalisierung und Abwurf fuehrender `./`; identisch zur Graphform. */
export function normalizeQuery(raw: string): string {
  let value = raw.replaceAll("\\", "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.startsWith("/")) value = value.slice(1);
  return value;
}

function byPath(left: FileNodeV1, right: FileNodeV1): number {
  return (
    compareCodepoints(left.filePath, right.filePath) || compareCodepoints(left.fileId, right.fileId)
  );
}

/**
 * Sucht den Knoten zu `query`.
 *
 * Reihenfolge der Proben, von der staerksten Aussage zur schwaechsten:
 * exakte `file_id`, exakter Pfad, Pfadendung. Erst wenn eine Stufe MEHRERE
 * Treffer hat, wird gefragt — eine schwaechere Stufe wird gar nicht mehr
 * betrachtet, sonst verdraengte ein zufaelliges Suffix einen exakten Treffer.
 */
export function selectFileNode(nodes: readonly FileNodeV1[], query: string): FileSelectionV1 {
  const wanted = normalizeQuery(query);

  const byId = nodes.filter((node) => node.fileId === query);
  if (byId.length === 1)
    return { status: "found", node: byId[0] as FileNodeV1, matchedBy: "file_id" };

  const exact = nodes.filter((node) => node.filePath === wanted);
  if (exact.length === 1)
    return { status: "found", node: exact[0] as FileNodeV1, matchedBy: "path" };
  if (exact.length > 1) return { status: "ambiguous", candidates: [...exact].sort(byPath) };

  const suffix = nodes.filter((node) => node.filePath.endsWith(`/${wanted}`));
  if (suffix.length === 1)
    return { status: "found", node: suffix[0] as FileNodeV1, matchedBy: "suffix" };
  if (suffix.length > 1) return { status: "ambiguous", candidates: [...suffix].sort(byPath) };

  // „Aehnlich" wird ueber den Dateinamen OHNE Endung gesucht: wer sich in der
  // Endung vertippt (`orders.tsx` statt `orders.ts`), bekommt sonst eine
  // leere Antwort auf eine Frage, deren Antwort direkt danebenliegt.
  const stem = stemOfBasename(wanted).toLowerCase();
  const near =
    stem === ""
      ? []
      : nodes
          .filter((node) => node.filePath.toLowerCase().includes(stem))
          .sort(byPath)
          .slice(0, 10);
  return { status: "absent", near };
}

function stemOfBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}
