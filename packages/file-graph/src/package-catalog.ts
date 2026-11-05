/**
 * Der Paketkatalog des Workspace — nach Repository UND Name geschluesselt.
 *
 * WARUM NICHT NACH NAMEN ALLEIN: Ein Workspace darf aus mehreren Repositories
 * bestehen (genau das ist der Cross-Repo-Fall, den dieses Paket koennen soll).
 * Paketnamen sind dann NICHT eindeutig: zwei Repositories duerfen beide ein
 * `shared-lib` enthalten, und in einem realen Bestand tun sie es auch — ein
 * abgespaltener Fork, eine geteilte Bibliothek in zwei Staenden, ein
 * gleichnamiges internes Hilfspaket. Ein `Map<name, package>` verliert in
 * diesem Moment das frueher eingefuegte Paket ERSATZLOS: seine
 * Abhaengigkeiten werden aus dem fremden Manifest gefuellt, seine Dateien
 * werden nie mehr ueber den Katalog gefunden, und ein Import auf den Namen
 * loest ins falsche Repository auf — gezaehlt als Erfolg.
 *
 * Der Katalog haelt deshalb ALLE gleichnamigen Pakete und beantwortet jede
 * Frage aus der Sicht eines fragenden Repositories. Mehrdeutigkeit wird
 * gemeldet, nicht aufgeloest (E4).
 */
import { compareCodepoints } from "@untangle-code/domain";

import type { PackageLookupV1, WorkspacePackageCatalogV1, WorkspacePackageV1 } from "./types.js";

/** Stabile Ordnung des Katalogs: Name, Repository, Verzeichnis. */
export function comparePackages(left: WorkspacePackageV1, right: WorkspacePackageV1): number {
  return (
    compareCodepoints(left.name, right.name) ||
    compareCodepoints(left.repoId, right.repoId) ||
    compareCodepoints(left.packageDir, right.packageDir) ||
    compareCodepoints(left.manifestPath, right.manifestPath)
  );
}

export class WorkspacePackageCatalog implements WorkspacePackageCatalogV1 {
  private readonly entries: WorkspacePackageV1[];
  private readonly byName = new Map<string, WorkspacePackageV1[]>();
  private readonly byRepoAndName = new Map<string, WorkspacePackageV1[]>();

  constructor(packages: readonly WorkspacePackageV1[]) {
    this.entries = [...packages].sort(comparePackages);
    for (const entry of this.entries) {
      const bucket = this.byName.get(entry.name);
      if (bucket === undefined) {
        this.byName.set(entry.name, [entry]);
      } else {
        bucket.push(entry);
      }
      // Auch innerhalb EINES Repositories ist der Name nicht garantiert
      // eindeutig: zwei Verzeichnisse duerfen dasselbe `name`-Feld tragen
      // (ein kopiertes Paket, ein halb vollzogener Umzug). Das ist ein Fehler
      // des Bestandes — aber ihn zu glaetten, indem der erste in kanonischer
      // Ordnung gewinnt, ist GERATEN: der Bereich im Manifest des
      // Importierenden kann sehr wohl auf das zweite zeigen. Der Katalog
      // haelt deshalb auch hier ALLE Eintraege und laesst `lookup` melden
      // statt entscheiden (E4).
      const key = keyOf(entry.repoId, entry.name);
      const owned = this.byRepoAndName.get(key);
      if (owned === undefined) {
        this.byRepoAndName.set(key, [entry]);
      } else {
        owned.push(entry);
      }
    }
  }

  all(): readonly WorkspacePackageV1[] {
    return this.entries;
  }

  byPackageName(name: string): readonly WorkspacePackageV1[] {
    return this.byName.get(name) ?? [];
  }

  /**
   * Das Paket dieses Namens in diesem Repository — nur wenn es GENAU EINES
   * gibt. Bei mehreren gleichnamigen Manifesten desselben Repositories ist
   * `null` die einzige ehrliche Antwort; welches gemeint ist, steht nirgends,
   * und `lookup` meldet den Fall als `ambiguous`.
   */
  inRepo(repoId: string, name: string): WorkspacePackageV1 | null {
    const owned = this.byRepoAndName.get(keyOf(repoId, name)) ?? [];
    return owned.length === 1 ? (owned[0] as WorkspacePackageV1) : null;
  }

  /** Alle Pakete dieses Namens in diesem Repository, kanonisch geordnet. */
  inRepoAll(repoId: string, name: string): readonly WorkspacePackageV1[] {
    return this.byRepoAndName.get(keyOf(repoId, name)) ?? [];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Sucht `name` aus der Sicht von `fromRepoId`.
   *
   * REIHENFOLGE UND IHR GRUND: Das eigene Repository zuerst — ein Manifest, das
   * `shared-lib` deklariert, meint zuerst das `shared-lib`, das neben ihm
   * liegt. Gibt es dort keines und genau EIN fremdes, ist der Cross-Repo-Bezug
   * die einzige moegliche Lesart und damit ein Treffer. Gibt es mehrere
   * fremde, ist der Bezug ohne weitere Angabe nicht entscheidbar — und dann
   * wird geraten oder gemeldet. Geraten wird nicht.
   */
  lookup(fromRepoId: string, name: string): PackageLookupV1 {
    const own = this.inRepoAll(fromRepoId, name);
    if (own.length === 1) {
      return { status: "found", entry: own[0] as WorkspacePackageV1, crossRepo: false };
    }
    // Mehrere gleichnamige Pakete im EIGENEN Repository: nicht auf das erste
    // ausweichen und erst recht nicht ins fremde Repository weitersuchen —
    // beides waere geraten. Die Kandidaten sind die des eigenen Repositories.
    if (own.length > 1) return { status: "ambiguous", candidates: own };
    const candidates = this.byPackageName(name);
    if (candidates.length === 0) return { status: "absent" };
    if (candidates.length === 1) {
      return { status: "found", entry: candidates[0] as WorkspacePackageV1, crossRepo: true };
    }
    return { status: "ambiguous", candidates };
  }

  /**
   * Namen, die von MEHR ALS EINEM Manifest deklariert werden,
   * codepoint-sortiert.
   *
   * Frueher wurde hier `repos.size > 1` gefragt — damit blieb die Doppelung
   * INNERHALB eines Repositories unsichtbar, obwohl genau sie einen Import
   * unentscheidbar macht. Massstab ist die Zahl der Manifeste, nicht die der
   * Repositories.
   */
  ambiguousNames(): readonly string[] {
    const names: string[] = [];
    for (const [name, bucket] of this.byName) {
      if (bucket.length > 1) names.push(name);
    }
    return names.sort(compareCodepoints);
  }
}

/**
 * U+001F als Trenner: derselbe Trenner wie in `file-index.ts`. Er kommt weder
 * in einer Repository-ID noch in einem Paketnamen vor, also kann der
 * Schluessel von ("ab", "c") nie mit dem von ("a", "bc") kollidieren.
 */
function keyOf(repoId: string, name: string): string {
  return `${repoId}\u001f${name}`;
}
