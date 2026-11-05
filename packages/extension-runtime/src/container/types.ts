/**
 * Die Container-Grenze als Port (extensions.md §6.1–§6.3, X4).
 *
 * Untangle liefert keine Container-Runtime mit und startet keine. Es RUFT eine
 * auf, die der Nutzer betreibt — und zwar wie jedes fremde Programm ueber die
 * Prozessgrenze. Deshalb steht hier ein Port und keine Implementierung: der
 * Laufzeitkern kennt Lebenszyklus und Besitzprobe, nicht das Werkzeug, das sie
 * ausfuehrt.
 *
 * Die Besitzprobe ist der Grund, warum `inspect` mehr zurueckgibt als „laeuft".
 * `down` und `logs` duerfen nur Container anfassen, die BEIDE Labels tragen
 * (§8.2). Auf dieser Maschine laufen fremde Container; ein Werkzeug, das nach
 * Namen statt nach Labels greift, faende irgendwann den falschen.
 */
import type { ExtensionManifestV1 } from "@untangle-code/domain";

/** Ergebnis der Erreichbarkeitsprobe der Runtime selbst. */
export interface ContainerRuntimeAvailabilityV1 {
  available: boolean;
  /** Warum verfuegbar bzw. warum nicht — nie nur ein Flag (E4). */
  detail: string;
  version?: string;
}

/** Zustand des Containers EINER Extension. */
export interface ContainerStateV1 {
  /** True, wenn ein Container mit beiden Labels existiert. */
  exists: boolean;
  running: boolean;
  /** Digest, mit dem der Container tatsaechlich laeuft (X6). */
  imageDigest?: string;
  /**
   * False, wenn ein Container des erwarteten Namens existiert, aber NICHT
   * Untangle gehoert. Dann wird nichts angefasst und nichts gestartet.
   */
  ownedByUntangle: boolean;
  detail: string;
}

export interface ContainerUpInputV1 {
  manifest: ExtensionManifestV1;
  /** Pfad der aus dem Manifest gerenderten Compose-Datei. */
  composeFilePath: string;
}

export interface ContainerDownInputV1 {
  manifest: ExtensionManifestV1;
  composeFilePath: string;
  /** Benannte Volumes mit entfernen — destruktiv, verlangt eigene Zustimmung. */
  removeVolumes: boolean;
}

export interface ContainerActionResultV1 {
  ok: boolean;
  detail: string;
}

export interface ContainerLogsResultV1 {
  ok: boolean;
  text: string;
  detail: string;
}

/** Die Container-Grenze. Jede Methode ist abbrechbar (spec.md §22). */
export interface ContainerRuntimePort {
  available(options?: { signal?: AbortSignal }): Promise<ContainerRuntimeAvailabilityV1>;
  inspect(
    manifest: ExtensionManifestV1,
    options?: { signal?: AbortSignal },
  ): Promise<ContainerStateV1>;
  up(
    input: ContainerUpInputV1,
    options?: { signal?: AbortSignal },
  ): Promise<ContainerActionResultV1>;
  down(
    input: ContainerDownInputV1,
    options?: { signal?: AbortSignal },
  ): Promise<ContainerActionResultV1>;
  logs(
    input: { manifest: ExtensionManifestV1; composeFilePath: string; tail: number },
    options?: { signal?: AbortSignal },
  ): Promise<ContainerLogsResultV1>;
}
