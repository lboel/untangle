/**
 * Laden und Auffinden von Extension-Manifesten (extensions.md §17, §6.1).
 *
 * Zwei Wege, streng getrennt:
 *
 * - `discoverExtensions` durchsucht die NUTZER-Wurzeln aus `paths.ts`. Das ist
 *   der automatische Weg, und er beruehrt das Projektverzeichnis nie.
 * - `loadExtensionFrom` laedt EINEN ausdruecklich genannten Pfad
 *   (`untangle extensions add --from <pfad>`). Zeigt dieser Pfad in ein
 *   Projektverzeichnis, verweigert die Funktion — es sei denn, der Aufrufer
 *   reicht `allowProjectLocal` durch, was nur eine bewusste Nutzeraktion
 *   rechtfertigt. Die Begruendung steht in `paths.ts`.
 *
 * Nichts wird hier gestartet. Laden ist Lesen und Pruefen; ein Prozessstart
 * verlangt zusaetzlich `enable`, das Lizenz-Gate und einen ausdruecklichen
 * Lauf (X1, X5).
 */
import { join } from "node:path";

import type {
  ExtensionManifestIssue,
  ExtensionManifestV1,
  FileSystemPort,
} from "@untangle-code/domain";
import { compareCodepoints, sha256Hex } from "@untangle-code/domain";

import { MANIFEST_FILE_NAME, extensionManifestPath, isProjectLocalManifest } from "../paths.js";

import { parseExtensionManifest } from "./shape.js";

/** Woher ein Manifest stammt — Teil jeder Anzeige (extensions.md §17, WP-109). */
export const MANIFEST_ORIGINS = ["user-data-dir", "explicit-path"] as const;

export type ManifestOrigin = (typeof MANIFEST_ORIGINS)[number];

/** Ein geladenes, vollstaendig geprueftes Manifest. */
export interface LoadedExtensionV1 {
  manifest: ExtensionManifestV1;
  origin: ManifestOrigin;
  /** Absoluter Pfad der gelesenen Datei — Herkunftsanzeige. */
  manifestPath: string;
  /** sha256 ueber den Manifesttext; erkennt Aenderungen ohne Neuparsen. */
  manifestSha256: string;
  /**
   * sha256 ueber `license.restrictionSummary`. Aendert sich die
   * Einschraenkung, verfaellt die Bestaetigung (extensions.md §9.2).
   */
  restrictionSummarySha256?: string;
}

/** Ein abgelehntes Manifest MIT Begruendung (E4). */
export interface RejectedManifestV1 {
  manifestPath: string;
  /** Verzeichnisname, aus dem die Extension-ID haette kommen sollen. */
  directoryName?: string;
  issues: ExtensionManifestIssue[];
}

/** Ein bewusst NICHT geladenes Manifest MIT Grund (E4). */
export interface IgnoredManifestV1 {
  manifestPath: string;
  reason: "project_local" | "no_manifest" | "duplicate_id" | "unreadable";
  detail: string;
}

/** Ergebnis eines Suchlaufs ueber die Nutzerwurzeln. */
export interface ExtensionDiscoveryResultV1 {
  extensions: LoadedExtensionV1[];
  rejected: RejectedManifestV1[];
  ignored: IgnoredManifestV1[];
  /** Welche Wurzeln durchsucht wurden und ob es sie gibt — nie stilles Nichts. */
  rootsScanned: { root: string; exists: boolean }[];
}

export interface DiscoverExtensionsOptions {
  /** Suchwurzeln, ueblicherweise aus `resolveExtensionRoots`. */
  roots: readonly string[];
  /**
   * Projektverzeichnisse. Faellt eine Wurzel (etwa durch eine falsch gesetzte
   * `UNTANGLE_EXTENSIONS_HOME`) in ein Projekt, wird sie NICHT durchsucht.
   */
  projectRoots?: readonly string[];
  signal?: AbortSignal;
}

/** Hash der Nutzungsbeschraenkung, sofern es eine gibt. */
function restrictionHash(manifest: ExtensionManifestV1): string | undefined {
  const summary = manifest.license.restrictionSummary;
  return summary === undefined ? undefined : sha256Hex(summary);
}

/**
 * Liest und prueft EIN Manifest.
 *
 * Liefert `null` statt zu werfen: eine kaputte Extension ist nie ein Fehler
 * des Kerns (X2). Der Grund steht in `issues`.
 */
