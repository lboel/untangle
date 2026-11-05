/**
 * Dateiverzeichnis: die einzige Nachschlagequelle der Aufloesung.
 *
 * Die gesamte Modulaufloesung arbeitet gegen diesen Index und NICHT gegen das
 * Dateisystem. Grund: eine Aufloesung, die das Dateisystem befragt, haengt am
 * Zustand der Platte zum Zeitpunkt des Laufs und ist damit weder
 * reproduzierbar noch ohne echtes Repository testbar. Der Index wird einmal
 * aus der Dateiliste des Scanners gebaut; ab da ist jede Aufloesung eine reine
 * Funktion.
 */
import { compareCodepoints } from "@untangle-code/domain";

import { normalizePath } from "./paths.js";
import type { FileImportsV1, FileLookupV1 } from "./types.js";

/** Eintrag des Index — genau das, was die Aufloesung ueber eine Datei wissen muss. */
export interface FileIndexEntryV1 {
  fileId: string;
  repoId: string;
  refId: string;
  path: string;
  languageId: string;
  contentHash: string;
}

export class FileIndex implements FileLookupV1 {
  private readonly byRepoPath = new Map<string, FileIndexEntryV1>();
  private readonly byFileId = new Map<string, FileIndexEntryV1>();
  private readonly repos = new Set<string>();

  static fromFiles(files: readonly FileImportsV1[]): FileIndex {
    const index = new FileIndex();
    for (const file of files) {
      index.add({
        fileId: file.fileId,
        repoId: file.repoId,
        refId: file.refId,
        path: normalizePath(file.path),
        languageId: file.languageId,
        contentHash: file.contentHash,
      });
    }
    return index;
  }

  /**
   * Nimmt einen Eintrag auf und ERSETZT dabei jede fruehere Bindung derselben
   * `file_id`.
   *
   * Der zweite Schritt ist der wichtige: eine Umbenennung erreicht den Index
   * als `add()` mit neuem Pfad (`FileGraphChangeV1` kennt kein „renamed"). Wer
   * dabei nur den neuen Schluessel setzt, laesst den alten stehen — der Index
   * behauptet danach eine Datei unter einem Pfad, den keine Datei mehr hat,
   * und die Aufloesung meldet eine Kante dorthin als `resolved`. Ein Phantom
   * mit Aufloesungsrate 1 ist genau das stille Verschweigen, das E4 verbietet.
   */
  add(entry: FileIndexEntryV1): void {
    const normalized: FileIndexEntryV1 = { ...entry, path: normalizePath(entry.path) };
    const newKey = keyOf(normalized.repoId, normalized.path);
    const previous = this.byFileId.get(normalized.fileId);
    if (previous !== undefined) {
      const previousKey = keyOf(previous.repoId, previous.path);
      // Nur loeschen, wenn der alte Schluessel WIRKLICH noch auf diese Datei
      // zeigt: hat inzwischen eine andere Datei den Pfad uebernommen, waere das
      // Loeschen ein zweites Phantom — diesmal ein fehlendes statt eines
      // ueberzaehligen.
      if (
        previousKey !== newKey &&
        this.byRepoPath.get(previousKey)?.fileId === normalized.fileId
      ) {
        this.byRepoPath.delete(previousKey);
      }
    }
    this.byRepoPath.set(newKey, normalized);
    this.byFileId.set(normalized.fileId, normalized);
    this.repos.add(normalized.repoId);
  }

  /** Entfernt einen Eintrag; True, wenn er vorhanden war. */
  remove(fileId: string): boolean {
    const entry = this.byFileId.get(fileId);
    if (entry === undefined) {
      return false;
    }
    this.byFileId.delete(fileId);
    const key = keyOf(entry.repoId, entry.path);
    // Denselben Grund wie in `add()`: den Pfadschluessel nur freigeben, wenn er
    // noch auf genau diese Datei zeigt.
    if (this.byRepoPath.get(key)?.fileId === fileId) {
      this.byRepoPath.delete(key);
    }
    return true;
  }

  hasFile(repoId: string, path: string): boolean {
    return this.byRepoPath.has(keyOf(repoId, normalizePath(path)));
  }

  fileIdOf(repoId: string, path: string): string | null {
    return this.byRepoPath.get(keyOf(repoId, normalizePath(path)))?.fileId ?? null;
  }

  entryOf(repoId: string, path: string): FileIndexEntryV1 | null {
    return this.byRepoPath.get(keyOf(repoId, normalizePath(path))) ?? null;
  }

  entryById(fileId: string): FileIndexEntryV1 | null {
    return this.byFileId.get(fileId) ?? null;
  }

  repoIds(): readonly string[] {
    return [...this.repos].sort(compareCodepoints);
  }

  get size(): number {
    return this.byFileId.size;
  }
}

/**
 * U+001F als Trenner: derselbe Trenner, den `domain`s ID-Ableitung nutzt. Er
 * kann in keinem Pfad und in keiner Repository-ID vorkommen, also kann der
 * Schluessel von ("ab", "c") nie mit dem von ("a", "bc") kollidieren.
 */
function keyOf(repoId: string, path: string): string {
  return `${repoId}\u001f${path}`;
}
