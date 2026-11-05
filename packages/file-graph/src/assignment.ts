/**
 * Zuordnung einer Datei zu Paket und Container-Dienst.
 *
 * Regel in beiden Faellen: das LAENGSTE passende Verzeichnis gewinnt. Ein
 * Monorepo verschachtelt Pakete (`packages/a` und `packages/a/plugins/b`),
 * und die Wurzel `""` passt immer — ohne „laengster Treffer" landete jede
 * Datei im Wurzelpaket und die gesamte Paketebene waere wertlos.
 *
 * Bei gleicher Laenge entscheidet der Codepoint-Vergleich des Namens. Das
 * kommt nur bei einer fehlerhaften Konfiguration vor (zwei Pakete mit
 * demselben Verzeichnis), muss aber deterministisch enden.
 */
import { compareCodepoints } from "@untangle-code/domain";

import { isWithin, normalizePath } from "./paths.js";
import type { ContainerServiceV1, WorkspacePackageV1 } from "./types.js";

/** Paket, dem `path` im Repository `repoId` zugeordnet ist; `null`, wenn keines passt. */
export function assignPackage(
  packages: readonly WorkspacePackageV1[],
  repoId: string,
  path: string,
): WorkspacePackageV1 | null {
  const target = normalizePath(path);
  let best: WorkspacePackageV1 | null = null;
  for (const entry of packages) {
    if (entry.repoId !== repoId) continue;
    if (!isWithin(entry.packageDir, target)) continue;
    if (best === null) {
      best = entry;
      continue;
    }
    if (entry.packageDir.length > best.packageDir.length) {
      best = entry;
      continue;
    }
    if (
      entry.packageDir.length === best.packageDir.length &&
      compareCodepoints(entry.name, best.name) < 0
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * Container-Dienst, dem `path` zugeordnet ist.
 *
 * Zuordnungskriterium ist der Build-Kontext des Dienstes: was in seinem
 * Kontextverzeichnis liegt, landet in seinem Abbild. Dienste ohne
 * Build-Kontext (reine Abbild-Dienste wie eine Datenbank) bekommen KEINE
 * Dateien zugeordnet — sie sind Knoten der Dienstebene, aber kein Quelltext
 * gehoert zu ihnen, und ein Rateversuch waere hier schlechter als kein
 * Ergebnis.
 */
export function assignContainerService(
  services: readonly ContainerServiceV1[],
  repoId: string,
  path: string,
): ContainerServiceV1 | null {
  const target = normalizePath(path);
  let best: ContainerServiceV1 | null = null;
  for (const service of services) {
    if (service.repoId !== repoId) continue;
    const context = service.buildContext;
    if (context === undefined) continue;
    if (!isWithin(context, target)) continue;
    const bestContext = best?.buildContext ?? "";
    if (best === null) {
      best = service;
      continue;
    }
    if (context.length > bestContext.length) {
      best = service;
      continue;
    }
    if (context.length === bestContext.length && compareCodepoints(service.name, best.name) < 0) {
      best = service;
    }
  }
  return best;
}
