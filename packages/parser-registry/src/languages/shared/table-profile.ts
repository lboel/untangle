/**
 * Das TABELLENGETRIEBENE Sprachprofil: eine Sprache kostet eine Tabelle,
 * keinen Motor.
 *
 * Wofuer es da ist (WP-220): fuer jede Sprache, fuer die wir KEINE eigene
 * Grammatik und keine handgeschriebenen Detektoren pflegen wollen. Der
 * vereinheitlichte Walk (`engine.ts`) bleibt derselbe; nur die Bedeutung der
 * Knotenarten kommt aus {@link LanguageKindTable} statt aus Fallunterscheidungen
 * im Motor.
 *
 * WAS DIESE FASSUNG LEISTET — und was nicht. Sie deckt Symbole, Kommentare,
 * Entscheidungen, Nesting, Halstead-Token, Importe und Aufrufe ab. Sie ist
 * damit ausdruecklich SCHWAECHER als die handgeschriebene JS/TS-Fassung
 * (`js-family-profile.ts`), und das steht hier, damit es niemand aus der
 * Ausgabe erraten muss:
 *
 *   - Importbindungen (`RawImport.bindings`) liefert sie nur, wo die Tabelle
 *     ein Aliasfeld nennt. Sonst FEHLT das Feld, statt eine Zuordnung zu
 *     erfinden — der Vertrag in domain `analysis.ts` sagt ausdruecklich, dass
 *     ein fehlendes Feld "unbekannt" heisst und Namensgleichheit kein Beweis ist.
 *   - Der Aufrufqualifizierer kommt aus der Form des Aufrufziels, nicht aus
 *     einer Namensaufloesung. `a.b.c()` liefert Qualifizierer `a.b`.
 *   - `normalizedSignature` ist der Kopf bis zum Rumpf, mit den
 *     Leerraumregeln aus `signature.ts`. Vorgabewerte werden NICHT entfernt
 *     (das ist eine JS/TS-Regel und waere anderswo geraten).
 *
 * Wer eine dieser Grenzen fuer eine Sprache nicht hinnehmen will, schreibt fuer
 * sie ein eigenes Profil — der Vertrag dafuer ist `profile.ts`, und der Motor
 * merkt den Unterschied nicht.
 */
import type { LiteralFact, SupportLevel } from "@untangle-code/domain";

import type { LanguageProfile } from "./profile.js";
import type { ScopeNode } from "./scope-model.js";
import type { SyntaxNode } from "./syntax.js";
import { TableDecisionDetector } from "./table-profile-decisions.js";
import { TableModuleFactCollector } from "./table-profile-module-facts.js";
import { setOf } from "./table-profile-queries.js";
import { TableScopeResolver } from "./table-profile-scopes.js";

