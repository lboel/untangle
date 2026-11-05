import { describe, expect, it } from "vitest";

import { FileIndex } from "./file-index.js";

function entry(path: string, repoId = "r") {
  return {
    fileId: `id:${repoId}:${path}`,
    repoId,
    refId: `${repoId}:main`,
    path,
    languageId: "typescript",
    contentHash: "h",
  };
}

describe("FileIndex", () => {
  it("findet eine Datei ueber Repository und Pfad", () => {
    const index = new FileIndex();
    index.add(entry("src/a.ts"));
    expect(index.hasFile("r", "src/a.ts")).toBe(true);
    expect(index.fileIdOf("r", "src/a.ts")).toBe("id:r:src/a.ts");
    expect(index.hasFile("other", "src/a.ts")).toBe(false);
  });

  it("normalisiert den Pfad beim Einfuegen und beim Nachschlagen", () => {
    const index = new FileIndex();
    index.add(entry("./src//a.ts"));
    expect(index.hasFile("r", "src/a.ts")).toBe(true);
    expect(index.entryOf("r", "src\\a.ts")?.path).toBe("src/a.ts");
  });

  it("kann Repository und Pfad nicht verwechseln", () => {
    // Der Schluessel trennt beide Teile mit U+001F: ("ab", "c") und ("a", "bc")
    // duerfen niemals denselben Eintrag treffen.
    const index = new FileIndex();
    index.add(entry("c", "ab"));
    expect(index.hasFile("a", "bc")).toBe(false);
    expect(index.hasFile("ab", "c")).toBe(true);
  });

  it("entfernt einen Eintrag aus beiden Nachschlagerichtungen", () => {
    const index = new FileIndex();
    index.add(entry("src/a.ts"));
    expect(index.remove("id:r:src/a.ts")).toBe(true);
    expect(index.remove("id:r:src/a.ts")).toBe(false);
    expect(index.hasFile("r", "src/a.ts")).toBe(false);
    expect(index.entryById("id:r:src/a.ts")).toBeNull();
    expect(index.size).toBe(0);
  });

  it("gibt den ALTEN Pfad frei, wenn dieselbe Datei unter einem neuen ankommt", () => {
    // Regression: eine Umbenennung erreicht den Index als `add()` mit neuem
    // Pfad. Blieb der alte Schluessel stehen, meldete der Graph danach eine
    // aufgeloeste Kante auf einen Pfad, den keine Datei mehr hat — bei
    // Aufloesungsrate 1 und leerem Skip-Ledger.
    const index = new FileIndex();
    const before = entry("src/b.ts");
    index.add(before);
    index.add({ ...before, path: "src/c.ts" });

    expect(index.hasFile("r", "src/c.ts")).toBe(true);
    expect(index.hasFile("r", "src/b.ts")).toBe(false);
    expect(index.fileIdOf("r", "src/b.ts")).toBeNull();
    expect(index.entryById(before.fileId)?.path).toBe("src/c.ts");
    expect(index.size).toBe(1);

    // Und nach dem Entfernen bleibt kein Pfad zurueck.
    expect(index.remove(before.fileId)).toBe(true);
    expect(index.hasFile("r", "src/c.ts")).toBe(false);
    expect(index.hasFile("r", "src/b.ts")).toBe(false);
  });

  it("nimmt einer anderen Datei den Pfad nicht weg, die ihn inzwischen belegt", () => {
    // Gegenprobe zur Freigabe oben: `F_alt` zieht von `src/b.ts` fort,
    // `F_neu` zieht dorthin. Wird `F_alt` spaeter entfernt, darf das den
    // Eintrag von `F_neu` NICHT mitreissen — sonst entstuende ein fehlendes
    // statt eines ueberzaehligen Phantoms.
    const index = new FileIndex();
    const moving = { ...entry("src/b.ts"), fileId: "F_alt" };
    index.add(moving);
    index.add({ ...entry("src/b.ts"), fileId: "F_neu" });
    index.add({ ...moving, path: "src/c.ts" });

    expect(index.fileIdOf("r", "src/b.ts")).toBe("F_neu");
    index.remove("F_alt");
    expect(index.fileIdOf("r", "src/b.ts")).toBe("F_neu");
    expect(index.hasFile("r", "src/c.ts")).toBe(false);
  });

  it("liefert die Repository-IDs codepoint-sortiert", () => {
    const index = new FileIndex();
    index.add(entry("a.ts", "zeta"));
    index.add(entry("a.ts", "Alpha"));
    index.add(entry("a.ts", "beta"));
    // Codepoint-Ordnung, nicht Locale-Ordnung: Grossbuchstaben zuerst.
    expect(index.repoIds()).toEqual(["Alpha", "beta", "zeta"]);
  });
});
