/**
 * Inhaltsadressierte Caches fuer Parse, Chunk und Komplexitaet (WP-100,
 * docs/INDEX-SHARING.md §5) — unter `.untangle/cache/analysis/`.
 *
 * WARUM ES SIE GIBT: Parsen, Chunken und Messen sind reine Funktionen des
 * Dateiinhalts. Ohne Cache rechnet jeder Lauf sie neu, obwohl sich zwischen
 * zwei Laeufen (und zwischen zwei Worktrees desselben Repositoriums)
 * typischerweise nur wenige Prozent der Dateien unterscheiden. Der
 * Einbettungs-Cache (spec.md §9.4) ist bereits inhaltsadressiert; diese drei
 * Caches schliessen die Luecke davor.
 *
 * DER SCHLUESSEL IST DIE GANZE SICHERHEIT. Ein Cache, der ein falsches
 * Ergebnis liefert, ist schlimmer als kein Cache: das falsche Ergebnis ist
 * nicht sichtbar. Der Schluesselbau steht deshalb in `@untangle-code/domain`
 * (analysis-cache-key.ts) und traegt jede Eingabe, von der der gespeicherte
 * Wert abhaengt.
 *
 * ABLAGE: ein JSON je Eintrag, zwei Hexzeichen tief geshardet
 * (`<hash[0:2]>/<hash>.json`), plus ein `index.json` je Cache mit Groesse und
 * letztem Zugriff — die Buchfuehrung fuer die Verdraengung nach Groesse (LRU).
 *
 * UNTERSCHIED ZUM EINBETTUNGS-CACHE: dessen Manifest wird bei JEDER Mutation
 * geschrieben. Das waere hier falsch: drei Caches mal zwei Zugriffe je Datei
 * ergaeben sechs Manifest-Schreibvorgaenge je Datei und fraessen genau die
 * Zeit auf, die der Cache spart. Das Manifest wird deshalb im Speicher
 * gefuehrt und alle {@link MANIFEST_FLUSH_INTERVAL} Mutationen sowie bei
 * {@link LocalContentCache.flush} geschrieben. PREIS: bricht der Lauf hart ab,
 * koennen geschriebene Eintraege im Manifest fehlen. Das kostet Treffer und
 * laesst Dateien ungezaehlt liegen — es liefert NIE ein falsches Ergebnis,
 * weil ein Wert ausschliesslich ueber das Manifest gefunden wird.
 *
 * Lesen degradiert kontrolliert (architecture.md §12: lokale Caches sind
 * loeschbar und rekonstruierbar): fehlende Datei, kaputtes JSON, kaputtes
 * Manifest — alles ist ein Fehlschlag des Nachschlagens, kein geworfener
 * Fehler.
 */
import * as nodePath from "node:path";

import type {
  AnalysisCacheKind,
  Clock,
  FileSystemPort,
  PortCallOptions,
  Random,
} from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";

import { assertNotAborted } from "./abort.js";
import { isNotFoundError } from "./fs-errors.js";

// Der Schluesselbau liegt in `@untangle-code/domain`, weil ihn BEIDE Seiten
// brauchen: dieses Paket legt ab, `@untangle-code/core` schlaegt nach. Zwei
// Kopien desselben Schluessels waeren die sicherste Art, den Cache eines Tages
// an der falschen Stelle treffen zu lassen. Hier nur weitergereicht, damit ein
// Aufrufer beides aus einem Paket bekommt.
export {
  ANALYSIS_CACHE_KINDS,
  buildChunkCacheKey,
  buildMetricsCacheKey,
  buildParseCacheKey,
  type AnalysisCacheKind,
  type AnalysisIdentityKeyPartsV1,
} from "@untangle-code/domain";

/** 256 MiB je Cache — eine Untangle-Vorgabe, keine Spec-Zahl. */
export const DEFAULT_ANALYSIS_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Nach so vielen Mutationen wird das Manifest geschrieben. */
export const MANIFEST_FLUSH_INTERVAL = 64;

const MANIFEST_FILE_NAME = "index.json";

export interface ContentCacheStatsV1 {
  entryCount: number;
  totalBytes: number;
  /** Treffer seit dem Oeffnen dieses Cache-Objekts. */
  hits: number;
  /** Fehlschlaege seit dem Oeffnen dieses Cache-Objekts. */
  misses: number;
  /** Trefferquote in [0,1]; 0, wenn nichts nachgeschlagen wurde. */
  hitRate: number;
  /** Wie viele Eintraege die Groessengrenze verdraengt hat. */
  evictions: number;
}

interface ManifestEntryV1 {
  fileName: string;
  sizeBytes: number;
  lastAccessEpochMs: number;
}