/** Wie eine Knotenart zu einem Symbolscope wird. */
export interface ScopeRule {
  /** Knotenarten, die diesen Scope oeffnen. */
  kinds: readonly string[];
  scopeKind: ScopeNode["kind"];
  /**
   * Feld, das den Namen traegt (Vorgabe: `name`). Ein PUNKT trennt einen
   * Feldpfad: Javas `field_declaration` fuehrt seinen Namen unter
   * `declarator.name`, nicht unter `name`.
   */
  nameField?: string;
  /**
   * Feld mit dem TRAEGER, wenn die Sprache ihn nicht als Elternknoten fuehrt
   * (WP-237). Gos `method_declaration` traegt `(a *A)` unter `receiver`; ohne
   * diesen Zusatz heissen `(*A).Run` und `(*B).Run` beide `Run`.
   */
  qualifierField?: string;
  /**
   * Knotenarten, die im Traegerfeld den eigentlichen Namen tragen. Der erste
   * Treffer in Quelltextreihenfolge gewinnt. Go nennt den Typ eines
   * Empfaengers `type_identifier`; so bleibt auch `Pair[A, B]` strukturell
   * `Pair`, ohne den Quelltext an Leerzeichen oder Klammern zu zerlegen.
   */
  qualifierNameKinds?: readonly string[];
  /**
   * Dem Namensfeld so lange weiter folgen, wie es weiterfuehrt. C schreibt
   * `ring_t *ring_new(size_t)` als
   * `function_definition.declarator -> pointer_declarator.declarator ->
   * function_declarator.declarator -> identifier`; ohne diesen Abstieg hiesse
   * jede zeigerwertige Funktion `*ring_new(...)`.
   */
  nameDescend?: boolean;
  /**
   * Kette von KINDKNOTENARTEN, die vor der Namenssuche abgestiegen wird.
   * C# schreibt ein Feld als `field_declaration > variable_declaration >
   * variable_declarator.name`, PHP als `property_declaration >
   * property_element.name`. Ohne den Abstieg stuende der ganze Text im
   * Namen (`"Dictionary<string, string> _items = new()"`).
   */
  nameKindPath?: readonly string[];
  /** Ersatzweise: Kindknotenarten, deren Text der Name ist (erste Fundstelle). */
  nameKinds?: readonly string[];
  /**
   * Nur dann ein Scope, wenn der ELTERNKNOTEN von dieser Art ist.
   *
   * WOFUER: Kotlin und Swift benutzen `property_declaration` sowohl fuer ein
   * Klassenfeld als auch fuer eine LOKALE Variable in einem Funktionsrumpf.
   * Ohne diese Schranke wuerde `var i = 0` mitten in einer Methode als Symbol
   * gemeldet — eine falsche Aussage ueber die Datei, die in Hotspots,
   * Ratsche und Risikobewertung einflosse.
   */
  parentKinds?: readonly string[];
  /**
   * Mindestens ein VORFAHRE muss von einer dieser Arten sein. Das grenzt
   * syntaktisch identische Deklarationen nach ihrem Kontext ab: Rust verwendet
   * `function_signature_item` sowohl in Traits als auch in `extern`-Bloecken,
   * aber nur die Trait-Signatur ist eine Methode des analysierten Codes.
   */
  ancestorKinds?: readonly string[];
  /**
   * Namen, die diesen Scope zu einem Konstruktor machen (Java `<init>`,
   * Rust `new`, ...). Leer heisst: nie ein Konstruktor.
   */
  constructorNames?: readonly string[];
  /**
   * Verfeinerung nach einem Kindknoten. Go kennt nur `type_spec`; ob daraus
   * eine Klasse (`struct_type`), eine Schnittstelle (`interface_type`) oder ein
   * Typalias wird, steht erst im Kind. Ohne diese Regel muesste die Tabelle
   * luegen oder alles zu `type` einebnen.
   */
  refine?: readonly { childKinds: readonly string[]; scopeKind: ScopeNode["kind"] }[];
}

