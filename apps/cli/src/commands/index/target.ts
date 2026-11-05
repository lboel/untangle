/**
 * Welches Repository und welcher Ref indiziert werden.
 *
 * ZWEI FAELLE, UND BEIDE MUESSEN EHRLICH SEIN:
 *
 * 1. Die Konfiguration nennt Repositories (spec.md §4.3). Dann wird genau
 *    eines davon gewaehlt — das mit `--repo` benannte, oder das einzige. Bei
 *    mehreren ohne Angabe wird NICHT geraten, sondern gefragt: ein falsch
 *    geratenes Repository indiziert stumm das falsche Projekt.
 * 2. Die Konfiguration nennt keine (der haeufigste Fall beim ersten Aufruf).
 *    Dann ist das Zielverzeichnis selbst das Repository. Das steht in der
 *    Ausgabe, damit niemand glaubt, es sei konfiguriert worden.
 *
 * DER REFNAME wird aus `.git/HEAD` gelesen, wenn es ihn gibt. Steht dort ein
 * losgeloester Commit oder gibt es kein Git, heisst der Ref
 * `"working-tree"` — ein Name, der sagt, was er ist, statt „main" zu
 * behaupten und damit zwei verschiedene Staende unter derselben Identitaet
 * abzulegen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { EffectiveUntangleConfigV1 } from "@untangle-code/config";
import { buildRefId, buildRepoId, compareCodepoints } from "@untangle-code/domain";

import { UsageError } from "../../cli/exit.js";

/** Der Ref, der gemeint ist, wenn kein Git-Zweig lesbar ist. */
export const WORKING_TREE_REF = "working-tree";

export interface ResolvedTarget {
  repoId: string;
  refId: string;
  refName: string;
  repoLabel: string;
  rootPath: string;
  /** True, wenn das Repository nicht aus der Konfiguration stammt. */
  synthesized: boolean;
  /**
   * `include`/`exclude` des gewaehlten Repositories (spec.md §4.3).
   *
   * SIE MUESSEN WEITERGEREICHT WERDEN. Werden sie es nicht, indiziert der Lauf
   * stumm mehr, als die Konfiguration erlaubt — inklusive des eigenen
   * Zustandsverzeichnisses `.untangle`, dessen Zwischenspeicherdateien sich
   * bei jedem Lauf aendern und den naechsten Lauf jedes Mal Arbeit vortaeuschen
   * lassen. Genau das ist beim ersten Bau dieses Befehls passiert.
   */
  include: readonly string[] | undefined;
  exclude: readonly string[] | undefined;
}

export function resolveTarget(input: {
  config: EffectiveUntangleConfigV1;
  cwd: string;
  rootFlag: string | undefined;
  repoFlag: string | undefined;
  refFlag: string | undefined;
  configBaseDir: string;
}): ResolvedTarget {
  const repositories = input.config.repositories ?? [];

  if (repositories.length === 0) {
    const rootPath = path.resolve(input.cwd, input.rootFlag ?? ".");
    const refName = input.refFlag ?? detectRefName(rootPath);
    const repoId = buildRepoId({ canonicalPath: rootPath });
    return {
      repoId,
      refId: buildRefId(repoId, refName),
      refName,
      repoLabel: path.basename(rootPath),
      rootPath,
      synthesized: true,
      include: undefined,
      // Ohne Konfiguration gilt wenigstens die eine Regel, die immer stimmt:
      // das eigene Zustandsverzeichnis ist kein Quelltext.
      exclude: [".untangle"],
    };
  }

  const chosen =
    input.repoFlag === undefined
      ? repositories.length === 1
        ? repositories[0]
        : undefined
      : repositories.find((repo) => repo.id === input.repoFlag);

  if (chosen === undefined) {
    const names = repositories.map((repo) => repo.id).sort(compareCodepoints);
    throw new UsageError(
      input.repoFlag === undefined
        ? `The configuration contains ${String(repositories.length)} repositories; which should be indexed?`
        : `The configuration has no repository "${input.repoFlag}".`,
      `Select one with --repo=<id>. Known IDs: ${names.join(", ")}.`,
    );
  }

  const rootPath = path.resolve(input.configBaseDir, chosen.path);
  const refName = input.refFlag ?? chosen.ref ?? detectRefName(rootPath);
  const repoId = buildRepoId({
    ...(chosen.id === "" ? {} : { explicitId: chosen.id }),
    canonicalPath: rootPath,
  });
  return {
    repoId,
    refId: buildRefId(repoId, refName),
    refName,
    repoLabel: chosen.label ?? chosen.id,
    rootPath,
    synthesized: false,
    include: chosen.include,
    exclude:
      chosen.exclude === undefined
        ? [".untangle"]
        : chosen.exclude.includes(".untangle")
          ? chosen.exclude
          : [...chosen.exclude, ".untangle"],
  };
}

/** Zweigname aus `.git/HEAD`, sonst {@link WORKING_TREE_REF}. */
export function detectRefName(rootPath: string): string {
  try {
    let gitDir = path.join(rootPath, ".git");
    try {
      const pointer = /^gitdir:\s*(.+)$/u.exec(readFileSync(gitDir, "utf8").trim());
      if (pointer?.[1] !== undefined) gitDir = path.resolve(rootPath, pointer[1]);
    } catch {
      /* A normal checkout has a .git directory. */
    }
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/u.exec(head);
    return match?.[1] ?? WORKING_TREE_REF;
  } catch {
    return WORKING_TREE_REF;
  }
}
