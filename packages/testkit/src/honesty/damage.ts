/**
 * Beschaedigungen des Eingangs (E4-Absicherung, Teil 1).
 *
 * Eine Stufe, die nur auf gesunden Eingaben geprueft wird, kann faelschlich
 * Vollstaendigkeit behaupten, ohne dass es je auffaellt: es fehlt ja nichts.
 * Erst unter Beschaedigung trennt sich "meldet, was es nicht konnte" von
 * "verschweigt, was es verloren hat".
 *
 * Dieses Modul definiert die Beschaedigungsarten und liefert Bausteine dafuer.
 * Es fuehrt sie nicht aus -- das tut `assert-honest.ts`.
 *
 * Zwei Formen von Beschaedigung, weil nicht jede am Eingang ansetzt:
 *
 *   {@link InputDamage} veraendert die Eingabe (abschneiden, Struktur
 *   zerbrechen, Pflichtfeld entfernen, Groesse ueber jedes Limit treiben).
 *
 *   {@link InvocationDamage} veraendert den AUFRUF (Nebenlaeufigkeit
 *   erzwingen, Abbruchsignal ausloesen) -- die Eingabe bleibt gesund, aber die
 *   Umstaende nicht.
 *
 * E4 gilt auch fuer dieses Modul selbst: eine Beschaedigung, die auf eine
 * bestimmte Funktion nicht anwendbar ist, verschwindet nicht still. Sie meldet
 * {@link damageNotApplicable} MIT Grund, und `assert-honest.ts` schreibt diesen
 * Grund in das Skip-Ledger seines Berichts.
 */

/**
 * Geschlossene Menge der Beschaedigungsarten. Jede Ehrlichkeitspruefung muss
 * jede davon entweder ausfuehren oder mit Grund abbedingen -- siehe
 * `assert-honest.ts`.
 */
export const DAMAGE_KINDS = [
  /** Inhalt abschneiden: der Rest des Eingangs verschwindet. */
  "truncate_content",
  /** Struktur zerbrechen: unbalancierte Begrenzer mitten im Eingang. */
  "break_structure",
  /** Pflichtfeld entfernen: eine zugesicherte Angabe fehlt. */
  "remove_required_field",
  /** Groesse ueber jedes Limit treiben: Budgets, Fenster, Puffer laufen ueber. */
  "exceed_limit",
  /** Nebenlaeufigkeit erzwingen: derselbe Code laeuft verschraenkt mit anderem. */
  "force_concurrency",
  /** Abbruchsignal ausloesen: der Aufruf soll aufhoeren, bevor er fertig ist. */
  "abort_signal",
] as const;

export type DamageKind = (typeof DAMAGE_KINDS)[number];

/** Meldung, dass eine Beschaedigung auf diesen Pruefling nicht anwendbar ist. */
export interface DamageNotApplicable {
  readonly notApplicable: true;
  /** Warum nicht; MUSS nicht leer sein (E4). */
  readonly reason: string;
}

/** Erzeugt eine Nicht-Anwendbar-Meldung und lehnt eine leere Begruendung ab. */
export function damageNotApplicable(reason: string): DamageNotApplicable {
  if (reason.trim() === "") {
    throw new Error("a skipped damage case must carry a non-empty reason (E4)");
  }
  return { notApplicable: true, reason };
}

/** Typwaechter fuer {@link DamageNotApplicable}. */
export function isDamageNotApplicable(value: unknown): value is DamageNotApplicable {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { notApplicable?: unknown }).notApplicable === true &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

/** Beschaedigung der Eingabe. */
export interface InputDamage<TInput> {
  readonly mode: "input";
  /** Stabile, deterministische Kennung; erscheint im Bericht. */
  readonly id: string;
  readonly kind: DamageKind;
  /** Was genau beschaedigt wird; erscheint in der Fehlermeldung. */
  readonly detail: string;
  readonly damage: (input: TInput) => TInput | DamageNotApplicable;
}

/** Beschaedigung der Aufrufumstaende. */
export interface InvocationDamage<TInput, TOutput> {
  readonly mode: "invocation";
  readonly id: string;
  readonly kind: DamageKind;
  readonly detail: string;
  readonly invoke: (
    run: (input: TInput) => Promise<TOutput>,
    input: TInput,
  ) => Promise<TOutput | DamageNotApplicable>;
}