/** Entscheidungs- und Nesting-Regeln (spec.md §16.2–§16.4). */
export interface DecisionRules {
  ifKinds: readonly string[];
  /**
   * Elternknotenarten, die ein `if` zu einem `else if` machen (JS/Rust:
   * `else_clause`, Go: `if_statement` selbst). Ohne Eintrag gibt es kein
   * `else_if` — und die Zaehlung sagt das dann auch nicht.
   */
  elseIfParentKinds?: readonly string[];
  /**
   * Huellen, unter denen ein `if` nur dann eine Fortsetzung ist, wenn die
   * Huelle unmittelbar auf ein anonymes `else`-Geschwister folgt. Kotlin
   * bildet `else if` als `else > control_structure_body > if_expression` ab;
   * ein `if` im Dann-Rumpf hat dieselbe Huelle, aber kein `else` davor.
   */
  elseIfWrapperKinds?: readonly string[];
  /**
   * Bereichssichere Korrektur fuer Grammatiken, die ein gueltiges
   * `else /* Kommentar *\/ if` in Geschwister zerlegen und dabei das anonyme
   * `else`-Token aus dem Baum verlieren. Aktiviert wird sie nur fuer die
   * betroffene Sprache; erkannt wird ausschliesslich ein exaktes `else` im
   * begrenzten Quelltextspalt zwischen zwei AST-Geschwistern.
   */
  recoverDetachedElseIfAfterComments?: boolean;
  /**
   * Knotenarten, die SELBST ein `else if` sind (Ruby `elsif`, PHP
   * `else_if_clause`, Bash `elif_clause`). Anders als
   * {@link DecisionRules.elseIfParentKinds} braucht es dafuer keinen Blick auf
   * den Elternknoten — die Grammatik sagt es schon.
   */
  elseIfKinds?: readonly string[];
  loopKinds: readonly string[];
  catchKinds?: readonly string[];
  /**
   * Knotenarten, die eine vorzeitige Rueckkehr SIND (Swift `guard`). Die
   * Guard-Erkennung ueber `consequenceField`/`jumpKinds` findet nur die
   * `if`-Form; wo die Sprache ein eigenes Schluesselwort hat, steht es hier.
   */
  guardKinds?: readonly string[];
  /**
   * Musteralternativen (`Some(1) | Some(2)` in Rust) — `DecisionKind`
   * `pattern_alternative`.
   */
  patternAlternativeKinds?: readonly string[];
  /**
   * Knotenarten, die einen KURZSCHLUSS darstellen, ohne ein Operatorfeld zu
   * haben: Rusts `try_expression` (der `?`-Operator). Sie zaehlen wie ein
   * logischer Operator NUR erweitert (spec.md §16.3), nie klassisch.
   */
  shortCircuitKinds?: readonly string[];
  ternaryKinds?: readonly string[];
  switchKinds?: readonly string[];
  caseKinds?: readonly string[];
  /**
   * Ein `case`-Knoten mit einem DIREKTEN Kind dieser Art ist der
   * Auffangzweig (`default:`) und zaehlt NICHT. Java und C fuehren `case X:`
   * und `default:` unter DERSELBEN Knotenart; ohne diese Ausnahme bekaeme
   * jeder `switch` eine Entscheidung zu viel.
   */
  caseExcludeChildKinds?: readonly string[];
  /** Dasselbe ueber den Text des ersten Kindes (Bashs Auffangmuster `*)`). */
  caseExcludeFirstChildText?: string;
  /** Binaerausdruecke, deren Operator ueber `operatorField` erreichbar ist. */
  binaryKinds?: readonly string[];
  /**
   * Knotenarten, deren Operator KEIN Feld ist, sondern das erste anonyme Kind.
   * Kotlin (`conjunction_expression`), Swift (`disjunction_expression`) und
   * Bash (`list` mit `&&`/`||`) vergeben dort keine Feldnamen.
   */
  anonymousOperatorKinds?: readonly string[];
  operatorField?: string;
  logicalAndOperators?: readonly string[];
  logicalOrOperators?: readonly string[];
  shortCircuitOperators?: readonly string[];
  /** Sprunganweisungen fuer die Guard-Clause-Erkennung. */
  jumpKinds?: readonly string[];
  /** Rumpfhuellen, die fuer die Guard-Erkennung durchsichtig sind (Go: `block`+`statement_list`). */
  blockKinds?: readonly string[];
  consequenceField?: string;
  alternativeField?: string;
}

/** Importregeln. */
export interface ImportRules {
  /** Anweisungsarten, die einen Import darstellen. */
  kinds: readonly string[];
  /** Untereintraege innerhalb der Anweisung (Go: `import_spec`). Leer: die Anweisung selbst. */
  specKinds?: readonly string[];
  /** Feld mit dem Pfad/Ziel (Go `path`, Rust `argument`). */
  pathField?: string;
  /** Ersatzweise: Knotenarten, deren Text der Pfad ist. */
  pathKinds?: readonly string[];
  /** Feld mit dem lokalen Namen (Alias), wenn die Sprache eines hat. */
  aliasField?: string;
  /**
   * Auspacken zusammengesetzter Ziele. Rust schreibt
   * `use a::b as c` (`use_as_clause`) und `use a::{b, c}` (`scoped_use_list`);
   * ohne diese Regel stuende der ganze Ausdruck als "Pfad" im Ergebnis.
   */
  unwrap?: readonly {
    kinds: readonly string[];
    pathField: string;
    aliasField?: string;
    /** Feld mit der Namensliste; ihre BENANNTEN Kinder werden zu `importedNames`. */
    namesField?: string;
  }[];
}

