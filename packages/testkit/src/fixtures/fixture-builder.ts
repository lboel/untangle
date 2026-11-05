/**
 * `FixtureBuilder` — materializes multi-repo workspaces on the REAL disk
 * (spec.md §27.2: fixtures need to be real files a real `ParserRegistry`/
 * `FileSystemPort` adapter can be pointed at, not an in-memory stand-in).
 *
 * Every workspace lives under its own `mkdtemp`-allocated directory, so
 * concurrent test runs never collide, and `cleanup()` removes it entirely.
 * Always call `cleanup()` (a test's `afterEach`/`try`/`finally`) — nothing
 * removes these directories automatically otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FixtureFile } from "./types.js";

/** A materialized multi-repo workspace on disk. */
export interface FixtureWorkspace {
  /** Absolute path of the workspace root (parent of every repo directory). */
  readonly rootPath: string;
  /** Repo name → absolute path of that repo's root. */
  readonly repoPaths: Readonly<Record<string, string>>;
  /** Removes `rootPath` and everything under it. Safe to call more than once. */
  cleanup(): Promise<void>;
}

interface PendingRepo {
  name: string;
  files: FixtureFile[];
}

function assertRelative(filePath: string): void {
  if (path.isAbsolute(filePath) || filePath.split(/[/\\]/).includes("..")) {
    throw new Error(
      `FixtureBuilder: fixture file paths must be repo-relative and stay inside the repo, got "${filePath}"`,
    );
  }
}

/**
 * Fluent builder: `new FixtureBuilder().repo("frontend", files).repo("backend", files).build()`.
 */
export class FixtureBuilder {
  private readonly repos: PendingRepo[] = [];
  private prefix = "untangle-fixture-";

  /** Adds one repository (a directory directly under the workspace root) worth of files. */
  public repo(name: string, files: FixtureFile[]): this {
    if (this.repos.some((existing) => existing.name === name)) {
      throw new Error(`FixtureBuilder: repo "${name}" was already added to this builder`);
    }
    for (const file of files) {
      assertRelative(file.path);
    }
    this.repos.push({ name, files: [...files] });
    return this;
  }

  /** Adds every file directly at the workspace root (no repo subdirectory) — for a single-repo fixture. */
  public rootFiles(files: FixtureFile[]): this {
    return this.repo(".", files);
  }

  /** Overrides the `mkdtemp` directory-name prefix (default `"untangle-fixture-"`). */
  public withTempPrefix(prefix: string): this {
    this.prefix = prefix;
    return this;
  }

  /** Materializes every added repo's files under a fresh temp directory. */
  public async build(): Promise<FixtureWorkspace> {
    const rootPath = await mkdtemp(path.join(tmpdir(), this.prefix));
    const repoPaths: Record<string, string> = {};
    try {
      for (const repo of this.repos) {
        const repoRoot = repo.name === "." ? rootPath : path.join(rootPath, repo.name);
        await mkdir(repoRoot, { recursive: true });
        for (const file of repo.files) {
          const absolutePath = path.join(repoRoot, file.path);
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, file.content, "utf8");
        }
        repoPaths[repo.name] = repoRoot;
      }
    } catch (error) {
      // Never leave a half-written workspace behind on a failed build.
      await rm(rootPath, { recursive: true, force: true });
      throw error;
    }

    let cleaned = false;
    return {
      rootPath,
      repoPaths,
      cleanup: async () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        await rm(rootPath, { recursive: true, force: true });
      },
    };
  }
}