export type DamageCase<TInput, TOutput> = InputDamage<TInput> | InvocationDamage<TInput, TOutput>;

// ---------------------------------------------------------------------------
// Bausteine fuer texttragende Eingaben
// ---------------------------------------------------------------------------

/**
 * Zugriff auf den Text einer Eingabe. Fast jede Untangle-Stufe bekommt
 * irgendwo eine Quelldatei, ein Dokument oder einen Konfigurationstext; der
 * Rest der Eingabe (Identitaet, Konfiguration) bleibt unberuehrt.
 */
export interface TextLens<TInput> {
  readonly read: (input: TInput) => string;
  readonly write: (input: TInput, text: string) => TInput;
}

/** Schneidet an einer Codepoint-Grenze, damit nie ein Surrogatpaar zerfaellt. */
function sliceCodePoints(text: string, count: number): string {
  return [...text].slice(0, count).join("");
}

/**
 * Schneidet den Text nach `keepFraction` seiner Codepoints ab.
 *
 * Das ist die haerteste der harmlos aussehenden Beschaedigungen: der Eingang
 * bleibt syntaktisch oft noch fast plausibel, aber ein Teil des Inhalts ist
 * weg. Wer hier weiterhin "vollstaendig" meldet, meldet Unwahres.
 */
export function truncateContentDamage<TInput>(
  lens: TextLens<TInput>,
  options: { readonly id?: string; readonly keepFraction?: number } = {},
): InputDamage<TInput> {
  const keepFraction = options.keepFraction ?? 0.5;
  return {
    mode: "input",
    id: options.id ?? "truncate_content",
    kind: "truncate_content",
    detail: `keep the first ${String(Math.round(keepFraction * 100))}% of the input text, drop the rest`,
    damage: (input) => {
      const text = lens.read(input);
      const total = [...text].length;
      if (total === 0) {
        return damageNotApplicable("the subject text is empty; truncation cannot remove anything");
      }
      const kept = Math.max(0, Math.min(total - 1, Math.floor(total * keepFraction)));
      return lens.write(input, sliceCodePoints(text, kept));
    },
  };
}

/** Standardmarker: unbalancierte Klammern und Anfuehrungszeichen in jeder Richtung. */
export const STRUCTURE_BREAKING_MARKER = '\n{[( "unterminated <<<UNTANGLE_DAMAGE\n';

/**
 * Setzt unbalancierte Begrenzer mitten in den Text. Bricht Klammer-, Zitat-
 * und Einrueckungsstrukturen aller hier verwendeten Formate.
 */
export function breakStructureDamage<TInput>(
  lens: TextLens<TInput>,
  options: { readonly id?: string; readonly marker?: string } = {},
): InputDamage<TInput> {
  const marker = options.marker ?? STRUCTURE_BREAKING_MARKER;
  return {
    mode: "input",
    id: options.id ?? "break_structure",
    kind: "break_structure",
    detail: "insert unbalanced delimiters in the middle of the input text",
    damage: (input) => {
      const text = lens.read(input);
      const points = [...text];
      const middle = Math.floor(points.length / 2);
      return lens.write(
        input,
        `${points.slice(0, middle).join("")}${marker}${points.slice(middle).join("")}`,
      );
    },
  };
}

/**
 * Vervielfacht den Text, bis jedes Token-, Zeilen- und Puffer-Budget
 * ueberschritten ist.
 */
export function exceedLimitDamage<TInput>(
  lens: TextLens<TInput>,
  options: { readonly id?: string; readonly repeat?: number } = {},
): InputDamage<TInput> {
  const repeat = options.repeat ?? 200;
  return {
    mode: "input",
    id: options.id ?? "exceed_limit",
    kind: "exceed_limit",
    detail: `repeat the input text ${String(repeat)} times to blow past every size budget`,
    damage: (input) => {
      const text = lens.read(input);
      if (text === "") {
        return damageNotApplicable("the subject text is empty; repeating it exceeds no limit");
      }
      return lens.write(input, Array.from({ length: repeat }, () => text).join("\n"));
    },
  };
}

