import { describe, expect, it } from "vitest";

import {
  EXTENSIONS_HOME_ENV,
  extensionManifestPath,
  isInsideDirectory,
  isProjectLocalManifest,
  resolveExtensionRoots,
  userDataDirectory,
} from "./paths.js";

describe("resolveExtensionRoots", () => {
  it("nimmt ~/.untangle/extensions als ersten Vorgabeort", () => {
    const roots = resolveExtensionRoots({ homeDir: "/home/dev", platform: "linux", env: {} });
    expect(roots[0]).toBe("/home/dev/.untangle/extensions");
  });

  it("ergaenzt das OS-Datenverzeichnis nach extensions.md §17", () => {
    expect(resolveExtensionRoots({ homeDir: "/home/dev", platform: "linux", env: {} })).toContain(
      "/home/dev/.local/share/untangle/extensions",
    );
    expect(resolveExtensionRoots({ homeDir: "/Users/dev", platform: "darwin", env: {} })).toContain(
      "/Users/dev/Library/Application Support/untangle/extensions",
    );
  });

  it("beachtet XDG_DATA_HOME", () => {
    const roots = resolveExtensionRoots({
      homeDir: "/home/dev",
      platform: "linux",
      env: { XDG_DATA_HOME: "/home/dev/data" },
    });
    expect(roots).toContain("/home/dev/data/untangle/extensions");
  });

  it("ersetzt alle Vorgabewurzeln durch die Umgebungsvariable", () => {
    const roots = resolveExtensionRoots({
      homeDir: "/home/dev",
      platform: "linux",
      env: { [EXTENSIONS_HOME_ENV]: "/tmp/ext" },
    });
    expect(roots).toEqual(["/tmp/ext"]);
  });

  it("liefert jede Wurzel nur einmal", () => {
    const roots = resolveExtensionRoots({
      homeDir: "/home/dev",
      platform: "linux",
      env: { XDG_DATA_HOME: "/home/dev/.untangle-data" },
    });
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("enthaelt niemals ein Projektverzeichnis", () => {
    // Die Vorgabewurzeln liegen im Nutzerprofil; ein Projektpfad kann
    // strukturell nicht darunter geraten.
    const roots = resolveExtensionRoots({ homeDir: "/home/dev", platform: "linux", env: {} });
    expect(isProjectLocalManifest(roots[0] as string, ["/work/some-repo"])).toBe(false);
  });
});

describe("userDataDirectory", () => {
  it("nutzt APPDATA unter Windows", () => {
    expect(
      userDataDirectory({
        homeDir: "C:/Users/dev",
        platform: "win32",
        env: { APPDATA: "C:/Users/dev/AppData/Roaming" },
      }),
    ).toBe("C:/Users/dev/AppData/Roaming/untangle");
  });
});

describe("isInsideDirectory", () => {
  it("erkennt einen Pfad innerhalb des Verzeichnisses", () => {
    expect(isInsideDirectory("/work/repo/.untangle/x.toml", "/work/repo")).toBe(true);
  });

  it("laesst sich nicht durch .. austricksen", () => {
    expect(isInsideDirectory("/work/repo/../other/x.toml", "/work/repo")).toBe(false);
  });

  it("erkennt einen Nachbarpfad mit gleichem Praefix nicht als innen", () => {
    expect(isInsideDirectory("/work/repository/x", "/work/repo")).toBe(false);
  });
});

describe("isProjectLocalManifest", () => {
  it("meldet ein Manifest im Projektverzeichnis", () => {
    // Die Sicherheitsgrenze: ein geklontes Repository darf kein Werkzeug
    // mitbringen, das dann Befehle ausfuehrt.
    expect(isProjectLocalManifest("/work/repo/manifest.toml", ["/work/repo"])).toBe(true);
    expect(isProjectLocalManifest("/work/repo/.untangle/manifest.toml", ["/work/repo"])).toBe(true);
  });

  it("meldet ein Manifest ausserhalb aller Projekte nicht", () => {
    expect(
      isProjectLocalManifest("/home/dev/.untangle/extensions/a/manifest.toml", ["/work/repo"]),
    ).toBe(false);
  });
});

describe("extensionManifestPath", () => {
  it("setzt sich aus Wurzel, ID und manifest.toml zusammen", () => {
    expect(extensionManifestPath("/home/dev/.untangle/extensions", "example")).toBe(
      "/home/dev/.untangle/extensions/example/manifest.toml",
    );
  });
});
