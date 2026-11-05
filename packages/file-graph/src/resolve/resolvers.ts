/**
 * Die einzelnen Schritte der Resolver-Pipeline (architecture.md §16.2).
 *
 * Jeder Resolver ist rein: gleiche Eingabe, gleiche Ausgabe, kein
 * Dateisystem, keine Uhr. Er liefert entweder ein Ergebnis (Treffer,
 * externes Ziel oder benannter Fehlschlag) oder `null` — und `null` heisst
 * genau „nicht meine Zustaendigkeit", nie „nicht gefunden". Diese
 * Unterscheidung ist der Grund, warum ein nicht aufloesbarer Import am Ende
 * einen SPRECHENDEN Grund traegt statt eines pauschalen „unresolved" (E4).
 */
import { compareCodepoints } from "@untangle-code/domain";

import { dirnameOf, isRelativeSpecifier, joinRelative, normalizePath } from "../paths.js";
import type { ImportResolverV1, ResolveContextV1, ResolveResultV1 } from "../types.js";

import { probeCandidates } from "./candidates.js";
import type { SubpathResolution } from "./package-exports.js";
import {
  resolvePackageImports,
  resolvePackageSubpath,
  splitPackageSpecifier,
} from "./package-exports.js";

/**
 * Modulnamen, die die Laufzeit selbst mitbringt. Bewusst als Liste und nicht
 * ueber `node:module`s `builtinModules`: die Liste haengt sonst von der
 * Node-Version der ANALYSIERENDEN Maschine ab, und dieselbe Codebasis haette
 * je nach Rechner eine andere Import-Resolution-Rate.
 */