/**
 * Entfernt ein Pflichtfeld. Was ein Pflichtfeld ist, weiss nur der Pruefling,
 * deshalb liefert der Aufrufer die Entfernung selbst.
 */
export function removeRequiredFieldDamage<TInput>(options: {
  readonly id: string;
  readonly detail: string;
  readonly remove: (input: TInput) => TInput | DamageNotApplicable;
}): InputDamage<TInput> {
  return {
    mode: "input",
    id: options.id,
    kind: "remove_required_field",
    detail: options.detail,
    damage: options.remove,
  };
}

// ---------------------------------------------------------------------------
// Bausteine fuer beschaedigte Aufrufumstaende
// ---------------------------------------------------------------------------

/**
 * Laesst denselben Aufruf verschraenkt mit einem Aufruf auf einer ANDEREN
 * Eingabe laufen und liefert das Ergebnis fuer die urspruengliche Eingabe.
 *
 * Der gesuchte Defekt ist geteilter, falsch geschluesselter Zustand: ein
 * Grammatik-Cache, eine Offset-Tabelle, ein Modul-Singleton. Ein solcher
 * Defekt liefert ein VERAENDERTES Ergebnis, ohne irgendetwas zu melden -- die
 * Fehlerklasse dieses Auftrags in ihrer unauffaelligsten Form.
 */
export function concurrencyDamage<TInput, TOutput>(options: {
  readonly id?: string;
  readonly decoy: TInput;
  readonly copies?: number;
}): InvocationDamage<TInput, TOutput> {
  const copies = options.copies ?? 4;
  return {
    mode: "invocation",
    id: options.id ?? "force_concurrency",
    kind: "force_concurrency",
    detail: `run ${String(copies)} invocations interleaved with a different input and read back the first`,
    invoke: async (run, input) => {
      const inputs: TInput[] = [];
      for (let index = 0; index < copies; index += 1) {
        inputs.push(index % 2 === 0 ? input : options.decoy);
      }
      const results = await Promise.all(inputs.map((candidate) => run(candidate)));
      const first = results[0];
      if (first === undefined) {
        return damageNotApplicable("concurrency damage produced no result to compare");
      }
      return first;
    },
  };
}

/**
 * Ruft mit einem BEREITS abgebrochenen `AbortSignal` auf.
 *
 * Bewusst vorab abgebrochen statt mitten im Lauf: ein Abbruch nach `n`
 * Millisekunden waere nicht deterministisch, und Determinismus ist hier
 * Pflicht. `attach` haengt das Signal dort an, wo der Pruefling es erwartet;
 * ein Pruefling ohne Signalparameter meldet {@link damageNotApplicable}.
 */
export function abortSignalDamage<TInput>(options: {
  readonly id?: string;
  readonly attach: (input: TInput, signal: AbortSignal) => TInput | DamageNotApplicable;
}): InputDamage<TInput> {
  return {
    mode: "input",
    id: options.id ?? "abort_signal",
    kind: "abort_signal",
    detail: "invoke with an already-aborted AbortSignal",
    damage: (input) => {
      const controller = new AbortController();
      controller.abort();
      return options.attach(input, controller.signal);
    },
  };
}

/**
 * Die drei textbasierten Standardbeschaedigungen in einem Rutsch. Deckt
 * `truncate_content`, `break_structure` und `exceed_limit` ab; die uebrigen
 * drei Arten haengen vom Pruefling ab und werden einzeln gebaut.
 */
export function standardTextDamages<TInput>(
  lens: TextLens<TInput>,
  options: {
    readonly keepFraction?: number;
    readonly marker?: string;
    readonly repeat?: number;
  } = {},
): readonly InputDamage<TInput>[] {
  return [
    truncateContentDamage(lens, {
      ...(options.keepFraction === undefined ? {} : { keepFraction: options.keepFraction }),
    }),
    breakStructureDamage(lens, {
      ...(options.marker === undefined ? {} : { marker: options.marker }),
    }),
    exceedLimitDamage(lens, {
      ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
    }),
  ];
}
