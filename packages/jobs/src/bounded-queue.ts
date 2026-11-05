/**
 * Bounded FIFO queue with backpressure (architecture.md §13.1–§13.2).
 *
 * A full queue makes `push()` WAIT — that is the mechanism by which a slow
 * downstream stage pauses the previous stage instead of letting it
 * accumulate unbounded ASTs/vectors in memory. Bounds are enforced on both
 * item count (`capacity`) and, optionally, estimated bytes (`maxBytes` with
 * a `sizeOf` cost function), so the pipeline's memory budget is a hard
 * limit, not a hope. All observed values are exposed via `stats()` for the
 * job status output (spec-driven visibility, architecture.md §13.2).
 *
 * Die EINZIGE Ausnahme vom Byte-Budget ist ein Element, das das ganze Budget
 * allein uebersteigt: fuer so ein Element kann Warten nie Platz schaffen, es
 * wuerde die Queue also nicht bremsen, sondern haengen lassen. Diese Ausnahme
 * ist eng gefasst (leere Queue, kontingentiert, gezaehlt, gemeldet) — sie war
 * frueher an den Fuellstand geknuepft und damit bei `capacity: 1` ein
 * Dauerzustand, der die Byte-Grenze mit gueltigen Werten abschaltete (WP-116).
 */
import type { PortCallOptions } from "@untangle-code/domain";
import { indexIncompleteError } from "@untangle-code/observability";

import { abortedPromise, throwIfAborted } from "./abort.js";

/**
 * Vorgabe fuer `maxOverBudgetAdmissions`: genau EIN Element, das das Budget
 * allein sprengt, darf passieren (sonst haengt die Queue an ihm fest). Jedes
 * weitere ist ein Konfigurationsfehler und wird als solcher gemeldet.
 */
const DEFAULT_OVER_BUDGET_ALLOWANCE = 1;

/**
 * Eine Aufnahme, die das Byte-Budget verletzt hat, weil das Element ALLEIN
 * groesser als das gesamte Budget ist. Wird gezaehlt und gemeldet — eine
 * Budgetverletzung darf nie stillschweigend passieren (E4).
 */
export interface OverBudgetAdmissionV1 {
  /** Groesse des aufgenommenen Elements in Bytes (> `maxBytes`). */
  itemBytes: number;
  /** Das Budget, das dieses Element allein ueberschreitet. */
  maxBytes: number;
  /** Die wievielte Ausnahme dieser Queue (1-basiert). */
  ordinal: number;
  /** Wie viele solcher Ausnahmen diese Queue insgesamt zulaesst. */
  allowance: number;
}

export interface BoundedQueueOptions<T> {
  /** Maximum number of buffered items; must be a safe integer >= 1. */
  capacity: number;
  /** Optional byte budget across all buffered items. Requires `sizeOf`. */
  maxBytes?: number;
  /** Estimated size of one item in bytes; required when `maxBytes` is set. */
  sizeOf?: (item: T) => number;
  /**
   * Wie viele Elemente, die das Byte-Budget ALLEIN uebersteigen, darf diese
   * Queue insgesamt aufnehmen? Vorgabe: 1.
   *
   * Die Ausnahme existiert nur, damit EIN einzelnes uebergrosses Element die
   * Queue nicht dauerhaft blockiert (warten kann fuer so ein Element nie
   * Platz schaffen). Sie ist ausdruecklich kein Dauerzustand: ist das
   * Kontingent erschoepft, scheitert `push()` mit einem benannten Fehler,
   * statt das Budget weiter stillschweigend zu ueberschreiten. `0` lehnt
   * schon das erste uebergrosse Element ab.
   */
  maxOverBudgetAdmissions?: number;
  /**
   * Wird bei JEDER Ausnahme gerufen — der vorgesehene Weg, die
   * Budgetverletzung in Log, Diagnostics oder Skip-Ledger sichtbar zu
   * machen. Wirft der Rueckruf, scheitert der `push()`.
   */
  onOverBudgetAdmission?: (admission: OverBudgetAdmissionV1) => void;
}