/** Aufrufregeln. */
export interface CallRules {
  kinds: readonly string[];
  /** Feld mit dem Aufrufziel (Vorgabe: `function`). */
  functionField?: string;
  /** Feld mit der Argumentliste (Vorgabe: `arguments`). */
  argumentsField?: string;
  /** Zugriffsformen `a.b` / `a::b`, aus denen Qualifizierer und Name entstehen. */
  memberKinds?: readonly string[];
  /**
   * Feld mit dem EMPFAENGER, wenn die Sprache ihn getrennt fuehrt statt in
   * einem Zugriffsknoten: Javas `method_invocation` hat `object` und `name`
   * nebeneinander, Rubys `call` hat `receiver` und `method`. Ohne dieses Feld
   * ginge der Qualifizierer dort verloren.
   */
  receiverField?: string;
  /** Konstruktoraufrufe (`new X()`), falls die Sprache eine eigene Knotenart hat. */
  constructionKinds?: readonly string[];
  /** Feld mit dem Typ eines Konstruktoraufrufs. */
  constructedTypeField?: string;
  /**
   * Zusaetzliche Bedingung, die ein Kandidat erfuellen muss.
   *
   * WOFUER: Swift benutzt `call_expression` AUCH fuer Indexzugriffe
   * (`items["a"]`). Ohne Filter meldete der Adapter `items` als Aufrufziel —
   * ein Aufruf, den es nicht gibt.
   */
  acceptCall?: (node: SyntaxNode) => boolean;
}

/** Die vollstaendige Tabelle einer Sprache. */
export interface LanguageKindTable {
  languageId: string;
  extensions: readonly string[];
  supportLevel: SupportLevel;
  commentKinds: readonly string[];
  /** Knoten, deren Teilbaum EIN Operand ist (Zeichenkettenliterale). */
  stringContainerKinds: readonly string[];
  identifierLeafKinds: readonly string[];
  numberLeafKinds?: readonly string[];
  booleanLeafKinds?: readonly string[];
  nullLeafKinds?: readonly string[];
  /** Satzzeichen, die weder Operator noch Operand sind (Vorgabe: {@link DEFAULT_PUNCTUATION}). */
  punctuationKinds?: readonly string[];
  scopes: readonly ScopeRule[];
  decisions: DecisionRules;
  imports: ImportRules;
  calls: CallRules;
  /** Elternknotenarten, in denen ein Bezeichner im Namensfeld eine Deklaration ist. */
  declarationParentKinds: readonly string[];
  /** Knotenarten, deren Text die Sichtbarkeit angibt (Rust `visibility_modifier`). */
  visibilityKinds?: readonly string[];
  /**
   * Wenn der Sichtbarkeitsknoten ein SACK von Modifikatoren ist (Javas
   * `modifiers` traegt `private final static` in EINEM Knoten): das erste
   * Wort daraus, das in dieser Liste steht, ist die Sichtbarkeit. Ohne die
   * Liste stuende `"private final"` im Ergebnis — eine Angabe, die kein
   * Verbraucher vergleichen kann.
   */
  visibilityWords?: readonly string[];
  /** Feld mit dem Rumpf — alles davor ist die Signatur (Vorgabe: `body`). */
  bodyField?: string;
  /**
   * Ist dieser Name aus der Datei heraus sichtbar? Go entscheidet das am
   * Grossbuchstaben, Rust am `pub`. Fehlt der Haken, meldet das Profil KEINE
   * exportierten Namen — lieber nichts als eine erfundene Sichtbarkeit.
   */
  isExported?: (name: string, node: SyntaxNode) => boolean;
  /**
   * Feldnamen, die der ast-grep-Cursor am Elternknoten abfragen darf, um
   * `currentFieldName` zu bestimmen (ast-grep kennt keine Umkehrrichtung,
   * siehe `languages/astgrep-backend/syntax.ts`). Vorgabe: `["name"]`.
   */
  fieldNames?: readonly string[];
}

/** Satzzeichen, die in fast jeder Sprache reine Struktur sind. */
export const DEFAULT_PUNCTUATION: readonly string[] = [
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ";",
  ".",
  ":",
];
/**
 * Die Blattklassifikation ist eine eigene Verantwortung: Sie kennt weder
 * Scopes noch Kontrollfluss, Importe oder Aufrufe.
 */
class TableTokenClassifier {
  readonly commentKinds: ReadonlySet<string>;
  readonly literalContainerKinds: ReadonlySet<string>;
  readonly identifierLeafKinds: ReadonlySet<string>;
  readonly simpleLiteralLeafKinds: ReadonlySet<string>;
  readonly punctuationKinds: ReadonlySet<string>;

  private readonly numberKinds: ReadonlySet<string>;
  private readonly booleanKinds: ReadonlySet<string>;
  private readonly nullKinds: ReadonlySet<string>;
  private readonly declarationParentKinds: ReadonlySet<string>;