export async function loadExtensionManifestFile(
  fs: FileSystemPort,
  manifestPath: string,
  origin: ManifestOrigin,
  options: { signal?: AbortSignal; expectedId?: string } = {},
): Promise<{ extension: LoadedExtensionV1 | null; issues: ExtensionManifestIssue[] }> {
  let text: string;
  try {
    text = await fs.readTextFile(
      manifestPath,
      options.signal === undefined ? {} : { signal: options.signal },
    );
  } catch (cause) {
    return {
      extension: null,
      issues: [
        {
          field: "",
          message: `manifest "${manifestPath}" could not be read: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        },
      ],
    };
  }

  const parsed = parseExtensionManifest(text);
  if (parsed.manifest === null) {
    return { extension: null, issues: parsed.issues };
  }
  if (options.expectedId !== undefined && parsed.manifest.id !== options.expectedId) {
    // Verzeichnisname und `id` MUESSEN uebereinstimmen: die ID ist zugleich
    // Verzeichnisname (extensions.md §4.1). Weichen sie ab, waere unklar,
    // welche der beiden Kennungen `enable`/`run` meint.
    return {
      extension: null,
      issues: [
        {
          field: "id",
          message: `manifest id "${parsed.manifest.id}" does not match its directory name "${options.expectedId}"`,
        },
      ],
    };
  }

  const summaryHash = restrictionHash(parsed.manifest);
  return {
    extension: {
      manifest: parsed.manifest,
      origin,
      manifestPath,
      manifestSha256: sha256Hex(text),
      ...(summaryHash === undefined ? {} : { restrictionSummarySha256: summaryHash }),
    },
    issues: [],
  };
}

/**
 * Durchsucht die Nutzerwurzeln nach `<root>/<id>/manifest.toml`.
 *
 * Nicht rekursiv und mit fester Tiefe: eine Extension ist genau ein
 * Verzeichnis mit genau einem Manifest. Das haelt die Suche vorhersagbar und
 * verhindert, dass ein tief verschachteltes Manifest unbemerkt mitkommt.
 */
export async function discoverExtensions(
  fs: FileSystemPort,
  options: DiscoverExtensionsOptions,
): Promise<ExtensionDiscoveryResultV1> {
  const result: ExtensionDiscoveryResultV1 = {
    extensions: [],
    rejected: [],
    ignored: [],
    rootsScanned: [],
  };
  const projectRoots = options.projectRoots ?? [];
  const call = options.signal === undefined ? {} : { signal: options.signal };

  for (const root of options.roots) {
    if (isProjectLocalManifest(root, projectRoots)) {
      result.rootsScanned.push({ root, exists: false });
      result.ignored.push({
        manifestPath: root,
        reason: "project_local",
        detail:
          `extension root "${root}" lies inside a project directory and is never scanned; ` +
          "a cloned repository must not be able to bring an executable tool with it",
      });
      continue;
    }

    let entries;
    try {
      entries = await fs.readDir(root, call);
    } catch {
      // Eine fehlende Extension-Wurzel ist der NORMALFALL: ohne Extensions
      // gibt es das Verzeichnis nicht. Kein Fehler, aber sichtbar in
      // `rootsScanned` (X2).
      result.rootsScanned.push({ root, exists: false });
      continue;
    }
    result.rootsScanned.push({ root, exists: true });

    const directories = entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.name)
      .sort(compareCodepoints);

    for (const name of directories) {
      const manifestPath = extensionManifestPath(root, name);
      const stat = await fs.stat(manifestPath, call);
      if (stat === null || stat.kind !== "file") {
        result.ignored.push({
          manifestPath,
          reason: "no_manifest",
          detail: `directory "${name}" contains no ${MANIFEST_FILE_NAME}`,
        });
        continue;
      }
      const loaded = await loadExtensionManifestFile(fs, manifestPath, "user-data-dir", {
        ...call,
        expectedId: name,
      });
      if (loaded.extension === null) {
        result.rejected.push({ manifestPath, directoryName: name, issues: loaded.issues });
        continue;
      }
      const extension = loaded.extension;
      const duplicate = result.extensions.find(
        (existing) => existing.manifest.id === extension.manifest.id,
      );
      if (duplicate !== undefined) {
        // Frueher Wurzel gewinnt; die spaetere wird gemeldet, nicht verschluckt.
        result.ignored.push({
          manifestPath,
          reason: "duplicate_id",
          detail: `extension "${name}" is already provided by "${duplicate.manifestPath}"`,
        });
        continue;
      }
      result.extensions.push(extension);
    }
  }

  result.extensions.sort((left, right) => compareCodepoints(left.manifest.id, right.manifest.id));
  return result;
}

export interface LoadExtensionFromOptions {
  /**
   * Erlaubt einen Pfad innerhalb eines Projektverzeichnisses. NUR fuer einen
   * ausdruecklichen, vom Nutzer selbst getippten Aufruf — nie als Vorgabe.
   */
  allowProjectLocal?: boolean;
  projectRoots?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Laedt ein Manifest von einem ausdruecklich genannten Pfad
 * (`untangle extensions add --from <pfad>`).
 *
 * `path` darf die Manifestdatei selbst oder ihr Verzeichnis sein.
 */
export async function loadExtensionFrom(
  fs: FileSystemPort,
  path: string,
  options: LoadExtensionFromOptions = {},
): Promise<{ extension: LoadedExtensionV1 | null; issues: ExtensionManifestIssue[] }> {
  const call = options.signal === undefined ? {} : { signal: options.signal };
  const stat = await fs.stat(path, call);
  // `--from` darf auf die Datei oder auf ihr Verzeichnis zeigen.
  const effectivePath = stat?.kind === "directory" ? join(path, MANIFEST_FILE_NAME) : path;

  if (
    options.allowProjectLocal !== true &&
    isProjectLocalManifest(effectivePath, options.projectRoots ?? [])
  ) {
    return {
      extension: null,
      issues: [
        {
          field: "",
          message:
            `manifest "${effectivePath}" lies inside a project directory. Untangle never loads a ` +
            "project-local manifest implicitly: a cloned repository would otherwise bring an " +
            "executable tool with it. Load it only if you wrote it yourself.",
        },
      ],
    };
  }
  return loadExtensionManifestFile(fs, effectivePath, "explicit-path", call);
}
