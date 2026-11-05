import { describe, expect, it } from "vitest";

import { memoryFileSystem, readFixture } from "../test-support/fixtures.js";

import { discoverExtensions, loadExtensionFrom, loadExtensionManifestFile } from "./load.js";

const VALID = readFixture("manifests/valid-sarif.manifest.toml");
const RESTRICTED = readFixture("manifests/restricted.manifest.toml");
const MOVING_TAG = readFixture("manifests/moving-tag.manifest.toml");

const ROOT = "/home/dev/.untangle/extensions";

describe("discoverExtensions", () => {
  it("findet Manifeste unterhalb der Nutzerwurzel", async () => {
    const fs = memoryFileSystem({
      [`${ROOT}/example-sast/manifest.toml`]: VALID,
      [`${ROOT}/restricted-tool/manifest.toml`]: RESTRICTED,
    });
    const result = await discoverExtensions(fs, { roots: [ROOT] });

    expect(result.extensions.map((entry) => entry.manifest.id)).toEqual([
      "example-sast",
      "restricted-tool",
    ]);
    expect(result.extensions[0]?.origin).toBe("user-data-dir");
    expect(result.extensions[0]?.manifestPath).toBe(`${ROOT}/example-sast/manifest.toml`);
    expect(result.rejected).toEqual([]);
  });

  it("sortiert deterministisch nach Codepoints", async () => {
    const fs = memoryFileSystem({
      [`${ROOT}/restricted-tool/manifest.toml`]: RESTRICTED,
      [`${ROOT}/example-sast/manifest.toml`]: VALID,
    });
    const result = await discoverExtensions(fs, { roots: [ROOT] });
    expect(result.extensions.map((entry) => entry.manifest.id)).toEqual([
      "example-sast",
      "restricted-tool",
    ]);
  });

  it("meldet eine fehlende Wurzel als nicht vorhanden statt als Fehler (X2)", async () => {
    const fs = memoryFileSystem({});
    const result = await discoverExtensions(fs, { roots: [ROOT] });
    expect(result.extensions).toEqual([]);
    expect(result.rootsScanned).toEqual([{ root: ROOT, exists: false }]);
  });

  it("lehnt ein ungueltiges Manifest MIT Begruendung ab (E4)", async () => {
    const fs = memoryFileSystem({ [`${ROOT}/moving-tag/manifest.toml`]: MOVING_TAG });
    const result = await discoverExtensions(fs, { roots: [ROOT] });

    expect(result.extensions).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.directoryName).toBe("moving-tag");
    expect(result.rejected[0]?.issues.length).toBeGreaterThan(0);
  });

  it("verlangt, dass Verzeichnisname und Manifest-ID uebereinstimmen", async () => {
    const fs = memoryFileSystem({ [`${ROOT}/other-name/manifest.toml`]: VALID });
    const result = await discoverExtensions(fs, { roots: [ROOT] });
    expect(result.extensions).toEqual([]);
    expect(result.rejected[0]?.issues[0]?.field).toBe("id");
  });

  it("meldet ein Verzeichnis ohne manifest.toml", async () => {
    const fs = memoryFileSystem({ [`${ROOT}/empty/README.md`]: "nothing here" });
    const result = await discoverExtensions(fs, { roots: [ROOT] });
    expect(result.ignored).toHaveLength(1);
    expect(result.ignored[0]?.reason).toBe("no_manifest");
  });

  it("durchsucht eine Wurzel NIE, wenn sie in einem Projekt liegt", async () => {
    // Die Sicherheitsgrenze: ein geklontes Repository darf kein Werkzeug
    // mitbringen. Selbst eine falsch gesetzte Wurzel wird abgelehnt.
    const projectRoot = "/work/some-cloned-repo";
    const fs = memoryFileSystem({
      [`${projectRoot}/.untangle/extensions/example-sast/manifest.toml`]: VALID,
    });
    const result = await discoverExtensions(fs, {
      roots: [`${projectRoot}/.untangle/extensions`],
      projectRoots: [projectRoot],
    });

    expect(result.extensions).toEqual([]);
    expect(result.ignored[0]?.reason).toBe("project_local");
    expect(result.ignored[0]?.detail).toContain("cloned repository");
  });

  it("laesst die erste Wurzel gewinnen und meldet die Dublette", async () => {
    const second = "/home/dev/.local/share/untangle/extensions";
    const fs = memoryFileSystem({
      [`${ROOT}/example-sast/manifest.toml`]: VALID,
      [`${second}/example-sast/manifest.toml`]: VALID,
    });
    const result = await discoverExtensions(fs, { roots: [ROOT, second] });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.manifestPath).toBe(`${ROOT}/example-sast/manifest.toml`);
    expect(result.ignored[0]?.reason).toBe("duplicate_id");
  });
});

describe("loadExtensionManifestFile", () => {
  it("liefert Hashes ueber Manifest und Nutzungsbeschraenkung", async () => {
    const fs = memoryFileSystem({ "/x/manifest.toml": RESTRICTED });
    const loaded = await loadExtensionManifestFile(fs, "/x/manifest.toml", "explicit-path");
    expect(loaded.extension?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.extension?.restrictionSummarySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("wirft nicht, wenn die Datei fehlt (X2)", async () => {
    const fs = memoryFileSystem({});
    const loaded = await loadExtensionManifestFile(fs, "/x/manifest.toml", "explicit-path");
    expect(loaded.extension).toBeNull();
    expect(loaded.issues[0]?.message).toContain("could not be read");
  });
});

describe("loadExtensionFrom", () => {
  it("laedt ein ausdruecklich genanntes Manifest", async () => {
    const fs = memoryFileSystem({ "/opt/ext/manifest.toml": VALID });
    const loaded = await loadExtensionFrom(fs, "/opt/ext/manifest.toml");
    expect(loaded.extension?.manifest.id).toBe("example-sast");
    expect(loaded.extension?.origin).toBe("explicit-path");
  });

  it("akzeptiert auch das Verzeichnis statt der Datei", async () => {
    const fs = memoryFileSystem({ "/opt/ext/manifest.toml": VALID });
    const loaded = await loadExtensionFrom(fs, "/opt/ext");
    expect(loaded.extension?.manifest.id).toBe("example-sast");
  });

  it("verweigert einen Projektpfad ohne ausdrueckliche Erlaubnis", async () => {
    const fs = memoryFileSystem({ "/work/repo/tools/manifest.toml": VALID });
    const loaded = await loadExtensionFrom(fs, "/work/repo/tools/manifest.toml", {
      projectRoots: ["/work/repo"],
    });
    expect(loaded.extension).toBeNull();
    expect(loaded.issues[0]?.message).toContain("never loads a project-local manifest");
  });

  it("laedt einen Projektpfad nur bei ausdruecklicher Erlaubnis", async () => {
    const fs = memoryFileSystem({ "/work/repo/tools/manifest.toml": VALID });
    const loaded = await loadExtensionFrom(fs, "/work/repo/tools/manifest.toml", {
      projectRoots: ["/work/repo"],
      allowProjectLocal: true,
    });
    expect(loaded.extension?.manifest.id).toBe("example-sast");
  });
});