/** Snapshot of one queue for status output and tests. */
export interface QueueStatsV1 {
  depth: number;
  capacity: number;
  bytes: number;
  maxBytes: number | null;
  /** High-water marks since construction — prove boundedness in tests. */
  maxDepthObserved: number;
  maxBytesObserved: number;
  /**
   * Anzahl der Elemente, die trotz Budgetueberschreitung aufgenommen wurden,
   * weil sie allein groesser als das gesamte Budget sind. `> 0` ist die
   * Erklaerung dafuer, dass `maxBytesObserved > maxBytes` sein kann — ohne
   * diesen Zaehler waere die Budgetverletzung unsichtbar (E4).
   */
  overBudgetAdmissions: number;
  /** Wie viele solcher Ausnahmen diese Queue insgesamt zulaesst. */
  overBudgetAllowance: number;
  /** Groesstes je aufgenommenes Einzelelement in Bytes. */
  maxItemBytesObserved: number;
}

export type QueuePullResult<T> = { done: true } | { done: false; value: T };

interface Slot<T> {
  item: T;
  size: number;
}

export class BoundedQueue<T> {
  private readonly slots: Slot<T>[] = [];
  private readonly capacity: number;
  private readonly maxBytes: number | null;
  private readonly sizeOf: ((item: T) => number) | null;
  private readonly overBudgetAllowance: number;
  private readonly onOverBudgetAdmission: ((admission: OverBudgetAdmissionV1) => void) | null;
  private overBudgetAdmissions = 0;
  private maxItemBytesObserved = 0;
  private bytes = 0;
  private closed = false;
  private failure: { error: unknown } | null = null;
  private wakers: Array<() => void> = [];
  private maxDepthObserved = 0;
  private maxBytesObserved = 0;

