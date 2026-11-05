/**
 * Fragenkatalog der Abrufmessung (Nachbau von docs/BENCHMARK.md).
 *
 * EHRLICHKEIT ZUR HERKUNFT (E4): docs/BENCHMARK.md haelt die Ergebnisse fest,
 * NICHT den Fragenkatalog — die Tabelle dort kuerzt jede Frage nach 58 Zeichen
 * ab, und das erzeugende Skript liegt nicht im Repository. Dieser Katalog ist
 * deshalb ein REKONSTRUKTION: Kategorien, IDs und die sichtbaren Anfaenge der
 * Fragen stammen woertlich aus docs/BENCHMARK.md, die abgeschnittenen Enden und
 * die Grundwahrheit (`expect`) sind hier neu bestimmt und am Repository
 * nachgeprueft. Die absoluten Zahlen dieser Messung sind daher NICHT
 * deckungsgleich mit denen in docs/BENCHMARK.md. Aussagekraeftig ist der
 * Vergleich VORHER/NACHHER mit demselben Katalog, nicht der Vergleich mit der
 * fremden Tabelle.
 *
 * `expect` ist eine Liste von Dateipfaden; ein Treffer zaehlt, wenn sein
 * `file_path` einem davon gleicht. `expect: []` heisst: es gibt keine Antwort
 * (Negativprobe).
 */

/** @typedef {'answerable' | 'clear_absent' | 'compositional_diagnostic'} GroundTruthKind */
/**
 * @typedef {{
 *   id: string,
 *   category: string,
 *   text: string,
 *   expect: string[],
 *   groundTruthKind?: GroundTruthKind,
 *   evaluationSet?: 'main' | 'german-corroboration' | 'german-policy-holdout',
 *   absentAnchors?: string[],
 *   rationale?: string,
 *   selfMentionPaths?: string[]
 * }} BenchQuestion
 */

