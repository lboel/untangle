import type { LogEvent } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { CollectingLogger } from "./logger.js";

function makeEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    component: "test",
    event: "test_event",
    ...overrides,
  };
}

describe("CollectingLogger", () => {
  it("collects logged events in order", () => {
    const logger = new CollectingLogger();
    logger.log(makeEvent({ event: "first" }));
    logger.log(makeEvent({ event: "second" }));
    expect(logger.events.map((e) => e.event)).toEqual(["first", "second"]);
  });

  it("clear() empties the sink", () => {
    const logger = new CollectingLogger();
    logger.log(makeEvent());
    logger.clear();
    expect(logger.events).toHaveLength(0);
  });

  it("child() bindings override the component of logged events", () => {
    const logger = new CollectingLogger();
    const child = logger.child({ component: "child-component" });
    child.log(makeEvent({ component: "ignored" }));
    expect(logger.events[0]?.component).toBe("child-component");
  });

  it("child() bindings inject requestId/jobId into events that omit them", () => {
    const logger = new CollectingLogger();
    const child = logger.child({ requestId: "req-1", jobId: "job-1" });
    child.log(makeEvent());
    expect(logger.events[0]?.requestId).toBe("req-1");
    expect(logger.events[0]?.jobId).toBe("job-1");
  });

  it("a child logger writes into the same shared sink as its parent", () => {
    const logger = new CollectingLogger();
    const child = logger.child({ component: "child" });
    child.log(makeEvent());
    expect(logger.events).toHaveLength(1);
    expect(logger.events[0]?.component).toBe("child");
  });

  it("grandchild bindings override parent bindings, and context deep-merges", () => {
    const logger = new CollectingLogger({ context: { a: 1 } });
    const child = logger.child({ component: "mid", context: { b: 2 } });
    const grandchild = child.child({ component: "leaf", context: { b: 3 } });
    grandchild.log(makeEvent());
    const event = logger.events[0];
    expect(event?.component).toBe("leaf");
    expect(event?.context).toEqual({ a: 1, b: 3 });
  });

  it("does not mutate the parent logger's own bindings when creating a child", () => {
    const logger = new CollectingLogger({ component: "parent" });
    logger.child({ component: "child" });
    logger.log(makeEvent({ component: "still-parent" }));
    expect(logger.events[0]?.component).toBe("parent");
  });
});
