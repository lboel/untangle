import { isUntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { BoundedQueue } from "./bounded-queue.js";
import { settle } from "./test-support.js";

describe("BoundedQueue", () => {
  it("delivers items in FIFO order and reports done after close", async () => {
    const queue = new BoundedQueue<number>({ capacity: 10 });
    await queue.push(1);
    await queue.push(2);
    queue.close();
    expect(await queue.pull()).toEqual({ done: false, value: 1 });
    expect(await queue.pull()).toEqual({ done: false, value: 2 });
    expect(await queue.pull()).toEqual({ done: true });
  });

  it("push WAITS while the queue is full and resumes after a pull (backpressure)", async () => {
    const queue = new BoundedQueue<number>({ capacity: 2 });
    await queue.push(1);
    await queue.push(2);
    let thirdLanded = false;
    const third = queue.push(3).then(() => {
      thirdLanded = true;
    });
    await settle();
    expect(thirdLanded).toBe(false);
    expect(queue.stats().depth).toBe(2);

    expect(await queue.pull()).toEqual({ done: false, value: 1 });
    await third;
    expect(thirdLanded).toBe(true);
    expect(queue.stats().depth).toBe(2);
  });

  it("enforces the byte budget: a push over budget waits until room exists", async () => {
    const queue = new BoundedQueue<{ bytes: number }>({
      capacity: 100,
      maxBytes: 1000,
      sizeOf: (item) => item.bytes,
    });
    await queue.push({ bytes: 600 });
    let landed = false;
    const pending = queue.push({ bytes: 600 }).then(() => {
      landed = true;
    });
    await settle();
    expect(landed).toBe(false);
    expect(queue.stats().bytes).toBe(600);

    await queue.pull();
    await pending;
    expect(queue.stats().bytes).toBe(600);
    expect(queue.stats().maxBytesObserved).toBeLessThanOrEqual(1000);
  });

  it("admits a single item larger than the whole budget only into an empty queue", async () => {
    const queue = new BoundedQueue<{ bytes: number }>({
      capacity: 100,
      maxBytes: 100,
      sizeOf: (item) => item.bytes,
    });
    await queue.push({ bytes: 5000 });
    expect(queue.stats().bytes).toBe(5000);
    let landed = false;
    void queue.push({ bytes: 1 }).then(() => {
      landed = true;
    });
    await settle();
    expect(landed).toBe(false);
    await queue.pull();
    await settle();
    expect(landed).toBe(true);
  });

  it("pull waits for a push", async () => {
    const queue = new BoundedQueue<number>({ capacity: 2 });
    const pending = queue.pull();
    await settle();
    await queue.push(42);
    expect(await pending).toEqual({ done: false, value: 42 });
  });

  it("rejects a waiting push with JOB_CANCELLED when the signal aborts", async () => {
    const queue = new BoundedQueue<number>({ capacity: 1 });
    await queue.push(1);
    const controller = new AbortController();
    const pending = queue.push(2, { signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isUntangleError(error) && error.code === "JOB_CANCELLED",
    );
  });

  it("rejects a waiting pull with JOB_CANCELLED when the signal aborts", async () => {
    const queue = new BoundedQueue<number>({ capacity: 1 });
    const controller = new AbortController();
    const pending = queue.pull({ signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isUntangleError(error) && error.code === "JOB_CANCELLED",
    );
  });

  it("fail() poisons pending and future operations with the given error", async () => {
    const queue = new BoundedQueue<number>({ capacity: 1 });
    const pendingPull = queue.pull();
    const boom = new Error("stage exploded");
    queue.fail(boom);
    await expect(pendingPull).rejects.toBe(boom);
    await expect(queue.push(1)).rejects.toBe(boom);
    await expect(queue.pull()).rejects.toBe(boom);
    expect(() => queue.tryPull()).toThrow(boom);
  });

  it("push after close throws instead of silently dropping the item", async () => {
    const queue = new BoundedQueue<number>({ capacity: 1 });
    queue.close();
    await expect(queue.push(1)).rejects.toThrow(/close/u);
  });

  it("tryPull returns null while open-and-empty and done after close", async () => {
    const queue = new BoundedQueue<number>({ capacity: 1 });
    expect(queue.tryPull()).toBeNull();
    await queue.push(7);
    expect(queue.tryPull()).toEqual({ done: false, value: 7 });
    queue.close();
    expect(queue.tryPull()).toEqual({ done: true });
  });

  it("tracks high-water marks for status output", async () => {
    const queue = new BoundedQueue<{ bytes: number }>({
      capacity: 3,
      maxBytes: 10_000,
      sizeOf: (item) => item.bytes,
    });
    await queue.push({ bytes: 100 });
    await queue.push({ bytes: 200 });
    await queue.pull();
    const stats = queue.stats();
    expect(stats.maxDepthObserved).toBe(2);
    expect(stats.maxBytesObserved).toBe(300);
    expect(stats.depth).toBe(1);
    expect(stats.bytes).toBe(200);
    expect(stats.capacity).toBe(3);
    expect(stats.maxBytes).toBe(10_000);
  });

  it("rejects invalid construction", () => {
    expect(() => new BoundedQueue<number>({ capacity: 0 })).toThrow();
    expect(() => new BoundedQueue<number>({ capacity: 1, maxBytes: 10 })).toThrow(/sizeOf/u);
  });

  // ---------------------------------------------------------------------
  // WP-79: an invalid item size (non-finite or negative) must be rejected
  // at the entry point, never silently folded into `bytes` — that silent
  // fold is exactly what let a single poisoned item disable the byte
  // budget for the rest of the queue's life (architecture.md §13.2).
  // ---------------------------------------------------------------------
  describe("WP-79 — invalid sizes never corrupt the byte budget", () => {
    it("rejects a non-finite size with a clear UntangleError instead of silently miscounting", async () => {
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 10,
        maxBytes: 1000,
        sizeOf: (item) => item.size,
      });
      await expect(queue.push({ size: NaN })).rejects.toSatisfy(
        (error: unknown) =>
          isUntangleError(error) && error.code === "INDEX_INCOMPLETE" && error.retryable === false,
      );
      // Rejected before admission: no trace of the bad item in accounting.
      expect(queue.stats().bytes).toBe(0);
      expect(queue.stats().depth).toBe(0);
    });

    it("rejects a negative size the same way", async () => {
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 10,
        maxBytes: 1000,
        sizeOf: (item) => item.size,
      });
      await expect(queue.push({ size: -1 })).rejects.toSatisfy(
        (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
      );
      expect(queue.stats().bytes).toBe(0);
    });

    it("rejects an invalid maxBytes at construction (same defect class, budget itself)", () => {
      expect(
        () => new BoundedQueue<number>({ capacity: 1, maxBytes: Infinity, sizeOf: () => 1 }),
      ).toThrow();
      expect(
        () => new BoundedQueue<number>({ capacity: 1, maxBytes: NaN, sizeOf: () => 1 }),
      ).toThrow();
      expect(
        () => new BoundedQueue<number>({ capacity: 1, maxBytes: -1, sizeOf: () => 1 }),
      ).toThrow();
    });

    it("repro 1: a single Infinity-sized item can no longer disable the budget for every item after it", async () => {
      // Original defect: pushing { size: Infinity } into an empty queue (the
      // documented "one oversized item is admitted into an empty queue"
      // path) then pulling it turned `bytes` into `NaN` (Infinity - Infinity),
      // which made every future `bytes + size > maxBytes` compare `false`,
      // permanently disabling backpressure. The item must now be rejected
      // before it is ever admitted, so no such corruption is possible.
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 1000,
        maxBytes: 1000,
        sizeOf: (item) => item.size,
      });
      await expect(queue.push({ size: Infinity })).rejects.toSatisfy(
        (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
      );
      expect(queue.stats().bytes).toBe(0);

      // The byte budget MUST still bind for ordinary items: 5 * 200B fills
      // the 1000B budget exactly; a 6th must block until room is freed.
      for (let i = 0; i < 5; i += 1) {
        await queue.push({ size: 200 });
      }
      expect(queue.stats().bytes).toBe(1000);
      let sixthLanded = false;
      const sixth = queue.push({ size: 200 }).then(() => {
        sixthLanded = true;
      });
      await settle();
      expect(sixthLanded).toBe(false);
      await queue.pull();
      await sixth;
      expect(sixthLanded).toBe(true);
    });

    it("repro 2: a single negative-sized item can no longer disable the budget for every item after it", async () => {
      // Original defect: a -50000 size (a plausible sign/underflow bug) was
      // subtracted straight into `bytes`, driving it deeply negative, so
      // `bytes + size > maxBytes` stayed false for a long run of subsequent
      // pushes — backpressure silently off for the whole run.
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 10_000,
        maxBytes: 1000,
        sizeOf: (item) => item.size,
      });
      await expect(queue.push({ size: -50_000 })).rejects.toSatisfy(
        (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
      );
      expect(queue.stats().bytes).toBe(0);

      for (let i = 0; i < 5; i += 1) {
        await queue.push({ size: 200 });
      }
      expect(queue.stats().bytes).toBe(1000);
      let landed = false;
      const pending = queue.push({ size: 200 }).then(() => {
        landed = true;
      });
      await settle();
      expect(landed).toBe(false);
      await queue.pull();
      await pending;
      expect(landed).toBe(true);
    });

    it("poisons the whole queue if the byte counter itself is ever found inconsistent (defense in depth)", async () => {
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 10,
        maxBytes: 1000,
        sizeOf: (item) => item.size,
      });
      await queue.push({ size: 100 });
      // Every entry point validates its own size, so this state should be
      // unreachable through the public API — this simulates a future bug
      // that mutates `bytes` outside the validated path (e.g. a refactor
      // slip), proving the invariant catches it instead of computing
      // forward on a counter that can no longer prove the budget.
      (queue as unknown as { bytes: number }).bytes = NaN;
      await expect(queue.pull()).rejects.toSatisfy(
        (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
      );
      // Poisoned, not just that one call — mirrors `fail()`.
      await expect(queue.push({ size: 1 })).rejects.toSatisfy(isUntangleError);
    });
  });

  // ---------------------------------------------------------------------
  // WP-116: die Byte-Grenze liess sich mit GUELTIGEN Werten abschalten.
  // `hasRoomFor()` prueft den Byte-Zweig frueher nur bei `slots.length > 0`.
  // Bei `capacity: 1` ist die Queue vor jedem Push leer, also griff die
  // Ausnahme „ein uebergrosses Element in eine leere Queue" bei JEDEM Push —
  // dauerhaft. Erreichbar ueber `IndexJobRunnerOptions.queueCapacities`.
  // ---------------------------------------------------------------------
  describe("WP-116 — the byte budget cannot be switched off by a valid capacity", () => {
    const FIFTY_MB = 50 * 1024 * 1024;

    it("repro: capacity 1 with a small maxBytes no longer waves item after item through", async () => {
      // Vor der Behebung: 20 Pushes a 50 MB gegen ein 100-Byte-Budget, kein
      // einziger blockierte, `maxBytesObserved` stieg auf 52.428.800 — ohne
      // dass irgendetwas die Verletzung meldete.
      const admissions: number[] = [];
      const queue = new BoundedQueue<{ id: number }>({
        capacity: 1,
        maxBytes: 100,
        sizeOf: () => FIFTY_MB,
        onOverBudgetAdmission: (admission) => admissions.push(admission.itemBytes),
      });

      // Das ERSTE uebergrosse Element darf passieren — sonst haengt die
      // Queue fuer immer an einem Element, das nie ins Budget passt.
      await queue.push({ id: 1 });
      expect(queue.stats().depth).toBe(1);
      expect(queue.stats().overBudgetAdmissions).toBe(1);
      expect(admissions).toEqual([FIFTY_MB]);

      // Leeren — genau der Zustand, in dem die alte Ausnahme erneut griff.
      expect(await queue.pull()).toEqual({ done: false, value: { id: 1 } });
      expect(queue.stats().depth).toBe(0);

      // Der zweite Push kommt NICHT mehr durch: die Ausnahme gilt fuer ein
      // einzelnes Element, nicht als Dauerzustand.
      await expect(queue.push({ id: 2 })).rejects.toSatisfy(
        (error: unknown) =>
          isUntangleError(error) && error.code === "INDEX_INCOMPLETE" && error.retryable === false,
      );
      expect(queue.stats().depth).toBe(0);
      expect(queue.stats().bytes).toBe(0);
      expect(queue.stats().overBudgetAdmissions).toBe(1);
      expect(admissions).toEqual([FIFTY_MB]);
    });

    it("repro: the same loop that pushed 20 x 50 MB now stops after the single allowed item", async () => {
      const queue = new BoundedQueue<{ id: number }>({
        capacity: 1,
        maxBytes: 100,
        sizeOf: () => FIFTY_MB,
      });
      let admitted = 0;
      let refused = 0;
      for (let i = 0; i < 20; i += 1) {
        try {
          await queue.push({ id: i });
          admitted += 1;
          await queue.pull();
        } catch (error) {
          expect(isUntangleError(error)).toBe(true);
          refused += 1;
        }
      }
      expect(admitted).toBe(1);
      expect(refused).toBe(19);
      // Die einzige Ueberschreitung ist gezaehlt und damit erklaerbar (E4).
      const stats = queue.stats();
      expect(stats.overBudgetAdmissions).toBe(1);
      expect(stats.maxItemBytesObserved).toBe(FIFTY_MB);
      expect(stats.maxBytesObserved).toBe(FIFTY_MB);
    });

    it("counts and reports every over-budget admission instead of hiding it (E4)", async () => {
      const seen: Array<{ itemBytes: number; maxBytes: number; ordinal: number }> = [];
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 4,
        maxBytes: 1000,
        sizeOf: (item) => item.size,
        maxOverBudgetAdmissions: 2,
        onOverBudgetAdmission: (admission) =>
          seen.push({
            itemBytes: admission.itemBytes,
            maxBytes: admission.maxBytes,
            ordinal: admission.ordinal,
          }),
      });
      await queue.push({ size: 5000 });
      await queue.pull();
      await queue.push({ size: 9000 });
      await queue.pull();
      expect(seen).toEqual([
        { itemBytes: 5000, maxBytes: 1000, ordinal: 1 },
        { itemBytes: 9000, maxBytes: 1000, ordinal: 2 },
      ]);
      // Drittes: Kontingent erschoepft.
      await expect(queue.push({ size: 5000 })).rejects.toSatisfy(isUntangleError);
      expect(queue.stats().overBudgetAdmissions).toBe(2);
      expect(queue.stats().overBudgetAllowance).toBe(2);
    });

    it("allowance 0 refuses even the first item that exceeds the whole budget", async () => {
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 10,
        maxBytes: 100,
        sizeOf: (item) => item.size,
        maxOverBudgetAdmissions: 0,
      });
      await expect(queue.push({ size: 5000 })).rejects.toSatisfy(
        (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
      );
      expect(queue.stats().depth).toBe(0);
      // Elemente innerhalb des Budgets laufen unveraendert weiter.
      await queue.push({ size: 100 });
      expect(queue.stats().bytes).toBe(100);
    });

    it("an item that FITS the budget still gets plain backpressure at capacity 1, never the exception", async () => {
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 1,
        maxBytes: 100,
        sizeOf: (item) => item.size,
      });
      await queue.push({ size: 60 });
      let landed = false;
      const pending = queue.push({ size: 60 }).then(() => {
        landed = true;
      });
      await settle();
      expect(landed).toBe(false);
      await queue.pull();
      await pending;
      expect(landed).toBe(true);
      // Kein Element hat das Budget allein gesprengt: keine Ausnahme gebucht.
      expect(queue.stats().overBudgetAdmissions).toBe(0);
    });

    it("never grants the exception while items are buffered, even for an item larger than the budget", async () => {
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 3,
        maxBytes: 100,
        sizeOf: (item) => item.size,
      });
      await queue.push({ size: 10 });
      let landed = false;
      const pending = queue.push({ size: 5000 }).then(() => {
        landed = true;
      });
      await settle();
      expect(landed).toBe(false);
      expect(queue.stats().overBudgetAdmissions).toBe(0);
      await queue.pull();
      await pending;
      expect(landed).toBe(true);
      expect(queue.stats().overBudgetAdmissions).toBe(1);
    });

    it("rejects a capacity that is not a safe integer >= 1", () => {
      expect(() => new BoundedQueue<number>({ capacity: 0 })).toThrow(/safe integer/u);
      expect(() => new BoundedQueue<number>({ capacity: -1 })).toThrow(/safe integer/u);
      expect(() => new BoundedQueue<number>({ capacity: 1.5 })).toThrow(/safe integer/u);
      expect(() => new BoundedQueue<number>({ capacity: NaN })).toThrow(/safe integer/u);
      expect(() => new BoundedQueue<number>({ capacity: Infinity })).toThrow(/safe integer/u);
      // `Number.isInteger(1e21)` ist true, `Number.isSafeInteger(1e21)` nicht:
      // eine Grenze jenseits der exakten Ganzzahlen ist keine Grenze.
      expect(() => new BoundedQueue<number>({ capacity: 1e21 })).toThrow(/safe integer/u);
    });

    it("rejects an invalid maxOverBudgetAdmissions at construction", () => {
      expect(
        () =>
          new BoundedQueue<number>({
            capacity: 1,
            maxBytes: 10,
            sizeOf: () => 1,
            maxOverBudgetAdmissions: -1,
          }),
      ).toThrow(/maxOverBudgetAdmissions/u);
      expect(
        () =>
          new BoundedQueue<number>({
            capacity: 1,
            maxBytes: 10,
            sizeOf: () => 1,
            maxOverBudgetAdmissions: 1.5,
          }),
      ).toThrow(/maxOverBudgetAdmissions/u);
    });

    it("fails closed when the byte counter is non-zero on an empty queue (the assumption the old check made silently)", async () => {
      const queue = new BoundedQueue<{ size: number }>({
        capacity: 5,
        maxBytes: 100,
        sizeOf: (item) => item.size,
      });
      // Simuliert eine kuenftige Buchhaltungsabweichung: leere Queue, aber
      // `bytes` steht nicht auf 0. Frueher hat der Byte-Zweig genau diese
      // Annahme ungeprueft benutzt und haette das Element durchgewunken.
      (queue as unknown as { bytes: number }).bytes = 5000;
      await expect(queue.push({ size: 1 })).rejects.toSatisfy(
        (error: unknown) => isUntangleError(error) && error.code === "INDEX_INCOMPLETE",
      );
      // Poisoned, wie bei jeder anderen Invariantenverletzung.
      await expect(queue.pull()).rejects.toSatisfy(isUntangleError);
    });
  });
});
