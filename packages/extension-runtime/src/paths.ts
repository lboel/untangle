/**
 * Wo Extension-Manifeste liegen — und wo sie ausdruecklich NICHT gesucht
 * werden (extensions.md §17, §9.2).
 *
 * ## Die Sicherheitsgrenze
 *
 * Ein Manifest beschreibt einen PROZESSSTART: Programm, Argumente,
 * Container-Image, Netzzugriff. Wuerde Untangle ein Manifest aus dem
 * PROJEKTVERZEICHNIS automatisch laden, dann braechte jedes geklonte fremde
 * Repository ungefragt ein Werkzeug mit, das anschliessend Befehle ausfuehrt —
 * `git clone` waere Codeausfuehrung. Deshalb:
 *
 * - automatisch gesucht wird ausschliesslich im NUTZER-Datenverzeichnis;
 * - ein Manifest im Projektverzeichnis (einschliesslich `.untangle/`) wird nie
 *   automatisch geladen, sondern gemeldet und ignoriert;
 * - ein Projektpfad ist nur ueber einen ausdruecklichen, vom Nutzer selbst
 *   getippten `--from`-Aufruf ladbar.
 *
 * Das ist dieselbe Ueberlegung wie beim Speicherort der Lizenzbestaetigung
 * (extensions.md §9.2): `.untangle/` kann committet werden und wuerde eine
 * persoenliche Entscheidung an das ganze Team vererben.
 */
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** Dateiname des Manifests innerhalb eines Extension-Verzeichnisses. */
export const MANIFEST_FILE_NAME = "manifest.toml";

/** Umgebungsvariable, die alle Vorgabewurzeln ersetzt (Tests, Sonderfaelle). */
export const EXTENSIONS_HOME_ENV = "UNTANGLE_EXTENSIONS_HOME";

/** Alles, was die Wurzelbestimmung ueber die Umgebung wissen muss. */
export interface ExtensionPathEnvironmentV1 {
  /** Heimatverzeichnis des Nutzers (`os.homedir()`). */
  homeDir: string;
  /** `process.platform`. */
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Ordnet die Suchwurzeln fuer Extension-Verzeichnisse.
 *
 * Reihenfolge:
 * 1. `UNTANGLE_EXTENSIONS_HOME`, wenn gesetzt — dann ausschliesslich diese;
 * 2. `~/.untangle/extensions` — der plattformneutrale Vorgabeort;
 * 3. das OS-Datenverzeichnis nach extensions.md §17
 *    (`%APPDATA%\untangle\extensions`,
 *    `~/Library/Application Support/untangle/extensions`,
 *    `$XDG_DATA_HOME/untangle/extensions` bzw. `~/.local/share/…`).
 *
 * Beide Vorgabeorte liegen im Nutzerprofil; keiner liegt im Projekt. Doppelte
 * Wurzeln (etwa wenn zwei Regeln denselben Pfad ergeben) erscheinen einmal.
 */
export function resolveExtensionRoots(environment: ExtensionPathEnvironmentV1): string[] {
  const override = environment.env[EXTENSIONS_HOME_ENV];
  if (override !== undefined && override.trim() !== "") {
    return [normalize(override)];
  }
  const roots = [join(environment.homeDir, ".untangle", "extensions")];
  roots.push(join(userDataDirectory(environment), "extensions"));
  const unique: string[] = [];
  for (const root of roots) {
    const normalized = normalize(root);
    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique;
}

/** Das OS-spezifische Nutzer-Datenverzeichnis von Untangle (extensions.md §17). */
export function userDataDirectory(environment: ExtensionPathEnvironmentV1): string {
  if (environment.platform === "win32") {
    const appData = environment.env["APPDATA"];
    if (appData !== undefined && appData.trim() !== "") {
      return join(appData, "untangle");
    }
    return join(environment.homeDir, "AppData", "Roaming", "untangle");
  }
  if (environment.platform === "darwin") {
    return join(environment.homeDir, "Library", "Application Support", "untangle");
  }
  const xdg = environment.env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") {
    return join(xdg, "untangle");
  }
  return join(environment.homeDir, ".local", "share", "untangle");
}

/** Verzeichnis einer Extension unterhalb einer Wurzel. */
export function extensionDirectory(root: string, extensionId: string): string {
  return join(root, extensionId);
}

/** Manifestpfad einer Extension unterhalb einer Wurzel. */
export function extensionManifestPath(root: string, extensionId: string): string {
  return join(root, extensionId, MANIFEST_FILE_NAME);
}

/**
 * True, wenn `candidate` innerhalb von `directory` liegt (oder gleich ist).
 * Vergleich ueber `path.relative`, damit `..`-Segmente nicht ueber die Grenze
 * tragen. Symlinks loest diese Funktion NICHT auf — der Aufrufer arbeitet
 * dafuer mit dem kanonischen Pfad aus `FileSystemPort.realPath`.
 */
export function isInsideDirectory(candidate: string, directory: string): boolean {
  const from = resolve(directory);
  const to = resolve(candidate);
  if (from === to) {
    return true;
  }
  const rel = relative(from, to);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * True, wenn `manifestPath` in einem der Projektverzeichnisse liegt.
 *
 * Ein solches Manifest DARF NICHT automatisch geladen werden — siehe die
 * Begruendung am Kopf dieser Datei.
 */
export function isProjectLocalManifest(
  manifestPath: string,
  projectRoots: readonly string[],
): boolean {
  return projectRoots.some((root) => isInsideDirectory(manifestPath, root));
}
