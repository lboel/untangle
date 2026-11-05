import { describe, expect, it } from "vitest";

import { FileIndex } from "../file-index.js";
import { WorkspacePackageCatalog } from "../package-catalog.js";
import type { ResolveContextV1, WorkspacePackageV1 } from "../types.js";

import { candidatePaths, isAssetSpecifier, reverseBuildOutput } from "./candidates.js";
import {
  resolvePackageImports,
  resolvePackageSubpath,
  splitPackageSpecifier,
} from "./package-exports.js";
import { resolveImport } from "./pipeline.js";
import { matchAlias } from "./resolvers.js";

const CORE: WorkspacePackageV1 = {
  name: "@demo/core",
  repoId: "r",
  packageDir: "packages/core",
  manifestPath: "packages/core/package.json",
  workspaceDependencies: [],
  externalDependencies: {},
  rootDir: "packages/core/src",
  outDir: "packages/core/dist",
};

function contextWith(
  files: readonly { path: string; languageId?: string }[],
  overrides: Partial<ResolveContextV1> = {},
): ResolveContextV1 {
  const index = new FileIndex();
  for (const file of files) {
    index.add({
      fileId: `id:${file.path}`,
      repoId: "r",
      refId: "r:main",
      path: file.path,
      languageId: file.languageId ?? "typescript",
      contentHash: "h",
    });
  }
  return {
    workspaceId: "w",
    fromRepoId: "r",
    fromRefId: "r:main",
    fromPath: "packages/app/src/main.ts",
    fromLanguageId: "typescript",
    files: index,
    packageCatalog: new WorkspacePackageCatalog([CORE]),
    projectAliases: [],
    configuredAliases: [],
    extensionOrder: [".ts", ".tsx", ".d.ts", ".js"],
    ...overrides,
  };
}

describe("candidatePaths", () => {
  it("probiert Erweiterungen und Indexdateien in fester Reihenfolge", () => {
    expect(candidatePaths("src/util", [".ts", ".js"])).toEqual([
      "src/util",
      "src/util.ts",
      "src/util.js",
      "src/util/index.ts",
      "src/util/index.js",
      "src/util/__init__.py",
    ]);
  });

  it("bildet die ESM-Endung auf die Quellendung zurueck", () => {
    expect(candidatePaths("src/util.js", [".ts"])[0]).toBe("src/util.ts");
  });

  it("bevorzugt in einer JavaScript-Quelle die geschriebene Endung", () => {
    expect(candidatePaths("src/util.js", [".ts"], { preferSourceExtension: false })[0]).toBe(
      "src/util.js",
    );
  });

  it("haengt an einen Namen mit unbekanntem Suffix noch Erweiterungen an", () => {
    // `./vitest.config` meint `vitest.config.ts` — `.config` ist keine Endung.
    expect(candidatePaths("vitest.config", [".ts"])).toContain("vitest.config.ts");
    // Aber `context.js` darf nie zu `context.js.ts` werden.
    expect(candidatePaths("src/context.js", [".ts"])).not.toContain("src/context.js.ts");
  });
});

describe("reverseBuildOutput", () => {
  it("bildet einen Pfad in der Build-Ausgabe auf die Quelle zurueck", () => {
    expect(reverseBuildOutput([CORE], "r", "packages/core/dist/index.js")).toBe(
      "packages/core/src/index.js",
    );
  });

  it("laesst einen Pfad ausserhalb der Build-Ausgabe unangetastet", () => {
    expect(reverseBuildOutput([CORE], "r", "packages/core/src/index.ts")).toBeNull();
  });
});