  constructor(table: LanguageKindTable) {
    this.commentKinds = setOf(table.commentKinds);
    this.literalContainerKinds = setOf(table.stringContainerKinds);
    this.identifierLeafKinds = setOf(table.identifierLeafKinds);
    this.numberKinds = setOf(table.numberLeafKinds);
    this.booleanKinds = setOf(table.booleanLeafKinds);
    this.nullKinds = setOf(table.nullLeafKinds);
    this.simpleLiteralLeafKinds = new Set([
      ...this.numberKinds,
      ...this.booleanKinds,
      ...this.nullKinds,
    ]);
    this.punctuationKinds = setOf(table.punctuationKinds ?? DEFAULT_PUNCTUATION);
    this.declarationParentKinds = setOf(table.declarationParentKinds);
  }

  literalKindOf(kind: string): LiteralFact["literalKind"] {
    if (this.numberKinds.has(kind)) return "number";
    if (this.booleanKinds.has(kind)) return "boolean";
    if (this.nullKinds.has(kind)) return "null";
    return "other";
  }

  identifierRoleOf(fieldName: string | undefined, parentKind: string): "declaration" | "reference" {
    return fieldName === "name" && this.declarationParentKinds.has(parentKind)
      ? "declaration"
      : "reference";
  }
}

function stringLiteralKind(): LiteralFact["literalKind"] {
  return "string";
}

function neverSuppressScope(): boolean {
  return false;
}

function noMemberRegions(): [] {
  return [];
}

/**
 * Baut ein Profil aus vier kompilierten, unabhaengigen Verantwortungen.
 *
 * WP-239: Diese Funktion verdrahtet nur noch Tokens, Scopes, Entscheidungen
 * und Modul-Fakten. Die jeweiligen Regeln leben in kleinen Resolvern mit
 * eigener Zustandsmenge; der vorherige 500-Zeilen-Abschluss ist verschwunden.
 */
export function createTableProfile(table: LanguageKindTable): LanguageProfile {
  const tokens = new TableTokenClassifier(table);
  const scopes = new TableScopeResolver(table, tokens.commentKinds);
  const decisions = new TableDecisionDetector(table.decisions, tokens.commentKinds);
  const moduleFacts = new TableModuleFactCollector(table.imports, table.calls);
  const needsNodeKinds = new Set([
    ...scopes.nodeKinds,
    ...decisions.nodeKinds,
    ...moduleFacts.nodeKinds,
  ]);

  return {
    languageId: table.languageId,
    extensions: table.extensions,
    supportLevel: table.supportLevel,

    commentKinds: tokens.commentKinds,
    literalContainerKinds: tokens.literalContainerKinds,
    identifierLeafKinds: tokens.identifierLeafKinds,
    simpleLiteralLeafKinds: tokens.simpleLiteralLeafKinds,
    templateTextLeafKinds: new Set<string>(),
    ignoredPunctuationKinds: tokens.punctuationKinds,
    typeKeywordParentKinds: new Set<string>(),
    functionLikeKinds: scopes.functionLikeKinds,
    exportWrapperKinds: new Set<string>(),

    containerLiteralKind: stringLiteralKind,
    simpleLiteralKind: tokens.literalKindOf.bind(tokens),
    identifierRole: tokens.identifierRoleOf.bind(tokens),
    needsNode: needsNodeKinds.has.bind(needsNodeKinds),

    scopeKindOf: scopes.kindOf.bind(scopes),
    suppressesScope: neverSuppressScope,
    scopeName: scopes.nameOf.bind(scopes),
    scopeQualifier: scopes.qualifierOf.bind(scopes),
    scopeSignature: scopes.signatureOf.bind(scopes),
    docRange: scopes.docRangeOf.bind(scopes),
    visibility: scopes.visibilityOf.bind(scopes),
    exportedNames: scopes.exportedNamesOf.bind(scopes),

    detectDecisionAndNesting: decisions.detect.bind(decisions),
    collectModuleFacts: moduleFacts.collect.bind(moduleFacts),
    memberRegions: noMemberRegions,
  };
}

/** Die Feldnamen, die ein Backend ohne Feldnamen-Rueckrichtung abfragen muss. */
export function fieldNamesOf(table: LanguageKindTable): readonly string[] {
  const names = new Set<string>(table.fieldNames ?? ["name"]);
  for (const rule of table.scopes) names.add(rule.nameField ?? "name");
  return [...names];
}