interface ManifestV1 {
  version: 1;
  entries: Record<string, ManifestEntryV1>;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function signalOptions(options: PortCallOptions | undefined): PortCallOptions | undefined {
  return options?.signal ? { signal: options.signal } : undefined;
}

function totalBytesOf(manifest: ManifestV1): number {
  let total = 0;
  for (const entry of Object.values(manifest.entries)) {
    total += entry.sizeBytes;
  }
  return total;
}

function pickEvictionCandidate(manifest: ManifestV1, protectedKey: string): string | null {
  const keys = Object.keys(manifest.entries);
  let best: string | null = null;
  let bestAccess = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    if (key === protectedKey && keys.length === 1) {
      // Der eben geschriebene Eintrag ist der letzte — ihn zu verdraengen
      // hiesse, `set()` stillschweigend wirkungslos zu machen.
      continue;
    }
    const entry = manifest.entries[key];
    if (entry !== undefined && entry.lastAccessEpochMs < bestAccess) {
      bestAccess = entry.lastAccessEpochMs;
      best = key;
    }
  }
  return best;
}

/**
 * Ein inhaltsadressierter JSON-Cache mit Groessengrenze, Verdraengung und
 * Trefferquote. Der Schluessel ist eine undurchsichtige Zeichenkette; wer ihn
 * baut, verantwortet seine Vollstaendigkeit (siehe Kopf dieser Datei).
 */
export class LocalContentCache {
  private readonly maxBytes: number;
  private manifest: ManifestV1 | null = null;
  private dirty = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  public constructor(
    private readonly fs: FileSystemPort,
    private readonly dir: string,
    private readonly clock: Clock,
    private readonly random: Random,
    options?: { maxBytes?: number },
  ) {
    this.maxBytes = options?.maxBytes ?? DEFAULT_ANALYSIS_CACHE_MAX_BYTES;
  }

  private manifestPath(): string {
    return nodePath.join(this.dir, MANIFEST_FILE_NAME);
  }

  private entryFileName(logicalKey: string): string {
    const hash = sha256Hex(logicalKey);
    return nodePath.join(hash.slice(0, 2), `${hash}.json`);
  }

  private entryPath(fileName: string): string {
    return nodePath.join(this.dir, fileName);
  }