describe("splitPackageSpecifier", () => {
  it("trennt Paketname und Subpfad, auch bei Scopes", () => {
    expect(splitPackageSpecifier("react")).toEqual({ name: "react", subpath: "." });
    expect(splitPackageSpecifier("@a/b")).toEqual({ name: "@a/b", subpath: "." });
    expect(splitPackageSpecifier("@a/b/c/d")).toEqual({ name: "@a/b", subpath: "./c/d" });
  });

  it("lehnt einen unvollstaendigen Scope ab", () => {
    expect(splitPackageSpecifier("@a")).toBeNull();
  });
});

describe("resolvePackageSubpath", () => {
  it("waehlt eine Laufzeitbedingung vor types", () => {
    const entry: WorkspacePackageV1 = {
      ...CORE,
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    };
    expect(resolvePackageSubpath(entry, ".")).toEqual({
      status: "target",
      target: "packages/core/dist/index.js",
      via: "exports",
    });
  });

  it("wertet Subpfadmuster mit Platzhalter aus", () => {
    const entry: WorkspacePackageV1 = {
      ...CORE,
      exports: { "./features/*": "./dist/features/*.js" },
    };
    expect(resolvePackageSubpath(entry, "./features/alpha")).toEqual({
      status: "target",
      target: "packages/core/dist/features/alpha.js",
      via: "exports",
    });
  });

  it("meldet einen per null gesperrten Subpfad als eigenen Zustand", () => {
    const entry: WorkspacePackageV1 = { ...CORE, exports: { "./secret": null } };
    const result = resolvePackageSubpath(entry, "./secret");
    expect(result.status).toBe("blocked");
  });

  it("faellt bei fehlender exports-Karte auf module/main/types zurueck", () => {
    const entry: WorkspacePackageV1 = { ...CORE, main: "./lib/main.js" };
    expect(resolvePackageSubpath(entry, ".")).toEqual({
      status: "target",
      target: "packages/core/lib/main.js",
      via: "manifest-field",
    });
  });

  it("raet NICHT an einer vorhandenen exports-Karte vorbei", () => {
    const entry: WorkspacePackageV1 = { ...CORE, exports: { ".": "./dist/index.js" } };
    const result = resolvePackageSubpath(entry, "./internal");
    expect(result.status).toBe("no_match");
    if (result.status === "no_match") expect(result.detail).toContain("no entry matches");
  });

  it("loest einen #-Subpath-Import ueber die imports-Karte auf", () => {
    const entry: WorkspacePackageV1 = { ...CORE, imports: { "#util": "./src/util.js" } };
    expect(resolvePackageImports(entry, "#util")).toEqual({
      status: "target",
      target: "packages/core/src/util.js",
      via: "imports",
    });
  });
});

describe("matchAlias", () => {
  it("erfasst den Platzhalteranteil", () => {
    expect(matchAlias("@app/*", "@app/deep/util")).toBe("deep/util");
    expect(matchAlias("@app/core", "@app/core")).toBe("");
    expect(matchAlias("@app/*", "other")).toBeNull();
  });
});