/** @type {BenchQuestion[]} */
export const QUESTIONS = [
  // --- symbolname ---------------------------------------------------------
  {
    id: "s1",
    category: "symbolname",
    text: "assertHonestUnderDamage",
    expect: ["packages/testkit/src/honesty/assert-honest.ts"],
  },
  {
    id: "s2",
    category: "symbolname",
    text: "validateCoverage",
    expect: ["packages/domain/src/invariants.ts"],
  },
  {
    id: "s3",
    category: "symbolname",
    text: "buildSymbolEdgeId",
    expect: ["packages/domain/src/identity.ts"],
  },
  {
    id: "s4",
    category: "symbolname",
    text: "normalizeSearchQuery",
    expect: ["packages/domain/src/types/search.ts"],
  },
  {
    id: "s5",
    category: "symbolname",
    text: "compareCodepoints",
    expect: ["packages/domain/src/ordering.ts"],
  },

  // --- deutsch ------------------------------------------------------------
  {
    id: "d1",
    category: "deutsch",
    text: "Wo wird die Puffergrenze von tree-sitter behandelt, damit grosse Dateien nicht stillschweigend ausfallen?",
    expect: ["packages/parser-registry/src/languages/shared/parse-limits.ts"],
  },
  {
    id: "d2",
    category: "deutsch",
    text: "Wie wird verhindert, dass zwei gleichzeitige Schreiber sich gegenseitig die Daten loeschen?",
    expect: [
      "packages/storage-local/src/lock-provider.ts",
      "packages/testkit/src/contracts/lock-provider.contract.ts",
      "packages/testkit/src/in-memory/lock-provider.ts",
    ],
  },
  {
    id: "d3",
    category: "deutsch",
    text: "Wo wird die kognitive Komplexitaet berechnet?",
    expect: ["packages/complexity/src/cognitive.ts"],
  },
  {
    id: "d4",
    category: "deutsch",
    text: "Wie werden Markdown-Dokumente in Abschnitte zerlegt?",
    expect: ["packages/parser-registry/src/languages/prose/index.ts"],
  },
  {
    id: "d5",
    category: "deutsch",
    text: "Wo steht, dass ein externer Befund niemals als eigene Metrik ausgegeben wird?",
    expect: ["packages/domain/src/types/extensions.ts", "extensions.md"],
  },
  {
    id: "d6",
    category: "deutsch",
    text: "Wie erkennt das Werkzeug die Dienste aus einer docker-compose-Datei?",
    expect: ["packages/context-artifacts/src/adapters/docker.ts"],
  },
  {
    id: "d7",
    category: "deutsch",
    text: "Wo wird entschieden, welcher Vektorspeicher benutzt werden soll?",
    expect: ["apps/cli/src/cli/vector-store-policy.ts"],
  },

  // --- englisch -----------------------------------------------------------
  {
    id: "e1",
    category: "englisch",
    text: "how are chunk boundaries kept lossless so nothing is silently dropped",
    expect: ["packages/chunker/src/coverage.ts"],
  },
  {
    id: "e2",
    category: "englisch",
    text: "reciprocal rank fusion of dense and lexical results",
    expect: ["packages/search/src/fusion.ts"],
  },
  {
    id: "e3",
    category: "englisch",
    text: "batching and caching of embedding requests",
    expect: [
      "packages/embeddings-ollama/src/cache.ts",
      "packages/embeddings-ollama/src/provider.ts",
    ],
  },
  {
    id: "e4",
    category: "englisch",
    text: "detect entry points like main or framework routes",
    expect: ["packages/symbol-graph/src/entry-points.ts"],
  },

  // --- konzept ------------------------------------------------------------
  {
    id: "k1",
    category: "konzept",
    text: "Was passiert, wenn eine Datei nicht geparst werden kann?",
    expect: [
      "packages/chunker/src/chunker.ts",
      "packages/chunker/src/strategies/line-fallback-strategy.ts",
    ],
  },
  {
    id: "k2",
    category: "konzept",
    text: "Wie wird ein Index ueber mehrere Branches oder Worktrees getrennt gehalten?",
    expect: ["docs/INDEX-SHARING.md"],
  },

  // --- prosa --------------------------------------------------------------
  {
    id: "p1",
    category: "prosa",
    text: "Was ist die Kernthese des Projekts zur Komplexitaet?",
    expect: ["vision.md"],
  },
  {
    id: "p2",
    category: "prosa",
    text: "Warum ist schlechte Auffindbarkeit selbst ein Qualitaetsproblem?",
    expect: ["vision.md"],
  },
  {
    id: "p3",
    category: "prosa",
    text: "Welche Entscheidungen sind unveraenderlich und duerfen nicht geaendert werden?",
    expect: ["docs/BUILD_PLAN.md", "CONTRIBUTING.md"],
  },

  // --- ohne Antwort -------------------------------------------------------
  {
    id: "n1",
    category: "ohne-antwort",
    text: "Wo wird die Blockchain-Signatur der Transaktionen geprueft?",
    expect: [],
    groundTruthKind: "clear_absent",
    absentAnchors: ["blockchain"],
    rationale: "Das Repository implementiert keine Blockchain-Transaktionspruefung.",
    selfMentionPaths: ["docs/BENCHMARK.md", "packages/search/benchmark/questions.mjs"],
  },
  {
    // docs/BENCHMARK.md haelt selbst fest, dass diese Frage FALSCH als
    // „ohne Antwort" gefuehrt wurde: kubernetes.ts existiert. Sie bleibt im
    // Katalog, aber mit der richtigen Grundwahrheit.
    id: "n2",
    category: "englisch",
    text: "kubernetes horizontal pod autoscaler configuration",
    expect: ["packages/context-artifacts/src/adapters/kubernetes.ts"],
  },

  // --- gehaltene klare Negativproben -------------------------------------
  // Die Anker wurden per rg ausserhalb dieses Katalogs und docs/BENCHMARK.md
  // bestaetigt. `selfMentionPaths` macht die unvermeidliche Selbsterwaehnung
  // im Katalog sichtbar; kuenftige Dogfood-Indizes schliessen benchmark/ aus.
  {
    id: "n-cobol-payroll",
    category: "ohne-antwort",
    text: "Where does the COBOL payroll batch reconcile mainframe salary deductions?",
    expect: [],
    groundTruthKind: "clear_absent",
    absentAnchors: ["cobol", "payroll", "mainframe"],
    rationale: "Kein COBOL- oder Payroll-Subsystem ist Teil von Untangle.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },
  {
    id: "n-quantum-teleportation",
    category: "ohne-antwort",
    text: "Where does the quantum teleportation circuit apply Bell-state correction to a qubit?",
    expect: [],
    groundTruthKind: "clear_absent",
    absentAnchors: ["quantum", "teleportation", "qubit"],
    rationale: "Das Repository enthaelt keine Quantenalgorithmen.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },
  {
    id: "n-dnssec-rollover",
    category: "ohne-antwort",
    text: "Where does automated DNSSEC KSK rollover publish the DS record?",
    expect: [],
    groundTruthKind: "clear_absent",
    absentAnchors: ["dnssec", "ksk"],
    rationale: "Untangle implementiert weder DNSSEC noch Schluessel-Rollover.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },
  {
    id: "n-hipaa-adjudication",
    category: "ohne-antwort",
    text: "Where does HIPAA claim adjudication enforce payer remittance rules?",
    expect: [],
    groundTruthKind: "clear_absent",
    absentAnchors: ["hipaa", "adjudication", "remittance"],
    rationale: "Das Repository enthaelt keine Healthcare-Claim-Verarbeitung.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },
  {
    id: "n-blockchain-config",
    category: "ohne-antwort",
    text: "Where does blockchain configuration validation reject an invalid consensus network?",
    expect: [],
    groundTruthKind: "clear_absent",
    absentAnchors: ["blockchain", "consensus"],
    rationale: "Generische Konfigurationsvalidierung existiert, Blockchain-Konfiguration nicht.",
    selfMentionPaths: ["docs/BENCHMARK.md", "packages/search/benchmark/questions.mjs"],
  },
  {
    id: "n-retinaface",
    category: "ohne-antwort",
    text: "Where is the RetinaFace facial-recognition model initialized?",
    expect: [],
    groundTruthKind: "clear_absent",
    absentAnchors: ["retinaface", "facial-recognition"],
    rationale: "Untangle enthaelt kein biometrisches Erkennungsmodell.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },

  // --- kompositionelle Diagnosen (bewusst KEIN hartes Pass/Fail) ----------
  // Einzelne Teilkonzepte existieren, nur ihre behauptete Beziehung nicht.
  // Vektorsuche allein kann dieses Entailment nicht verlaesslich entscheiden.
  {
    id: "c-blockchain-fingerprint",
    category: "kompositionell",
    text: "Where does blockchain transaction-signature verification reuse the AST fingerprint?",
    expect: [],
    groundTruthKind: "compositional_diagnostic",
    rationale: "AST-Fingerprints existieren, Blockchain-Verifikation nicht.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },
  {
    id: "c-blockchain-config",
    category: "kompositionell",
    text: "Wo wird die Blockchain-Signaturpruefung in untangle.toml konfiguriert?",
    expect: [],
    groundTruthKind: "compositional_diagnostic",
    rationale: "Untangle-Konfiguration existiert, Blockchain-Signaturpruefung nicht.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },
  {
    id: "c-parser-retry",
    category: "kompositionell",
    text: "How does the parser retry failed embedding requests?",
    expect: [],
    groundTruthKind: "compositional_diagnostic",
    rationale: "Parser und Embedding-Retries existieren getrennt, nicht in dieser Beziehung.",
    selfMentionPaths: ["packages/search/benchmark/questions.mjs"],
  },

  // Live-Gegenprobe fuer die WP-232-Korroborationsregel. Sie wird getrennt
  // gemeldet und veraendert den 22-Fragen-Hauptkatalog nicht.
  {
    id: "g-corroborated",
    category: "deutsch-korroboration",
    text: "Wo ist die Gemessene Ausgangslage dokumentiert?",
    expect: ["docs/INDEX-SHARING.md"],
    groundTruthKind: "answerable",
    evaluationSet: "german-corroboration",
  },

  // Externe deutsche Prosa-Wahrheiten: Sie waren weder Teil der 22 Fragen
  // noch Grundlage der ersten Policy-Kalibrierung. Sie laufen trotzdem unter
  // exakt derselben produktiven Policy und schuetzen vor Einzelfall-Overfit.
  {
    id: "g-policy-arrays",
    category: "deutsch-policy-holdout",
    text: "Warum werden Arrays aus mehreren Konfigurationsebenen nicht zusammengefuehrt?",
    expect: ["packages/config/README.md", "packages/config/src/merge.ts"],
    groundTruthKind: "answerable",
    evaluationSet: "german-policy-holdout",
  },
  {
    id: "g-policy-extension-manifest",
    category: "deutsch-policy-holdout",
    text: "Warum lädt Untangle Erweiterungsmanifeste nicht automatisch aus dem Projektverzeichnis?",
    expect: ["packages/extension-runtime/README.md"],
    groundTruthKind: "answerable",
    evaluationSet: "german-policy-holdout",
  },
  {
    id: "g-policy-parser-cursor",
    category: "deutsch-policy-holdout",
    text: "Warum traversiert der Parser den Syntaxbaum mit einem Cursor statt über node.children?",
    expect: ["packages/parser-registry/README.md"],
    groundTruthKind: "answerable",
    evaluationSet: "german-policy-holdout",
  },
  {
    id: "g-policy-rust",
    category: "deutsch-policy-holdout",
    text: "Unter welchen Bedingungen wäre Rust für Untangle doch sinnvoll?",
    expect: ["docs/PERFORMANCE.md"],
    groundTruthKind: "answerable",
    evaluationSet: "german-policy-holdout",
  },
  {
    id: "g-policy-file-graph",
    category: "deutsch-policy-holdout",
    text: "Wie stellt der Dateigraph deterministische Ergebnisse zwischen zwei Läufen sicher?",
    expect: ["packages/file-graph/README.md"],
    groundTruthKind: "answerable",
    evaluationSet: "german-policy-holdout",
  },
  {
    id: "g-policy-reconciliation",
    category: "deutsch-policy-holdout",
    text: "Warum verwendet die Reconciliation keinen Fastpath über Dateigröße und mtime?",
    expect: ["packages/watcher/README.md"],
    groundTruthKind: "answerable",
    evaluationSet: "german-policy-holdout",
  },
];

/** Explizite Ground Truth auch fuer die historischen Eintraege ohne Zusatzfeld. */
export function groundTruthKindOf(question) {
  return question.groundTruthKind ?? (question.expect.length > 0 ? "answerable" : "clear_absent");
}