  private async loadManifest(options: PortCallOptions | undefined): Promise<ManifestV1> {
    if (this.manifest !== null) {
      return this.manifest;
    }
    let text: string;
    try {
      text = await this.fs.readTextFile(this.manifestPath(), options);
    } catch (error) {
      if (isNotFoundError(error)) {
        this.manifest = { version: 1, entries: {} };
        return this.manifest;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<ManifestV1>;
      this.manifest =
        parsed.entries === undefined
          ? { version: 1, entries: {} }
          : { version: 1, entries: parsed.entries };
    } catch {
      // Kaputtes Manifest — leerer Cache statt geworfener Fehler.
      this.manifest = { version: 1, entries: {} };
    }
    return this.manifest;
  }

  private async persistManifest(options: PortCallOptions | undefined): Promise<void> {
    const manifest = this.manifest;
    if (manifest === null) {
      return;
    }
    await this.fs.mkdir(this.dir, { recursive: true, ...signalOptions(options) });
    const tempPath = `${this.manifestPath()}.${this.random.uuid()}.tmp`;
    await this.fs.writeFile(tempPath, encode(JSON.stringify(manifest)), options);
    await this.fs.rename(tempPath, this.manifestPath(), options);
    this.dirty = 0;
  }

  private async touched(options: PortCallOptions | undefined): Promise<void> {
    this.dirty++;
    if (this.dirty >= MANIFEST_FLUSH_INTERVAL) {
      await this.persistManifest(options);
    }
  }

  /** Schreibt das Manifest, falls Mutationen ausstehen. Am Ende eines Laufs aufrufen. */
  public async flush(options?: PortCallOptions): Promise<void> {
    if (this.dirty > 0) {
      await this.persistManifest(options);
    }
  }

  /** Der Wert, oder `null` fuer "nicht im Cache". Wirft nicht fuer kaputte Eintraege. */
  public async get(logicalKey: string, options?: PortCallOptions): Promise<unknown | null> {
    assertNotAborted(options, "analysis_cache_get");
    const manifest = await this.loadManifest(options);
    const entry = manifest.entries[logicalKey];
    if (entry === undefined) {
      this.misses++;
      return null;
    }
    let text: string;
    try {
      text = await this.fs.readTextFile(this.entryPath(entry.fileName), options);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      delete manifest.entries[logicalKey];
      await this.touched(options);
      this.misses++;
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      delete manifest.entries[logicalKey];
      await this.touched(options);
      this.misses++;
      return null;
    }
    entry.lastAccessEpochMs = this.clock.nowEpochMs();
    this.dirty++;
    this.hits++;
    return value;
  }

  public async set(logicalKey: string, value: unknown, options?: PortCallOptions): Promise<void> {
    assertNotAborted(options, "analysis_cache_set");
    const fileName = this.entryFileName(logicalKey);
    const entryPath = this.entryPath(fileName);
    const bytes = encode(JSON.stringify(value));

    await this.fs.mkdir(nodePath.dirname(entryPath), {
      recursive: true,
      ...signalOptions(options),
    });
    const tempPath = `${entryPath}.${this.random.uuid()}.tmp`;
    await this.fs.writeFile(tempPath, bytes, options);
    await this.fs.rename(tempPath, entryPath, options);

    const manifest = await this.loadManifest(options);
    manifest.entries[logicalKey] = {
      fileName,
      sizeBytes: bytes.length,
      lastAccessEpochMs: this.clock.nowEpochMs(),
    };
    await this.evictUntilWithinLimit(manifest, logicalKey, options);
    await this.touched(options);
  }

  private async evictUntilWithinLimit(
    manifest: ManifestV1,
    justWrittenKey: string,
    options: PortCallOptions | undefined,
  ): Promise<void> {
    let total = totalBytesOf(manifest);
    while (total > this.maxBytes) {
      const victim = pickEvictionCandidate(manifest, justWrittenKey);
      if (victim === null) {
        break;
      }
      const entry = manifest.entries[victim];
      delete manifest.entries[victim];
      if (entry !== undefined) {
        total -= entry.sizeBytes;
        this.evictions++;
        try {
          await this.fs.remove(this.entryPath(entry.fileName), options);
        } catch {
          // Der Manifest-Eintrag ist so oder so weg; ein spaeterer `get`
          // trifft nicht mehr.
        }
      }
    }
  }

  public async stats(options?: PortCallOptions): Promise<ContentCacheStatsV1> {
    assertNotAborted(options, "analysis_cache_stats");
    const manifest = await this.loadManifest(options);
    const lookups = this.hits + this.misses;
    return {
      entryCount: Object.keys(manifest.entries).length,
      totalBytes: totalBytesOf(manifest),
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
      evictions: this.evictions,
    };
  }

  /** Loescht ausschliesslich das eigene Verzeichnis dieses Caches. */
  public async clear(options?: PortCallOptions): Promise<void> {
    assertNotAborted(options, "analysis_cache_clear");
    await this.fs.remove(this.dir, { recursive: true, ...signalOptions(options) });
    this.manifest = { version: 1, entries: {} };
    this.dirty = 0;
  }
}

/** Trefferquoten aller drei Caches, einzeln und zusammen. */
export interface AnalysisCacheStatsV1 {
  parse: ContentCacheStatsV1;
  chunk: ContentCacheStatsV1;
  metrics: ContentCacheStatsV1;
  totalHits: number;
  totalMisses: number;
  /** Trefferquote ueber alle drei Caches in [0,1]. */
  hitRate: number;
}

/**
 * Die drei Caches als ein Gegenstand — genau die Form, die
 * `@untangle-code/core` als `AnalysisCacheLike` erwartet.
 */
export class LocalAnalysisCache {
  public constructor(
    public readonly parse: LocalContentCache,
    public readonly chunk: LocalContentCache,
    public readonly metrics: LocalContentCache,
  ) {}

  private of(kind: AnalysisCacheKind): LocalContentCache {
    if (kind === "parse") return this.parse;
    if (kind === "chunk") return this.chunk;
    return this.metrics;
  }

  public async get(
    kind: AnalysisCacheKind,
    key: string,
    options?: PortCallOptions,
  ): Promise<unknown | null> {
    return this.of(kind).get(key, options);
  }

  public async set(
    kind: AnalysisCacheKind,
    key: string,
    value: unknown,
    options?: PortCallOptions,
  ): Promise<void> {
    await this.of(kind).set(key, value, options);
  }

  /** Schreibt die Manifeste aller drei Caches. */
  public async flush(options?: PortCallOptions): Promise<void> {
    await this.parse.flush(options);
    await this.chunk.flush(options);
    await this.metrics.flush(options);
  }

  public async stats(options?: PortCallOptions): Promise<AnalysisCacheStatsV1> {
    const parse = await this.parse.stats(options);
    const chunk = await this.chunk.stats(options);
    const metrics = await this.metrics.stats(options);
    const totalHits = parse.hits + chunk.hits + metrics.hits;
    const totalMisses = parse.misses + chunk.misses + metrics.misses;
    const lookups = totalHits + totalMisses;
    return {
      parse,
      chunk,
      metrics,
      totalHits,
      totalMisses,
      hitRate: lookups === 0 ? 0 : totalHits / lookups,
    };
  }

  public async clear(options?: PortCallOptions): Promise<void> {
    await this.parse.clear(options);
    await this.chunk.clear(options);
    await this.metrics.clear(options);
  }
}
