import { FakeClock } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { PathDebouncer } from "./debouncer.js";
import { FakeScheduler } from "./testing/fake-scheduler.js";

describe("PathDebouncer", () => {
  it("does not fire before the debounce window elapses", () => {
    const scheduler = new FakeScheduler(new FakeClock());
    const due: string[] = [];
    const debouncer = new PathDebouncer({ scheduler, debounceMs: 2000, onDue: (p) => due.push(p) });

    debouncer.notify("a.ts");
    scheduler.advance(1999);

    expect(due).toEqual([]);
  });

  it("fires exactly once, debounceMs after the last event (coalesces a storm on the same path)", () => {
    const scheduler = new FakeScheduler(new FakeClock());
    const due: string[] = [];
    const debouncer = new PathDebouncer({ scheduler, debounceMs: 2000, onDue: (p) => due.push(p) });

    // A burst of events on the same path, each within the quiet period of
    // the previous one — every one of them must reset the timer.
    debouncer.notify("a.ts");
    scheduler.advance(500);
    debouncer.notify("a.ts");
    scheduler.advance(500);
    debouncer.notify("a.ts");
    scheduler.advance(500);
    debouncer.notify("a.ts");

    // Only 500ms have passed since the LAST notify — must still be pending.
    scheduler.advance(1999);
    expect(due).toEqual([]);

    // One more ms crosses the 2000ms quiet period since the last notify.
    scheduler.advance(1);
    expect(due).toEqual(["a.ts"]);
  });

  it("tracks independent timers per path", () => {
    const scheduler = new FakeScheduler(new FakeClock());
    const due: string[] = [];
    const debouncer = new PathDebouncer({ scheduler, debounceMs: 2000, onDue: (p) => due.push(p) });

    debouncer.notify("a.ts");
    scheduler.advance(1000);
    debouncer.notify("b.ts");
    scheduler.advance(1000);
    // a.ts is now due (2000ms since its own notify); b.ts still has 1000ms left.
    expect(due).toEqual(["a.ts"]);

    scheduler.advance(1000);
    expect(due).toEqual(["a.ts", "b.ts"]);
  });

  it("dispose() cancels pending timers without firing onDue", () => {
    const scheduler = new FakeScheduler(new FakeClock());
    const due: string[] = [];
    const debouncer = new PathDebouncer({ scheduler, debounceMs: 2000, onDue: (p) => due.push(p) });

    debouncer.notify("a.ts");
    debouncer.dispose();
    scheduler.advance(5000);

    expect(due).toEqual([]);
    expect(debouncer.isPending("a.ts")).toBe(false);
  });
});