  public constructor(options: BoundedQueueOptions<T>) {
    // WP-116: `capacity` ist ueber `IndexJobRunnerOptions.queueCapacities`
    // frei konfigurierbar und entscheidet mit darueber, ob die Byte-Grenze
    // ueberhaupt greifen kann — deshalb wird sie hier so hart geprueft wie
    // `maxBytes`. `Number.isInteger(1e21)` ist true, `isSafeInteger` nicht:
    // eine Kapazitaet jenseits der sicheren Ganzzahlen ist als Grenze
    // wertlos, weil Vergleiche und Zaehler darauf nicht mehr exakt sind.
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error(
        `BoundedQueue capacity must be a safe integer >= 1, got ${String(options.capacity)}`,
      );
    }
    if (options.maxBytes !== undefined) {
      if (options.sizeOf === undefined) {
        throw new Error("BoundedQueue maxBytes requires a sizeOf cost function");
      }
      // Same defect class as an invalid per-item size (see `validateSize`
      // below): a non-finite/negative budget disables the byte check just
      // as surely as a poisoned item does, only permanently instead of
      // transiently — e.g. `Math.floor(memoryBudgetBytes / 2)` silently
      // produces `NaN`/`Infinity` when a caller's `memoryBudgetBytes` is
      // itself malformed (runner.ts). Reject at construction, before any
      // item is ever admitted.
      BoundedQueue.validateSize(options.maxBytes, "maxBytes");
    }
    const allowance = options.maxOverBudgetAdmissions ?? DEFAULT_OVER_BUDGET_ALLOWANCE;
    if (!Number.isSafeInteger(allowance) || allowance < 0) {
      throw new Error(
        `BoundedQueue maxOverBudgetAdmissions must be a safe integer >= 0, got ${String(
          options.maxOverBudgetAdmissions,
        )}`,
      );
    }
    this.capacity = options.capacity;
    this.maxBytes = options.maxBytes ?? null;
    this.sizeOf = options.sizeOf ?? null;
    this.overBudgetAllowance = allowance;
    this.onOverBudgetAdmission = options.onOverBudgetAdmission ?? null;
  }

  /**
   * Rejects a caller-supplied byte size (a per-item `sizeOf(item)` result or
   * the constructor's `maxBytes`) that is not finite and >= 0.
   *
   * This is deliberately a hard rejection, never a clamp to some
   * conservative substitute: the whole point of `maxBytes`/`sizeOf` is that
   * the QUEUE trusts the caller's cost estimate to keep the pipeline's
   * memory bound truthful (architecture.md §13.2, "a hard limit, not a
   * hope"). A `NaN`/`Infinity`/negative size means that trust is already
   * broken — the caller's cost model produced a value with no relationship
   * to real memory use — so any number the queue might invent instead
   * (0, the budget itself, the last good size, …) would just re-establish
   * that same false trust one layer down and let corrupted accounting
   * accumulate exactly as the adversarial repro showed (`Infinity` on an
   * empty queue turns `bytes` into `NaN` on the very next `pull()`, which
   * then compares `false` against every future budget check forever). A
   * caller that cannot produce a valid size has a bug that must surface as
   * a failed job (spec.md §25.2: write-side operations fail closed when
   * consistency cannot be guaranteed), not as a silently-disabled budget.
   */
  private static validateSize(size: number, field: "maxBytes" | "sizeOf(item)"): void {
    if (Number.isFinite(size) && size >= 0) {
      return;
    }
    throw indexIncompleteError(
      `BoundedQueue received an invalid byte size from ${field} (${String(size)}); ` +
        "sizes must be finite numbers >= 0 — a NaN/Infinity/negative size would " +
        "silently disable the byte budget (architecture.md §13.2)",
      { retryable: false, operation: "bounded_queue_size", context: { field, size } },
    );
  }

  /**
   * Defense-in-depth invariant on the running `bytes` counter itself, on
   * top of `validateSize()` at every entry point: `bytes` is a sum of
   * values that already passed `validateSize()`, so it should never go
   * non-finite or negative — but "should never" is not a guarantee, and a
   * counter that silently drifts into `NaN`/negative is exactly as
   * dangerous as an unchecked input (it disables the same budget check the
   * same way). Called after every mutation of `bytes`; poisons the queue
   * and throws rather than letting `push()`/`pull()` keep computing on a
   * counter that can no longer prove the budget (spec.md §25.2, fail
   * closed).
   */
  private assertByteCounterIntact(operation: string): void {
    if (Number.isFinite(this.bytes) && this.bytes >= 0) {
      return;
    }
    const corrupted = indexIncompleteError(
      `BoundedQueue's internal byte counter became invalid (${String(this.bytes)}) during ` +
        `${operation}() despite validated inputs — refusing to continue accounting on a ` +
        "counter that can no longer prove the byte budget (architecture.md §13.2)",
      { retryable: false, operation: `bounded_queue_${operation}`, context: { bytes: this.bytes } },
    );
    // Poison rather than merely throw: a corrupted counter is a queue-wide
    // invariant violation, not a one-off bad call — every other pending and
    // future push()/pull() must see the same failure.
    this.fail(corrupted);
    throw corrupted;
  }

  private notify(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const wake of wakers) {
      wake();
    }
  }

  private async waitForChange(signal: AbortSignal | undefined): Promise<void> {
    const wake = new Promise<void>((resolve) => this.wakers.push(resolve));
    if (signal === undefined) {
      await wake;
      return;
    }
    const cleanup = new AbortController();
    try {
      await Promise.race([wake, abortedPromise(signal, cleanup.signal)]);
    } finally {
      cleanup.abort();
    }
  }

  /**
   * Entscheidet ueber eine Aufnahme, ohne etwas zu veraendern.
   *
   * - `"admit"`  — Element passt in beide Grenzen.
   * - `"wait"`   — kein Platz; Warten kann Platz schaffen (Rueckstau).
   * - `"over-budget"` — Element ist ALLEIN groesser als das ganze Budget:
   *   Warten kann fuer dieses Element nie Platz schaffen, die Ausnahme greift.
   *
   * WP-116: Frueher haengte der Byte-Zweig an `slots.length > 0`. Auf einer
   * leeren Queue ist `bytes === 0`, also fiel „Element passt nicht ins
   * Budget" mit „Element ist allein zu gross" nur zufaellig zusammen — und
   * bei `capacity: 1` ist die Queue vor JEDEM Push leer, womit die Ausnahme
   * zum Dauerzustand wurde und die Byte-Grenze mit voellig gueltigen Werten
   * abgeschaltet war (belegt: 20 x 50 MB durch ein 100-Byte-Budget). Die
   * Bedingung steht jetzt dort, wo sie hingehoert: am ELEMENT
   * (`size > maxBytes`), nicht am Fuellstand.
   */
  private admissionVerdict(size: number): "admit" | "wait" | "over-budget" {
    if (this.slots.length >= this.capacity) {
      return "wait";
    }
    if (this.maxBytes === null) {
      return "admit";
    }
    this.assertEmptyStateCounter();
    if (this.bytes + size <= this.maxBytes) {
      return "admit";
    }
    if (size > this.maxBytes) {
      // Das Element sprengt das Budget aus eigener Kraft. Es wird nur in die
      // LEERE Queue aufgenommen, damit die Verletzung nie mit anderen
      // Elementen kumuliert; ist noch etwas gepuffert, schafft Warten sehr
      // wohl Platz (naemlich die leere Queue).
      return this.slots.length === 0 ? "over-budget" : "wait";
    }
    // Passt grundsaetzlich ins Budget, gerade nur nicht: klassischer
    // Rueckstau — genau der Mechanismus, den §13.2 will.
    return "wait";
  }

  /**
   * Invariante der leeren Queue: ohne gepufferte Elemente MUSS `bytes` 0
   * sein. Frueher hat der Byte-Zweig diese Annahme stillschweigend benutzt
   * (`slots.length > 0` als Ersatz fuer `bytes === 0`); jetzt wird sie
   * geprueft, damit eine kuenftige Abweichung als Fehler auffaellt und nicht
   * als lautlos abgeschaltete Grenze.
   */
  private assertEmptyStateCounter(): void {
    if (this.slots.length !== 0 || this.bytes === 0) {
      return;
    }
    const corrupted = indexIncompleteError(
      `BoundedQueue holds no items but its byte counter reads ${String(this.bytes)} — the byte ` +
        "budget can no longer be proven, refusing to admit further items (architecture.md §13.2)",
      {
        retryable: false,
        operation: "bounded_queue_empty_state",
        context: { bytes: this.bytes, depth: this.slots.length },
      },
    );
    this.fail(corrupted);
    throw corrupted;
  }

  /**
   * Bucht eine Ausnahme. Ist das Kontingent erschoepft, scheitert der Push
   * mit benanntem, nicht wiederholbarem Fehler — fail closed (spec.md
   * §25.2) statt einer Budgetverletzung, die niemand sieht. Absichtlich
   * KEIN Warten: fuer ein Element groesser als das Budget kann Warten nie
   * Platz schaffen, ein Warten waere ein Haenger statt eines Rueckstaus.
   */
  private admitOverBudget(size: number): void {
    const maxBytes = this.maxBytes ?? 0;
    if (this.overBudgetAdmissions >= this.overBudgetAllowance) {
      throw indexIncompleteError(
        `BoundedQueue refuses a ${String(size)}-byte item: it exceeds the queue's entire ` +
          `${String(maxBytes)}-byte budget on its own, and this queue already admitted ` +
          `${String(this.overBudgetAdmissions)} such item(s) (allowance ` +
          `${String(this.overBudgetAllowance)}). The exception exists for a SINGLE oversized ` +
          "item that would otherwise block the queue forever, not as a permanent state that " +
          "turns the byte budget off (architecture.md §13.2). Raise the byte budget, reduce the " +
          "item size, or skip this item and record the skip with a reason.",
        {
          retryable: false,
          operation: "bounded_queue_push",
          context: {
            itemBytes: size,
            maxBytes,
            overBudgetAdmissions: this.overBudgetAdmissions,
            allowance: this.overBudgetAllowance,
          },
        },
      );
    }
    this.overBudgetAdmissions += 1;
    this.onOverBudgetAdmission?.({
      itemBytes: size,
      maxBytes,
      ordinal: this.overBudgetAdmissions,
      allowance: this.overBudgetAllowance,
    });
  }

  /**
   * Enqueues `item`, waiting while the queue is full (count or byte bound) —
   * this wait IS the backpressure that pauses the previous stage. Rejects
   * with `JOB_CANCELLED` when `options.signal` aborts, and with the failure
   * error after `fail()`.
   */
  public async push(item: T, options?: PortCallOptions): Promise<void> {
    const size = this.sizeOf === null ? 0 : this.sizeOf(item);
    // Validate BEFORE the item ever reaches `hasRoomFor()`/`bytes` — an
    // invalid size must never be accepted "for now" and dealt with later;
    // by the time it is in `bytes` it has already corrupted the budget.
    BoundedQueue.validateSize(size, "sizeOf(item)");
    while (true) {
      if (this.failure !== null) {
        throw this.failure.error;
      }
      if (this.closed) {
        throw new Error("BoundedQueue.push() called after close()");
      }
      throwIfAborted(options?.signal, "bounded_queue_push");
      const verdict = this.admissionVerdict(size);
      if (verdict === "admit") {
        break;
      }
      if (verdict === "over-budget") {
        // Bucht die Ausnahme oder wirft, wenn das Kontingent aufgebraucht
        // ist. Erst NACH dieser Buchung wird das Element aufgenommen.
        this.admitOverBudget(size);
        break;
      }
      await this.waitForChange(options?.signal);
    }
    this.slots.push({ item, size });
    this.bytes += size;
    this.assertByteCounterIntact("push");
    this.maxDepthObserved = Math.max(this.maxDepthObserved, this.slots.length);
    this.maxBytesObserved = Math.max(this.maxBytesObserved, this.bytes);
    this.maxItemBytesObserved = Math.max(this.maxItemBytesObserved, size);
    this.notify();
  }

  /**
   * Dequeues the oldest item, waiting while the queue is empty. Returns
   * `{ done: true }` once the queue is closed AND drained. Rejects with
   * `JOB_CANCELLED` when `options.signal` aborts, and with the failure
   * error after `fail()` (buffered items are NOT delivered after a failure —
   * the pipeline is broken and must not continue on stale work).
   */
  public async pull(options?: PortCallOptions): Promise<QueuePullResult<T>> {
    while (true) {
      if (this.failure !== null) {
        throw this.failure.error;
      }
      throwIfAborted(options?.signal, "bounded_queue_pull");
      const slot = this.slots.shift();
      if (slot !== undefined) {
        this.bytes -= slot.size;
        this.assertByteCounterIntact("pull");
        this.notify();
        return { done: false, value: slot.item };
      }
      if (this.closed) {
        return { done: true };
      }
      await this.waitForChange(options?.signal);
    }
  }

  /** Non-blocking pull: `null` when nothing is buffered right now. */
  public tryPull(): QueuePullResult<T> | null {
    if (this.failure !== null) {
      throw this.failure.error;
    }
    const slot = this.slots.shift();
    if (slot !== undefined) {
      this.bytes -= slot.size;
      this.assertByteCounterIntact("tryPull");
      this.notify();
      return { done: false, value: slot.item };
    }
    if (this.closed) {
      return { done: true };
    }
    return null;
  }

  /** No more pushes; pulls drain the remaining items, then report done. */
  public close(): void {
    this.closed = true;
    this.notify();
  }

  /**
   * Poisons the queue: every pending and future `push`/`pull` rejects with
   * `error`. Used to unblock sibling pipeline workers when one stage fails.
   */
  public fail(error: unknown): void {
    if (this.failure === null) {
      this.failure = { error };
    }
    this.closed = true;
    this.notify();
  }

  public stats(): QueueStatsV1 {
    return {
      depth: this.slots.length,
      capacity: this.capacity,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      maxDepthObserved: this.maxDepthObserved,
      maxBytesObserved: this.maxBytesObserved,
      overBudgetAdmissions: this.overBudgetAdmissions,
      overBudgetAllowance: this.overBudgetAllowance,
      maxItemBytesObserved: this.maxItemBytesObserved,
    };
  }
}
