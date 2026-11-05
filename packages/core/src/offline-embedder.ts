/**
 * Ein `EmbeddingProvider` OHNE Netz — Merkmals-Hashing ueber einen Tokenbeutel.
 *
 * WOFUER ER DA IST, UND WOFUER NICHT: Er ist KEIN Ersatz fuer ein echtes
 * Sprachmodell. Seine Vektoren tragen keine Semantik: „Nutzer anlegen" und
 * „create user" liegen fuer ihn weit auseinander. Er existiert, damit der
 * Indexlauf und alles, was daran haengt, VOLLSTAENDIG und NACHPRUEFBAR laufen
 * kann, wenn kein Einbettungsdienst erreichbar ist — reproduzierbar, ohne
 * Netz, ohne Wartezeit. Wer ihn benutzt, hat lexikalische Suche (BM25) in
 * voller Qualitaet und dichte Suche in stark eingeschraenkter; das steht so in
 * der Ausgabe von `untangle index`, damit niemand es fuer das echte Ding haelt.
 *
 * WARUM NEU GESCHRIEBEN UND NICHT AUS `@untangle-code/testkit` IMPORTIERT:
 * Das testkit ist Testinfrastruktur und darf keine Produktionsabhaengigkeit
 * werden. Dieselbe Entscheidung hat `@untangle-code/storage-qdrant` fuer die
 * BM25-Vektorisierung getroffen (`bm25-text.ts`), und wie dort ist der
 * Algorithmus ABSICHTLICH bis aufs Bit derselbe: eine Testdatei vergleicht
 * beide Implementierungen Vektor fuer Vektor, damit sie nicht auseinanderlaufen.
 *
 * Determinismus: reine Arithmetik ueber dem Eingabetext. Kein `Math.random()`,
 * keine Uhr in den Ergebnisdaten (die `Clock` liefert nur den Zeitstempel der
 * Bereitschaftsmeldung, der kein Ergebnis ist).
 */
import {
  buildEmbeddingProfileId,
  type Clock,
  type EmbeddingBatchResultV1,
  type EmbeddingProfile,
  type EmbeddingProvider,
  type EmbeddingReadinessV1,
  type PortCallOptions,
} from "@untangle-code/domain";

/**
 * Salz, das die „welche Dimension"-Streuung von der „welches Vorzeichen"-
 * Streuung trennt. Ohne es kaemen beide aus demselben Hashwert und waeren
 * korreliert — die Vektorrichtungen bekaemen eine systematische Schlagseite.
 *
 * Der Wert ist Teil des ALGORITHMUS und darf sich nicht aendern: er geht in
 * jeden Vektor ein, und ein anderer Wert machte jeden gespeicherten Vektor
 * unvergleichbar. Er lautet deshalb woertlich wie in der Referenzfassung des
 * testkits.
 */
const SIGN_SALT = "testkit-deterministic-embedder-sign\u001F";

/**
 * ACHTUNG, UNSICHTBARES ZEICHEN: Der Wert endet auf U+001F (ASCII Unit
 * Separator) — dasselbe Trennzeichen, das `@untangle-code/domain` fuer
 * ID-Bestandteile benutzt. Es steht hier als Escape-Folge und NICHT woertlich,
 * weil es in jeder Anzeige (Editor, `grep`, Codeansicht) spurlos verschwindet.
 * Genau daran ist die erste Fassung dieser Neuschreibung gescheitert: die
 * Vektoren sahen richtig aus, waren aber andere — der Vergleichstest unten hat
 * es gefunden, ein Blick auf den Quelltext haette es nie getan.
 */

/** Kleinschreiben und an Laeufen von Nicht-Alphanumerik trennen; Leeres faellt weg. */
export function tokenizeForEmbedding(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches === null ? [] : [...matches];
}

/**
 * FNV-1a, 32 Bit, gefaltet unter 2^31 — identisch zu
 * `hashBm25Token` in `@untangle-code/storage-qdrant` und zu `hashToken` im
 * testkit. Reine Ganzzahlarithmetik, also auf jeder Plattform gleich.
 */
export function hashEmbeddingToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7fffffff;
}

/** L2-Norm; ein Nullvektor bleibt unveraendert statt `NaN` zu werden. */
export function l2Normalize(vector: readonly number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return [...vector];
  return vector.map((value) => value / norm);
}

/** Verwandelt `text` in einen reproduzierbaren, L2-normalisierten Vektor. */
export function embedTextOffline(text: string, dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `embedTextOffline: dimensions must be a positive integer; received ${String(dimensions)}`,
    );
  }
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenizeForEmbedding(text)) {
    const dimension = hashEmbeddingToken(token) % dimensions;
    const sign = hashEmbeddingToken(SIGN_SALT + token) % 2 === 0 ? 1 : -1;
    vector[dimension] = (vector[dimension] ?? 0) + sign;
  }
  return l2Normalize(vector);
}

/**
 * Das Vorgabeprofil des netzlosen Einbetters.
 *
 * `provider` und `model` sind bewusst UNVERWECHSELBAR: der
 * `embedding_profile_id` geht in den Sammlungsnamen ein (spec.md §10.1), also
 * landen netzlose Vektoren NIE in derselben Sammlung wie echte. Ein Index, der
 * heimlich beide Sorten mischte, waere unbrauchbar und saehe gesund aus.
 */
export const OFFLINE_EMBEDDING_PROFILE: EmbeddingProfile = {
  provider: "untangle-offline",
  model: "hashed-token-bag-v1",
  dimensions: 256,
  queryPrefix: "search_query: ",
  documentPrefix: "search_document: ",
  includePath: true,
  normalization: "l2",
  preparedTextVersion: "untangle-prepared-text-v1",
};

export class OfflineEmbeddingProvider implements EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  readonly profileId: string;

  constructor(
    private readonly clock: Clock,
    profile: EmbeddingProfile = OFFLINE_EMBEDDING_PROFILE,
  ) {
    if (!Number.isInteger(profile.dimensions) || profile.dimensions <= 0) {
      throw new Error(
        `OfflineEmbeddingProvider: dimensions must be a positive integer; received ${String(profile.dimensions)}`,
      );
    }
    this.profile = profile;
    this.profileId = buildEmbeddingProfileId(profile);
  }

  async ensureReady(options?: PortCallOptions): Promise<EmbeddingReadinessV1> {
    options?.signal?.throwIfAborted();
    return Promise.resolve({
      endpoint: "in-process://untangle-offline-embedder",
      model: this.profile.model,
      dimensions: this.profile.dimensions,
      probedAt: this.clock.nowIso(),
    });
  }

  async embedDocuments(
    preparedTexts: string[],
    options?: PortCallOptions,
  ): Promise<EmbeddingBatchResultV1> {
    options?.signal?.throwIfAborted();
    return Promise.resolve({
      vectors: preparedTexts.map((text) => embedTextOffline(text, this.profile.dimensions)),
      // Ein Tokenbeutel hat kein Kontextfenster, an dem etwas abgeschnitten
      // werden koennte. `false` ist hier die Wahrheit, keine Beschoenigung.
      truncated: preparedTexts.map(() => false),
    });
  }

  async embedQuery(preparedText: string, options?: PortCallOptions): Promise<number[]> {
    options?.signal?.throwIfAborted();
    return Promise.resolve(embedTextOffline(preparedText, this.profile.dimensions));
  }
}
