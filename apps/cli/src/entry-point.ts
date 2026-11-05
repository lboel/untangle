/**
 * "Is this module the program, or did something import it?"
 *
 * The obvious answer — compare `import.meta.url` with
 * `pathToFileURL(process.argv[1])` — is wrong in exactly the situation this
 * package is built for. `npm install --global` does not copy the binary into
 * the global bin directory; on POSIX it creates a SYMLINK there. Node's ESM
 * loader resolves symlinks, so `import.meta.url` is the real path inside the
 * package while `argv[1]` is the symlink in `…/bin`. The two never match, the
 * guard says "imported", and the installed `untangle` prints nothing and exits
 * 0 — a tool that silently does nothing, which is the worst possible outcome
 * of a one-line installation.
 *
 * So both sides are canonicalized before they are compared. A path that
 * cannot be resolved (deleted between spawn and check, `node --eval`, a
 * platform quirk) falls back to the unresolved comparison rather than
 * throwing: failing to start over a `realpath` error would trade one silent
 * failure for a louder one.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * True when the module identified by `moduleUrl` is the entry point named by
 * `entryPath` (normally `process.argv[1]`).
 *
 * BOTH sides are canonicalized, not just `entryPath`. The module URL is
 * usually already resolved, but "usually" is not a guarantee worth betting the
 * program's existence on — and on macOS the `/var` → `/private/var` alias
 * makes the two differ even without a symlink in the picture.
 */
export function isEntryPoint(moduleUrl: string, entryPath: string | undefined): boolean {
  if (entryPath === undefined || entryPath === "") {
    return false;
  }
  if (moduleUrl === pathToFileURL(entryPath).href) {
    return true;
  }
  const canonicalModule = canonical(safeFileUrlToPath(moduleUrl));
  const canonicalEntry = canonical(entryPath);
  return (
    canonicalModule !== undefined &&
    canonicalEntry !== undefined &&
    canonicalModule === canonicalEntry
  );
}

function safeFileUrlToPath(moduleUrl: string): string | undefined {
  try {
    return fileURLToPath(moduleUrl);
  } catch {
    // Not a file: URL at all (data:, node:, an http import). Then this module
    // is certainly not a file on disk that argv[1] could name.
    return undefined;
  }
}

function canonical(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
