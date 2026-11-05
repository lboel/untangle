/**
 * Tests der Darstellung. Zwei Zusicherungen tragen hier die Last: ohne TTY
 * NIE ein Steuerzeichen, und die Richtung steht immer als WORT da — nicht nur
 * als Farbe, die in einer Mitschrift ohnehin verschwindet.
 */
import { describe, expect, it } from "vitest";

import type { WatchStreamEventV1 } from "./events.js";
import { formatSigned, renderJson, renderText } from "./render.js";
import { stripAnsi } from "./runtime.js";

const ESC = "\u001B";

const CHANGE: WatchStreamEventV1 = {
  kind: "change",
  sequence: 7,
  at: "2026-09-05T14:32:07.000Z",
  changeKind: "modified",
  path: "packages/demo/src/thing.ts",
  languageId: "typescript",
  contentHash: "abc",
  metrics: [
    {
      metric: "structural",
      reading: "execution_unit",
      previous: 20,
      current: 20,
      delta: 0,
      direction: "unveraendert",
    },
    {
      metric: "semantic",
      reading: "file_chunks",
      previous: 1980,
      current: 1740,
      delta: -240,
      direction: "abgebaut",
    },
    {
      metric: "cyclomatic",
      reading: "execution_unit",
      previous: 12,
      current: 9,
      delta: -3,
      direction: "abgebaut",
    },
    {
      metric: "cognitive",
      reading: "execution_unit",
      previous: 34,
      current: 21,
      delta: -13,
      direction: "abgebaut",
    },
  ],
  scopes: [
    {
      metricsScopeId: "packages/demo/src/thing.ts:scope:10:900",
      label: "Thing.compute",
      kind: "method",
      line: 88,
      metric: "cognitive",
      previous: 30,
      current: 17,
      delta: -13,
      direction: "abgebaut",
    },
  ],
  verdict: "abgebaut",
  notes: [],
  analysisMs: 12,
};

describe("renderText", () => {
  it("schreibt ohne Farbe kein einziges Steuerzeichen", () => {
    const text = renderText(CHANGE, { color: false });
    expect(text).toBe(stripAnsi(text));
    expect(text.includes(ESC)).toBe(false);
  });

  it("nennt Vorher, Nachher, Delta UND Richtung im Klartext", () => {
    const text = renderText(CHANGE, { color: false });
    expect(text).toContain("cognitive");
    expect(text).toContain("34 ->");
    expect(text).toContain("21");
    expect(text).toContain("(-13, reduced)");
    expect(text).toContain("Complexity reduced");
  });

  it("benennt die Beitragsstelle mit Name, Art und Zeile", () => {
    const text = renderText(CHANGE, { color: false });
    expect(text).toContain("Thing.compute");
    expect(text).toContain("[method]");
    expect(text).toContain("line 88");
  });

  it("faerbt nur mit color:true, und dann gruen fuer abgebaut", () => {
    const colored = renderText(CHANGE, { color: true });
    expect(colored).toContain(`${ESC}[32m`);
    expect(stripAnsi(colored)).toBe(renderText(CHANGE, { color: false }));
  });

  it("zeigt eine nicht analysierbare Datei mit Grund und Detailtext (E4)", () => {
    const event: WatchStreamEventV1 = {
      kind: "unanalyzed",
      sequence: 3,
      at: "2026-09-05T14:32:09.000Z",
      origin: "change",
      entry: {
        schemaVersion: 1,
        stage: "parse",
        subjectKind: "file",
        path: "packages/demo/src/broken.ts",
        reason: "parse_failed",
        detail: 'parseQuality="partial": 3 Fehlerknoten.',
        recoverable: true,
      },
    };
    const text = renderText(event, { color: false });
    expect(text).toContain("NOT ANALYZED");
    expect(text).toContain("parse_failed");
    expect(text).toContain("3 Fehlerknoten");
    expect(text).toContain("A later attempt may succeed.");
  });

  it("weist im Abschluss aus, ob der Ref-Lock wirklich freigegeben wurde", () => {
    const base = {
      kind: "stopped",
      sequence: 9,
      at: "2026-09-05T14:33:00.000Z",
      reason: "signal",
      signal: "SIGINT",
      changesObserved: 2,
      filesUnanalyzed: 1,
      net: { structural: 0, semantic: -240, cyclomatic: -3, cognitive: -13 },
      netDirection: "abgebaut",
      queue: { maxDepthObserved: 1, maxBytesObserved: 4096, overBudgetAdmissions: 0 },
      durationMs: 4200,
    } as const;

    expect(renderText({ ...base, lockReleased: true }, { color: false })).toContain(
      "Ref lock released",
    );
    expect(renderText({ ...base, lockReleased: false }, { color: false })).toContain(
      "Ref lock NOT released",
    );
  });
});

describe("renderJson", () => {
  it("gibt genau eine Zeile aus und verliert nichts", () => {
    const line = renderJson(CHANGE);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toStrictEqual(CHANGE);
  });
});

describe("formatSigned", () => {
  it("zeigt das Vorzeichen, und bei 0 keines", () => {
    expect(formatSigned(-13)).toBe("-13");
    expect(formatSigned(13)).toBe("+13");
    expect(formatSigned(0)).toBe("0");
  });
});
