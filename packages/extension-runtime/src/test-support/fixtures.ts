/**
 * Testhilfen: Fixture-Zugriff, ein In-Memory-`FileSystemPort` und feste
 * Clock-/Random-Ports.
 *
 * Nicht Teil des Pakets (per `tsconfig.json` vom Build ausgeschlossen). Unit-
 * Tests laufen damit ohne Netz, ohne Container und ohne installiertes Werkzeug
 * (extensions.md §13).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Clock, DirEntryV1, FileStatV1, FileSystemPort, Random } from "@untangle-code/domain";

/** Wurzel des Fixture-Verzeichnisses dieses Pakets. */
export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");

/** Liest eine Fixture-Datei als UTF-8-Text. */
export function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURE_ROOT, relativePath), "utf8");
}

/** Feste Uhr; die Laufzeit darf `Date.now()` nicht benutzen. */
export function fixedClock(startMs = 1_767_225_600_000, stepMs = 0): Clock {
  let current = startMs;
  return {
    nowEpochMs(): number {
      const value = current;
      current += stepMs;
      return value;
    },
    nowIso(): string {
      return new Date(current).toISOString();
    },
  };
}

/** Abzaehlbarer Zufall; erzeugt reproduzierbare Lauf-Nonces. */
export function countingRandom(prefix = "00000000-0000-4000-8000-"): Random {
  let counter = 0;
  return {
    nextFloat: () => 0.5,
    nextInt: (maxExclusive: number) => (maxExclusive === 0 ? 0 : 1 % maxExclusive),
    bytes: (length: number) => new Uint8Array(length),
    uuid(): string {
      counter += 1;
      return `${prefix}${String(counter).padStart(12, "0")}`;
    },
  };
}

/**
 * Minimaler In-Memory-`FileSystemPort`. Pfade sind Strings mit `/`; die
 * Verzeichnisstruktur wird aus den Dateipfaden abgeleitet.
 */
export function memoryFileSystem(files: Readonly<Record<string, string>>): FileSystemPort {
  const table = new Map(Object.entries(files));

  const directories = new Set<string>();
  for (const path of table.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const stat = (path: string): FileStatV1 | null => {
    const normalized = path.replace(/\/+$/, "");
    if (table.has(normalized)) {
      return {
        path: normalized,
        sizeBytes: Buffer.byteLength(table.get(normalized) ?? "", "utf8"),
        mtimeEpochMs: 0,
        kind: "file",
      };
    }
    if (directories.has(normalized)) {
      return { path: normalized, sizeBytes: 0, mtimeEpochMs: 0, kind: "directory" };
    }
    return null;
  };

  const notImplemented = (name: string): never => {
    throw new Error(`memoryFileSystem.${name} is not implemented in tests`);
  };

  return {
    stat: (path) => Promise.resolve(stat(path)),
    lstat: (path) => Promise.resolve(stat(path)),
    readFile: (path) => {
      const content = table.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(new TextEncoder().encode(content));
    },
    readTextFile: (path) => {
      const content = table.get(path);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(content);
    },
    readDir: (path) => {
      const normalized = path.replace(/\/+$/, "");
      if (!directories.has(normalized)) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      const names = new Map<string, DirEntryV1>();
      for (const candidate of [...table.keys(), ...directories]) {
        if (!candidate.startsWith(`${normalized}/`)) {
          continue;
        }
        const rest = candidate.slice(normalized.length + 1);
        const name = rest.split("/")[0] as string;
        const childPath = `${normalized}/${name}`;
        names.set(name, {
          name,
          path: childPath,
          kind: table.has(childPath) ? "file" : "directory",
        });
      }
      return Promise.resolve([...names.values()]);
    },
    realPath: (path) => Promise.resolve(path),
    writeFile: () => notImplemented("writeFile"),
    mkdir: () => notImplemented("mkdir"),
    rename: () => notImplemented("rename"),
    remove: () => notImplemented("remove"),
  };
}
