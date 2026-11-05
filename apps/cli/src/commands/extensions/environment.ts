/**
 * Ports and locations the extension commands run against.
 *
 * Everything the commands touch arrives here as data or as a port: the file
 * system, the clock, randomness, the search roots, the user data directory
 * and — the load-bearing one — the PROJECT roots.
 *
 * ## Why project roots exist at all
 *
 * A manifest describes how to start a program. If Untangle read manifests
 * from the working directory, `git clone` of a stranger's repository would be
 * enough to put a tool definition in front of the runtime, and one
 * `untangle extensions run` away from executing it. So project directories
 * are a boundary, not a search path: `discoverExtensions` never scans them,
 * and `loadExtensionFrom` refuses a path inside one unless the user types
 * `--allow-project-local` in that very invocation.
 *
 * The same reasoning puts license acknowledgments in the user data directory
 * (extensions.md §9.2): a `.untangle/` file can be committed, and a committed
 * acknowledgment would inherit one person's declaration to a whole team.
 */
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { Clock, FileSystemPort, Random } from "@untangle-code/domain";
import {
  isInsideDirectory,
  resolveExtensionRoots,
  userDataDirectory,
  type ExtensionPathEnvironmentV1,
} from "@untangle-code/extension-runtime";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import { systemClock, systemRandom } from "../../cli/system.js";

export interface ExtensionEnvironmentV1 {
  fs: FileSystemPort;
  clock: Clock;
  random: Random;
  /** Directory the user invoked the CLI from, canonicalized where possible. */
  cwd: string;
  /** Search roots for user-installed extensions; `roots[0]` is the install target. */
  roots: string[];
  /** OS-specific user data directory (holds the acknowledgment file). */
  userDataDir: string;
  /** Directories that MUST NOT be scanned for manifests. */
  projectRoots: string[];
  /** OS user name — an acknowledgment is a personal declaration. */
  userName: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface CreateExtensionEnvironmentOptions {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  fs?: FileSystemPort;
  clock?: Clock;
  random?: Random;
  homeDir?: string;
  platform?: string;
  userName?: string;
}

export async function createExtensionEnvironment(
  options: CreateExtensionEnvironmentOptions,
): Promise<ExtensionEnvironmentV1> {
  const fs = options.fs ?? new NodeFileSystem();
  const cwd = await canonicalize(fs, resolve(options.cwd));
  const platform = options.platform ?? process.platform;
  const pathEnvironment: ExtensionPathEnvironmentV1 = {
    homeDir: options.homeDir ?? homeDirFrom(options.env, platform),
    platform,
    env: options.env,
  };
  return {
    fs,
    clock: options.clock ?? systemClock,
    random: options.random ?? systemRandom,
    cwd,
    roots: await Promise.all(
      resolveExtensionRoots(pathEnvironment).map((root) => canonicalize(fs, root)),
    ),
    userDataDir: userDataDirectory(pathEnvironment),
    projectRoots: await discoverProjectRoots(fs, cwd, pathEnvironment.homeDir),
    userName: options.userName ?? safeUserName(),
    env: options.env,
  };
}

/**
 * Marker files that identify a directory as somebody's PROJECT rather than
 * part of the user profile. `.git` is the decisive one — the threat this
 * boundary exists for is a cloned repository — and the two Untangle markers
 * cover a project that was shipped as an archive rather than a clone.
 */
const PROJECT_MARKERS = [".git", ".untangle.json", ".untangle"] as const;

/**
 * Determines which directories must be treated as project directories.
 *
 * Walks from `start` up to the filesystem root and collects every directory
 * carrying a project marker; if at least one is found, `start` itself joins
 * the list, because the working directory inside a project is part of that
 * project.
 *
 * Two deliberate exclusions:
 *
 * - **The home directory is never a project root.** A dotfiles repository in
 *   `$HOME` is ordinary, and treating `$HOME` as a project would put
 *   `~/.untangle/extensions` inside a project directory — which would make the
 *   user's own extension root unscannable the moment they ran the CLI from
 *   their home directory. The boundary is meant to keep a stranger's
 *   repository out, not to lock people out of their own profile.
 * - **A directory with no marker anywhere above it yields no project roots at
 *   all.** Without a marker there is no project to protect, and a bare
 *   directory the user made themselves is theirs. The consequence is stated
 *   openly: `add --from ./manifest.toml` in such a directory is NOT refused.
 *   A cloned repository always carries `.git`, so the case the boundary exists
 *   for is still covered.
 */
export async function discoverProjectRoots(
  fs: FileSystemPort,
  start: string,
  homeDir?: string,
): Promise<string[]> {
  const home = homeDir === undefined ? undefined : resolve(homeDir);
  const found: string[] = [];
  let current = start;
  for (;;) {
    if (current !== home && (await hasProjectMarker(fs, current))) {
      found.push(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (found.length === 0) {
    return [];
  }
  return found.includes(start) ? found : [start, ...found];
}

async function hasProjectMarker(fs: FileSystemPort, directory: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    if ((await fs.stat(join(directory, marker))) !== null) {
      return true;
    }
  }
  return false;
}

/** True when `candidate` lies inside any of `roots`. */
export function isInsideAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInsideDirectory(candidate, root));
}

/** Resolves a user-supplied path against the working directory. */
export function resolveUserPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Canonical form of a path, with symlinks resolved.
 *
 * This is not cosmetic. `isProjectLocalManifest` and `isInsideDirectory`
 * compare LEXICALLY and say so: they never resolve symlinks, and the caller is
 * expected to hand them canonical paths. Skipping this step would leave the
 * project boundary trivially escapable — a symlink, or on macOS merely the
 * `/var` → `/private/var` alias, is enough to make a path inside a project
 * compare as if it were outside one.
 *
 * A path that does not exist yet still gets canonicalized as far as it does
 * exist: the deepest existing ancestor is resolved and the remaining segments
 * are re-appended. Failing the whole command over a not-yet-created file would
 * be worse than a partially canonical answer, and the ancestor is the part
 * that decides containment.
 */
export async function canonicalize(fs: FileSystemPort, path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = await fs.realPath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return resolve(path);
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * The home directory as the COMMAND CONTEXT sees it.
 *
 * `os.homedir()` reads the process environment, not the environment handed to
 * this command. Preferring the context keeps the extension root, the
 * acknowledgment file and the state file inside whatever profile the caller
 * declared — which is what makes these commands testable without writing into
 * the real user profile.
 */
function homeDirFrom(env: Readonly<Record<string, string | undefined>>, platform: string): string {
  const fromEnv = platform === "win32" ? env["USERPROFILE"] : env["HOME"];
  return fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : homedir();
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
