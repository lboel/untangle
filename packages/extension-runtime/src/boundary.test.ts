/**
 * Die AGPL-Grenze als Test, nicht als Behauptung (X4, E2).
 *
 * B29 verspricht dreierlei über jede Extension: ein Lizenz-Gate, einen
 * gepinnten Digest, und dass fremder Code weder gebündelt noch gelinkt wird —
 * der Aufruf geht ausschließlich über eine Prozess- oder HTTP-Grenze. Die
 * ersten beiden sind an vielen Stellen geprüft. Das dritte war bisher eine
 * Aussage über den Quelltext, die jemand von Hand nachgesehen hat.
 *
 * Eine Namensliste wäre der naheliegende Weg und zugleich der falsche: E2
 * verbietet Produktnamen Dritter in diesem Quellbaum, eine Suche danach müsste
 * sie also selbst hineinschreiben. Was hier stattdessen geprüft wird, ist die
 * Form der Grenze — die trägt ohne einen einzigen fremden Namen:
 *
 * 1. Das Paket liefert keine Werkzeugdefinition aus. Manifeste sind
 *    Nutzerdaten; die Fixtures liegen außerhalb der `files`-Liste.
 * 2. Die Laufzeitabhängigkeiten sind ein TOML- und ein XML-Parser plus die
 *    eigene Domain. Ein Analyzer als Abhängigkeit wäre Linken, nicht Aufrufen.
 * 3. Aus dem Produktivcode führt genau ein Prozessweg (`node:child_process`)
 *    und ein Netzweg (`fetch`) hinaus, beide in je einer Datei gekapselt.
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIXTURE_ROOT } from "./test-support/fixtures.js";

const PACKAGE_ROOT = join(FIXTURE_ROOT, "..");
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");

interface PackageJsonShape {
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function packageJson(): PackageJsonShape {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as PackageJsonShape;
}

/** Every production `.ts` file below `src` — tests and test scaffolding excluded. */
function productionSources(directory: string = SOURCE_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "test-support") {
        continue;
      }
      found.push(...productionSources(path));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.includes(".test.")) {
      found.push(path);
    }
  }
  return found;
}

describe("die Extension-Grenze (X4, E2)", () => {
  it("liefert keine Werkzeugdefinition aus — Manifeste sind Nutzerdaten", () => {
    const files = packageJson().files ?? [];
    expect(files).not.toContain("fixtures");
    expect(files.some((entry) => entry.includes("manifest"))).toBe(false);
  });

  it("haelt die Laufzeitabhaengigkeiten auf Parser und die eigene Domain begrenzt", () => {
    const manifest = packageJson();
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@untangle-code/domain",
      "fast-xml-parser",
      "smol-toml",
    ]);
    // Eine Peer-Dependency waere ein Werkzeug, das der Nutzer danebenstellen
    // MUSS — also eine Bindung, die die Aggregationsargumentation aufweicht.
    expect(manifest.peerDependencies ?? {}).toEqual({});
  });

  it("kapselt den Prozessweg in genau einer Datei", () => {
    const spawning = productionSources().filter((path) =>
      readFileSync(path, "utf8").includes("node:child_process"),
    );
    expect(spawning.map((path) => path.slice(SOURCE_ROOT.length + 1))).toEqual([
      join("process", "node-runner.ts"),
    ]);
  });

  it("kennt keinen zweiten Netzweg neben dem eingespritzten fetch", () => {
    // `fetch` kommt als Port herein (`createFetchHttpRunner`); kein
    // Produktivmodul darf sich selbst eine Verbindung besorgen.
    const offenders = productionSources().filter((path) => {
      const text = readFileSync(path, "utf8");
      return text.includes("node:http") || text.includes("node:https") || text.includes("node:net");
    });
    expect(offenders).toEqual([]);
  });
});