export const RUNTIME_BUILTIN_MODULES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** Baut ein `unresolved`-Ergebnis mit Pflichtdetail und geprueften Kandidaten. */
function unresolved(
  reason: Extract<ResolveResultV1, { status: "unresolved" }>["reason"],
  detail: string,
  tried: readonly string[] = [],
): ResolveResultV1 {
  return {
    status: "unresolved",
    reason,
    detail,
    ...(tried.length > 0 ? { rejectedCandidates: [...tried].sort(compareCodepoints) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. Relative Pfade
// ---------------------------------------------------------------------------

export const relativePathResolver: ImportResolverV1 = {
  name: "relative-path",
  supports(specifier) {
    return isRelativeSpecifier(specifier);
  },
  resolve(specifier, context) {
    const base = joinRelative(dirnameOf(context.fromPath), specifier);
    if (base === null) {
      return unresolved(
        "target_file_not_found",
        `relative specifier "${specifier}" from "${context.fromPath}" points above the repository root`,
      );
    }
    const probe = probeCandidates(context, context.fromRepoId, base);
    if (probe.path === null) {
      return unresolved(
        "target_file_not_found",
        `no file matched relative specifier "${specifier}" from "${context.fromPath}"`,
        probe.tried,
      );
    }
    return {
      status: "resolved",
      mechanism: "relative-path",
      targetRepoId: context.fromRepoId,
      targetPath: probe.path,
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Sprachaliase: Laufzeitmodule und `#`-Subpath-Imports
// ---------------------------------------------------------------------------

export const runtimeBuiltinResolver: ImportResolverV1 = {
  name: "runtime-builtin",
  supports(specifier) {
    return (
      specifier.startsWith("node:") || RUNTIME_BUILTIN_MODULES.has(specifier.split("/")[0] ?? "")
    );
  },
  resolve(specifier) {
    return {
      status: "external",
      mechanism: "language-alias",
      packageName: specifier.startsWith("node:") ? specifier : `node:${specifier}`,
    };
  },
};

export const subpathImportResolver: ImportResolverV1 = {
  name: "subpath-import",
  supports(specifier) {
    return specifier.startsWith("#");
  },
  resolve(specifier, context) {
    const owner = context.fromPackage;
    if (owner === undefined) {
      return unresolved(
        "package_not_in_workspace_catalog",
        `subpath import "${specifier}" requires an owning package, but "${context.fromPath}" is not assigned to one`,
      );
    }
    const matched = resolvePackageImports(owner, specifier);
    return targetOrFailure(matched, context, owner.repoId, specifier, "language-alias", owner.name);
  },
};

// ---------------------------------------------------------------------------
// 3./4. Projekt-Aliase und konfigurierte Aliase
// ---------------------------------------------------------------------------

function aliasResolver(
  name: string,
  mechanism: "project-alias" | "configured-alias",
  pick: (
    context: ResolveContextV1,
  ) => readonly { pattern: string; targets: string[]; repoId: string; source: string }[],
): ImportResolverV1 {
  return {
    name,
    supports(specifier, context) {
      return pick(context).some(
        (rule) =>
          rule.repoId === context.fromRepoId && matchAlias(rule.pattern, specifier) !== null,
      );
    },
    resolve(specifier, context) {
      const tried: string[] = [];
      for (const rule of pick(context)) {
        if (rule.repoId !== context.fromRepoId) continue;
        const captured = matchAlias(rule.pattern, specifier);
        if (captured === null) continue;
        for (const target of rule.targets) {
          const base = target.includes("*") ? target.split("*").join(captured) : target;
          const probe = probeCandidates(context, context.fromRepoId, base);
          tried.push(...probe.tried);
          if (probe.path !== null) {
            return {
              status: "resolved",
              mechanism,
              targetRepoId: context.fromRepoId,
              targetPath: probe.path,
            };
          }
        }
      }
      return unresolved(
        "alias_configured_but_target_missing",
        `an alias rule matched "${specifier}" but none of its targets exists`,
        tried,
      );
    },
  };
}

export const projectAliasResolver = aliasResolver(
  "project-alias",
  "project-alias",
  (context) => context.projectAliases,
);

export const configuredAliasResolver = aliasResolver(
  "configured-alias",
  "configured-alias",
  (context) => context.configuredAliases,
);

/** `"@app/*"` gegen `"@app/util"` → `"util"`; ohne `*` exakter Vergleich. */
export function matchAlias(pattern: string, specifier: string): string | null {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) {
    return pattern === specifier ? "" : null;
  }
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
    return null;
  }
  if (specifier.length < prefix.length + suffix.length) {
    return null;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

// ---------------------------------------------------------------------------
// 5. Workspace-Paketkatalog (architecture.md §16.3)
// ---------------------------------------------------------------------------

export const workspacePackageResolver: ImportResolverV1 = {
  name: "workspace-package",
  supports(specifier, context) {
    const split = splitPackageSpecifier(specifier);
    return split !== null && context.packageCatalog.has(split.name);
  },
  resolve(specifier, context) {
    const split = splitPackageSpecifier(specifier);
    if (split === null) {
      return unresolved(
        "no_resolver_supports_specifier",
        `"${specifier}" is not a usable package specifier`,
      );
    }
    // Aus der Sicht des IMPORTIERENDEN Repositories nachschlagen: derselbe
    // Paketname kann in mehreren Repositories eines Workspace liegen, und
    // gemeint ist dann zuerst das eigene.
    const lookup = context.packageCatalog.lookup(context.fromRepoId, split.name);
    if (lookup.status === "absent") {
      return unresolved(
        "package_not_in_workspace_catalog",
        `package "${split.name}" is not part of the workspace catalog`,
      );
    }
    if (lookup.status === "ambiguous") {
      // NICHT raten. Weder zwei fremde Repositories mit demselben Paketnamen
      // noch zwei gleichnamige Manifeste im EIGENEN Repository sind ohne
      // weitere Angabe entscheidbar; eine willkuerlich gewaehlte Kante saehe
      // wie ein Erfolg aus und zeigte auf das falsche Paket.
      return unresolved(
        "ambiguous_candidates",
        `package "${split.name}" is declared by ${String(lookup.candidates.length)} manifests [${lookup.candidates
          .map((entry) => `${entry.repoId}:${entry.manifestPath}`)
          .join(
            ", ",
          )}] and none of them is the single candidate for "${context.fromPath}" in repository "${context.fromRepoId}"; the reference cannot be attributed`,
        lookup.candidates.map((entry) => entry.manifestPath).sort(compareCodepoints),
      );
    }
    const target = lookup.entry;
    const matched = resolvePackageSubpath(target, split.subpath);
    const mechanism =
      matched.status === "target" && matched.via === "exports"
        ? "package-exports"
        : "workspace-package";
    return targetOrFailure(matched, context, target.repoId, specifier, mechanism, target.name);
  },
};

// ---------------------------------------------------------------------------
// 6. Installierte Pakete (ausserhalb des Workspace)
// ---------------------------------------------------------------------------

export const installedPackageResolver: ImportResolverV1 = {
  name: "installed-package",
  supports(specifier, context) {
    const split = splitPackageSpecifier(specifier);
    if (split === null) return false;
    return declaredRange(context, split.name) !== null;
  },
  resolve(specifier, context) {
    const split = splitPackageSpecifier(specifier);
    if (split === null) {
      return unresolved(
        "no_resolver_supports_specifier",
        `"${specifier}" is not a usable package specifier`,
      );
    }
    const range = declaredRange(context, split.name);
    if (range === null) {
      return unresolved(
        "package_not_installed",
        `package "${split.name}" is declared by no manifest reachable from "${context.fromPath}"`,
      );
    }
    return {
      status: "external",
      mechanism: "installed-package",
      packageName: split.name,
      declaredVersion: range,
    };
  },
};

function declaredRange(context: ResolveContextV1, packageName: string): string | null {
  const owner = context.fromPackage;
  if (owner !== undefined) {
    const declared = owner.externalDependencies[packageName];
    if (declared !== undefined) return declared;
  }
  // Fallback auf die Wurzel des Repositories: in einem Monorepo stehen
  // Werkzeuge und geteilte Bibliotheken oft nur dort.
  for (const entry of context.packageCatalog.all()) {
    if (entry.repoId !== context.fromRepoId || entry.packageDir !== "") continue;
    const declared = entry.externalDependencies[packageName];
    if (declared !== undefined) return declared;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 7. Python-Module
// ---------------------------------------------------------------------------

/**
 * Python schreibt Importe punktiert (`from ..pkg.mod import x` → `"..pkg.mod"`).
 * Fuehrende Punkte sind relative Schritte nach oben, der Rest ist ein Pfad.
 * Ohne diesen Resolver waere in einem Python-Teilprojekt JEDER Import
 * unaufgeloest — mit ihm ist wenigstens der relative Fall exakt.
 */
export const pythonModuleResolver: ImportResolverV1 = {
  name: "python-module",
  supports(specifier, context) {
    if (context.fromLanguageId !== "python") return false;
    return specifier !== "" && !specifier.includes("/");
  },
  resolve(specifier, context) {
    const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    const rest = specifier.slice(leadingDots);
    const segments = rest === "" ? [] : rest.split(".");

    if (leadingDots > 0) {
      // Ein Punkt = das eigene Paketverzeichnis, jeder weitere eine Ebene hoeher.
      let directory: string | null = dirnameOf(context.fromPath);
      for (let step = 1; step < leadingDots; step += 1) {
        directory = directory === null ? null : joinRelative(directory, "..");
      }
      if (directory === null) {
        return unresolved(
          "target_file_not_found",
          `relative python import "${specifier}" from "${context.fromPath}" points above the repository root`,
        );
      }
      const base = segments.length === 0 ? directory : joinRelative(directory, segments.join("/"));
      if (base === null) {
        return unresolved(
          "target_file_not_found",
          `relative python import "${specifier}" from "${context.fromPath}" points above the repository root`,
        );
      }
      const probe = probeCandidates(context, context.fromRepoId, base);
      if (probe.path === null) {
        return unresolved(
          "target_file_not_found",
          `no module file matched relative python import "${specifier}" from "${context.fromPath}"`,
          probe.tried,
        );
      }
      return {
        status: "resolved",
        mechanism: "relative-path",
        targetRepoId: context.fromRepoId,
        targetPath: probe.path,
      };
    }

    // Absoluter, punktierter Modulpfad: gegen die Repositorywurzel und gegen
    // jedes Paketverzeichnis des Repositories probieren.
    const relativePath = segments.join("/");
    const roots = ["", ...packageDirsOf(context)];
    const tried: string[] = [];
    for (const root of roots) {
      const base = root === "" ? relativePath : joinRelative(root, relativePath);
      if (base === null) continue;
      const probe = probeCandidates(context, context.fromRepoId, base);
      tried.push(...probe.tried);
      if (probe.path !== null) {
        return {
          status: "resolved",
          mechanism: "language-alias",
          targetRepoId: context.fromRepoId,
          targetPath: probe.path,
        };
      }
    }
    return unresolved(
      "package_not_installed",
      `python module "${specifier}" was not found on any module root of repository "${context.fromRepoId}"; it is most likely an installed distribution`,
      tried,
    );
  },
};

function packageDirsOf(context: ResolveContextV1): string[] {
  const dirs = new Set<string>();
  for (const entry of context.packageCatalog.all()) {
    if (entry.repoId !== context.fromRepoId) continue;
    if (entry.packageDir !== "") dirs.add(entry.packageDir);
    if (entry.rootDir !== undefined) dirs.add(entry.rootDir);
  }
  return [...dirs].sort(compareCodepoints);
}

// ---------------------------------------------------------------------------
// gemeinsame Nachbereitung
// ---------------------------------------------------------------------------

function targetOrFailure(
  matched: SubpathResolution,
  context: ResolveContextV1,
  targetRepoId: string,
  specifier: string,
  mechanism: "package-exports" | "workspace-package" | "language-alias",
  viaPackageName: string,
): ResolveResultV1 {
  if (matched.status === "blocked") {
    return unresolved("excluded_by_configuration", `${matched.detail} (specifier "${specifier}")`);
  }
  if (matched.status === "no_match") {
    return unresolved("target_file_not_found", `${matched.detail} (specifier "${specifier}")`);
  }
  const probe = probeCandidates(context, targetRepoId, normalizePath(matched.target));
  if (probe.path === null) {
    return unresolved(
      "target_file_not_found",
      `package "${viaPackageName}" maps "${specifier}" to "${matched.target}", but no such file is indexed`,
      probe.tried,
    );
  }
  return {
    status: "resolved",
    mechanism,
    targetRepoId,
    targetPath: probe.path,
    viaPackageName,
  };
}
