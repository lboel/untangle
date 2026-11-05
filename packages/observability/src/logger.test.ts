import type { Clock, LogEvent } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";

class FakeClock implements Clock {
  public constructor(private epochMs: number) {}
  public nowEpochMs(): number {
    return this.epochMs;
  }
  public nowIso(): string {
    return new Date(this.epochMs).toISOString();
  }
}

function captureSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe("createLogger — level filtering", () => {
  it("drops events below the configured minimum level", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ clock: new FakeClock(0), level: "warn", sink });

    logger.info("ignored-event");
    logger.debug("ignored-debug");
    logger.warn("kept-event");
    logger.error("kept-error");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("kept-event");
    expect(JSON.parse(lines[1]!).event).toBe("kept-error");
  });

  it("defaults to level 'info', dropping debug and trace", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ clock: new FakeClock(0), sink });

    logger.trace("t");
    logger.debug("d");
    logger.info("i");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe("i");
  });

  it("respects level filtering on the raw log() method too", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ clock: new FakeClock(0), level: "error", sink });
    const event: LogEvent = {
      timestamp: "2024-01-01T00:00:00.000Z",
      level: "warn",
      component: "x",
      event: "y",
    };

    logger.log(event);

    expect(lines).toHaveLength(0);
  });
});

describe("createLogger — child context inheritance", () => {
  it("merges child bindings into every emitted event", () => {
    const { lines, sink } = captureSink();
    const root = createLogger({ clock: new FakeClock(0), sink, bindings: { component: "engine" } });
    const child = root.child({ requestId: "req-1", jobId: "job-1" });

    child.info("scanning");

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.component).toBe("engine");
    expect(parsed.requestId).toBe("req-1");
    expect(parsed.jobId).toBe("job-1");
  });

  it("promotes generationId/workspaceId/repoId/refId bindings into context", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ clock: new FakeClock(0), sink }).child({
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      generationId: "gen-1",
    });

    logger.info("indexed");

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.context).toEqual({
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      generationId: "gen-1",
    });
  });

  it("a grandchild inherits ancestor bindings and can override them", () => {
    const { lines, sink } = captureSink();
    const root = createLogger({
      clock: new FakeClock(0),
      sink,
      bindings: { requestId: "req-root" },
    });
    const child = root.child({ context: { workspaceId: "ws-1" } });
    const grandchild = child.child({ requestId: "req-override", context: { repoId: "repo-1" } });

    grandchild.info("nested");

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.requestId).toBe("req-override");
    expect(parsed.context).toEqual({ workspaceId: "ws-1", repoId: "repo-1" });
  });

  it("does not mutate the parent logger's bindings when a child is created", () => {
    const { lines, sink } = captureSink();
    const root = createLogger({
      clock: new FakeClock(0),
      sink,
      bindings: { requestId: "req-root" },
    });
    root.child({ requestId: "req-child" });

    root.info("still-root");

    expect(JSON.parse(lines[0]!).requestId).toBe("req-root");
  });
});

describe("createLogger — redaction", () => {
  it("redacts secrets nested inside the logged context by default", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ clock: new FakeClock(0), sink });

    logger.info("auth-attempt", { user: { apiKey: "sk-abcdefghijklmnopqrstuvwx", name: "a" } });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.context.user.apiKey).toBe("[REDACTED]");
    expect(parsed.context.user.name).toBe("a");
  });

  it("suppresses source-text fields unless debugIncludeSourceText is set", () => {
    const { lines: suppressedLines, sink: suppressedSink } = captureSink();
    createLogger({ clock: new FakeClock(0), sink: suppressedSink }).info("chunk", {
      content: "const x = 1;",
    });
    expect(JSON.parse(suppressedLines[0]!).context.content).toBe("[SOURCE_TEXT_SUPPRESSED]");

    const { lines: revealedLines, sink: revealedSink } = captureSink();
    createLogger({
      clock: new FakeClock(0),
      sink: revealedSink,
      debugIncludeSourceText: true,
    }).info("chunk", {
      content: "const x = 1;",
    });
    expect(JSON.parse(revealedLines[0]!).context.content).toBe("const x = 1;");
  });

  it("omits an empty context entirely rather than logging {}", () => {
    const { lines, sink } = captureSink();
    createLogger({ clock: new FakeClock(0), sink }).info("no-context-event");
    expect(Object.hasOwn(JSON.parse(lines[0]!), "context")).toBe(false);
  });
});

describe("createLogger — timestamps via convenience methods", () => {
  it("stamps convenience-method events with the injected Clock, not wall time", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ clock: new FakeClock(1_700_000_000_000), sink });

    logger.error("boom");

    expect(JSON.parse(lines[0]!).timestamp).toBe(new Date(1_700_000_000_000).toISOString());
  });
});
