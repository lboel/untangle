/**
 * Tests der Laufzeitkanten.
 *
 * Der wichtigste Fall ist der Zustandsordner: der Waechter legt dort seinen
 * Ref-Lock ab und erneuert dessen Lease im Sekundentakt. Beobachtete er ihn
 * mit, saehe er seine eigene Lease-Erneuerung als Aenderung, gefolgt von der
 * naechsten — eine Rueckkopplung auf sich selbst.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createIgnorePredicate, CryptoRandom, stripAnsi, SystemClock } from "./runtime.js";

function makeRoot(gitignore?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "untangle-watch-test-"));
  if (gitignore !== undefined) writeFileSync(path.join(root, ".gitignore"), gitignore, "utf8");
  return root;
}

describe("createIgnorePredicate", () => {
  it("schliesst den eigenen Zustandsordner IMMER aus, auch ohne .gitignore", () => {
    const ignore = createIgnorePredicate(makeRoot());
    expect(ignore(".untangle")).toBe(true);
    expect(ignore(".untangle/locks/abc/record.json")).toBe(true);
  });

  it("schliesst die Vorgabeausschluesse aus, ohne dass jemand sie konfiguriert", () => {
    const ignore = createIgnorePredicate(makeRoot());
    expect(ignore("node_modules")).toBe(true);
    expect(ignore("dist")).toBe(true);
    expect(ignore(".git")).toBe(true);
  });

  it("beachtet die .gitignore der Baumwurzel", () => {
    const ignore = createIgnorePredicate(makeRoot("generated/\n*.snapshot\n"));
    expect(ignore("generated")).toBe(true);
    expect(ignore("packages/demo/thing.snapshot")).toBe(true);
    expect(ignore("packages/demo/thing.ts")).toBe(false);
  });

  it("laesst gewoehnlichen Quelltext durch", () => {
    const ignore = createIgnorePredicate(makeRoot());
    expect(ignore("src/index.ts")).toBe(false);
    expect(ignore("README.md")).toBe(false);
  });
});

describe("SystemClock", () => {
  it("liefert eine ISO-Zeit, die zur Epochenzeit passt", () => {
    const clock = new SystemClock();
    const iso = clock.nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Math.abs(Date.parse(iso) - clock.nowEpochMs())).toBeLessThan(2000);
  });
});

describe("CryptoRandom", () => {
  it("bleibt in den zugesagten Wertebereichen", () => {
    const random = new CryptoRandom();
    for (let index = 0; index < 200; index++) {
      const value = random.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(random.nextInt(7)).toBeLessThan(7);
    }
    expect(random.bytes(16)).toHaveLength(16);
    expect(random.uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lehnt eine unsinnige Obergrenze ab, statt still etwas zu liefern", () => {
    const random = new CryptoRandom();
    expect(() => random.nextInt(0)).toThrow(RangeError);
    expect(() => random.nextInt(-1)).toThrow(RangeError);
  });
});

describe("stripAnsi", () => {
  it("entfernt Farbcodes und laesst den Text unangetastet", () => {
    expect(stripAnsi("\u001B[32mabgebaut\u001B[0m")).toBe("abgebaut");
    expect(stripAnsi("ohne Farbe")).toBe("ohne Farbe");
  });
});