describe("resolveImport (Pipeline)", () => {
  it("loest einen relativen Import auf und nennt den Mechanismus", () => {
    const context = contextWith([{ path: "packages/app/src/util.ts" }]);
    const outcome = resolveImport("./util.js", context);
    expect(outcome.result).toEqual({
      status: "resolved",
      mechanism: "relative-path",
      targetRepoId: "r",
      targetPath: "packages/app/src/util.ts",
    });
    expect(outcome.attemptedResolvers).toEqual(["relative-path"]);
  });

  it("nennt bei einem unbekannten Spezifizierer, dass sich niemand zustaendig fuehlte", () => {
    const outcome = resolveImport("totally-unknown", contextWith([]));
    expect(outcome.result).toMatchObject({
      status: "unresolved",
      reason: "no_resolver_supports_specifier",
    });
    expect(outcome.attemptedResolvers).toEqual([]);
  });

  it("sammelt die Spur ALLER zustaendigen Resolver, wenn keiner trifft", () => {
    const context = contextWith([], {
      projectAliases: [
        { pattern: "@x/*", targets: ["packages/x/src/*"], repoId: "r", source: "tsconfig.json" },
      ],
    });
    const outcome = resolveImport("@x/nope", context);
    expect(outcome.attemptedResolvers).toEqual(["project-alias"]);
    expect(outcome.result).toMatchObject({
      status: "unresolved",
      reason: "alias_configured_but_target_missing",
    });
    if (outcome.result.status === "unresolved") {
      expect(outcome.result.detail).toContain("project-alias:");
      expect(outcome.result.rejectedCandidates?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("gibt nach einem erfolglosen, aber zustaendigen Resolver an den naechsten weiter", () => {
    // "@demo/core" ist sowohl Alias-Kandidat als auch Workspace-Paket: der
    // Alias trifft nicht, der Katalog schon. Wer nach dem ersten Fehlschlag
    // abbraeche, verloere die Kante.
    const context = contextWith([{ path: "packages/core/src/index.ts" }], {
      projectAliases: [
        {
          pattern: "@demo/*",
          targets: ["packages/nowhere/*"],
          repoId: "r",
          source: "tsconfig.json",
        },
      ],
      packageCatalog: new WorkspacePackageCatalog([
        { ...CORE, exports: { ".": "./dist/index.js" } },
      ]),
    });
    const outcome = resolveImport("@demo/core", context);
    expect(outcome.attemptedResolvers).toEqual(["project-alias", "workspace-package"]);
    expect(outcome.result).toMatchObject({
      status: "resolved",
      mechanism: "package-exports",
      targetPath: "packages/core/src/index.ts",
    });
  });

  it("meldet ein Laufzeitmodul als extern", () => {
    expect(resolveImport("node:path", contextWith([])).result).toEqual({
      status: "external",
      mechanism: "language-alias",
      packageName: "node:path",
    });
    expect(resolveImport("path", contextWith([])).result).toEqual({
      status: "external",
      mechanism: "language-alias",
      packageName: "node:path",
    });
  });

  it("loest einen relativen Python-Import ueber die Punktschreibweise auf", () => {
    const context = contextWith(
      [
        { path: "pkg/sub/mod.py", languageId: "python" },
        { path: "pkg/main.py", languageId: "python" },
      ],
      { fromPath: "pkg/main.py", fromLanguageId: "python", extensionOrder: [".py"] },
    );
    expect(resolveImport(".sub.mod", context).result).toEqual({
      status: "resolved",
      mechanism: "relative-path",
      targetRepoId: "r",
      targetPath: "pkg/sub/mod.py",
    });
  });

  it("meldet ein unbekanntes Python-Modul als vermutlich installierte Distribution", () => {
    const context = contextWith([{ path: "pkg/main.py", languageId: "python" }], {
      fromPath: "pkg/main.py",
      fromLanguageId: "python",
      extensionOrder: [".py"],
    });
    expect(resolveImport("numpy.linalg", context).result).toMatchObject({
      status: "unresolved",
      reason: "package_not_installed",
    });
  });

  it("faengt einen werfenden Resolver ab, statt die Kette abzubrechen", () => {
    const context = contextWith([{ path: "packages/app/src/util.ts" }]);
    const outcome = resolveImport("./util.js", context, [
      {
        name: "explodes",
        supports: () => true,
        resolve: () => {
          throw new Error("boom");
        },
      },
    ]);
    expect(outcome.result).toMatchObject({ status: "unresolved" });
    if (outcome.result.status === "unresolved") {
      expect(outcome.result.detail).toContain("boom");
    }
  });
});

describe("isAssetSpecifier", () => {
  it("erkennt Nicht-Code-Ressourcen, auch mit Anhaengsel", () => {
    expect(isAssetSpecifier("./logo.svg")).toBe(true);
    expect(isAssetSpecifier("./styles.css?inline")).toBe(true);
    expect(isAssetSpecifier("./util.ts")).toBe(false);
  });
});
