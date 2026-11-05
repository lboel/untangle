import type {
  DirEntryV1,
  FileStatV1,
  FileSystemPort,
  PortCallOptions,
} from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { discoverFiles } from "./discovery.js";
import { hashBytes } from "./hashing.js";
import { MemoryFileSystem } from "./testing/memory-file-system.js";
import type { ScannedFileV1, ScanOptions, ScanSkipV1 } from "./types.js";

async function collect(
  options: ScanOptions,
): Promise<{ files: ScannedFileV1[]; skips: ScanSkipV1[] }> {
  const skips: ScanSkipV1[] = [];
  const files: ScannedFileV1[] = [];
  for await (const file of discoverFiles({ ...options, onSkip: (s) => skips.push(s) })) {
    files.push(file);
  }
  return { files, skips };
}

function paths(files: ScannedFileV1[]): string[] {
  return files.map((f) => f.relativePath).sort();
}

/** Delegates every call, but records and can veto `readFile`. Used to prove
 * the size gate short-circuits before a full read. */
class RecordingFileSystem implements FileSystemPort {
  public readFileCalls: string[] = [];

  public constructor(private readonly inner: FileSystemPort) {}

  public stat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    return this.inner.stat(path, options);
  }

  public lstat(path: string, options?: PortCallOptions): Promise<FileStatV1 | null> {
    return this.inner.lstat(path, options);
  }

  public readFile(path: string, options?: PortCallOptions): Promise<Uint8Array> {
    this.readFileCalls.push(path);
    return this.inner.readFile(path, options);
  }

  public readTextFile(path: string, options?: PortCallOptions): Promise<string> {
    return this.inner.readTextFile(path, options);
  }

  public readDir(path: string, options?: PortCallOptions): Promise<DirEntryV1[]> {
    return this.inner.readDir(path, options);
  }

  public realPath(path: string, options?: PortCallOptions): Promise<string> {
    return this.inner.realPath(path, options);
  }

  public writeFile(path: string, data: Uint8Array, options?: PortCallOptions): Promise<void> {
    return this.inner.writeFile(path, data, options);
  }

  public mkdir(path: string, options?: PortCallOptions & { recursive?: boolean }): Promise<void> {
    return this.inner.mkdir(path, options);
  }

  public rename(from: string, to: string, options?: PortCallOptions): Promise<void> {
    return this.inner.rename(from, to, options);
  }

  public remove(path: string, options?: PortCallOptions & { recursive?: boolean }): Promise<void> {
    return this.inner.remove(path, options);
  }
}

describe("discoverFiles — basic traversal", () => {
  it("recursively discovers regular files and normalizes relative paths", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/a.ts", "export const a = 1;\n");
    fs.addFile("/repo/src/b.ts", "export const b = 2;\n");
    fs.addFile("/repo/src/nested/c.ts", "export const c = 3;\n");

    const { files } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(paths(files)).toEqual(["a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  it("populates size, mtime hint and language for a plain file", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/index.ts", "export const a = 1;\n", 12345);

    const { files } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      relativePath: "index.ts",
      sizeBytes: "export const a = 1;\n".length,
      mtimeEpochMs: 12345,
      languageId: "typescript",
      languageDetectedBy: "extension",
      isMinified: false,
    });
  });
});

describe("discoverFiles — ignore priority (spec.md §6.2)", () => {
  it("applies default excludes (e.g. node_modules) without any config", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/index.ts", "ok");
    fs.addFile("/repo/node_modules/pkg/index.js", "vendored");

    const { files, skips } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(paths(files)).toEqual(["index.ts"]);
    expect(
      skips.some((s) => s.relativePath === "node_modules" && s.reason === "default-exclude"),
    ).toBe(true);
  });

  it("lets .gitignore exclude beyond the defaults, with negation", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/.gitignore", ["*.log", "!important.log"].join("\n"));
    fs.addFile("/repo/debug.log", "noise");
    fs.addFile("/repo/important.log", "keep me");

    const { files } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(paths(files)).toEqual([".gitignore", "important.log"]);
  });

  it("lets .untangleignore win over .gitignore", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/.gitignore", "*.log\n");
    fs.addFile("/repo/.untangleignore", "!important.log\n");
    fs.addFile("/repo/debug.log", "noise");
    fs.addFile("/repo/important.log", "keep me");

    const { files } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(paths(files)).toContain("important.log");
    expect(paths(files)).not.toContain("debug.log");
  });

  it("lets an explicit config exclude win over .gitignore and .untangleignore", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/.gitignore", "!secret.txt\n");
    fs.addFile("/repo/.untangleignore", "!secret.txt\n");
    fs.addFile("/repo/secret.txt", "top secret");
    fs.addFile("/repo/plain.txt", "fine");

    const { files } = await collect({
      fs,
      roots: ["/repo"],
      repoRoot: "/repo",
      ignore: { configExclude: ["secret.txt"] },
    });
    expect(paths(files)).toEqual([".gitignore", ".untangleignore", "plain.txt"]);
  });

  it("lets a config include override a default exclude but not .gitignore", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/dist/keep.json", "{}");
    fs.addFile("/repo/dist/drop.js", "compiled");
    fs.addFile("/repo/.gitignore", "dist/blocked.json\n");
    fs.addFile("/repo/dist/blocked.json", "{}");

    // "dist/" (directory-only) reopens the pruned directory for traversal;
    // per gitignore semantics a file inside an excluded directory cannot be
    // re-included without also re-including the directory itself.
    const { files } = await collect({
      fs,
      roots: ["/repo"],
      repoRoot: "/repo",
      ignore: { configInclude: ["dist/", "dist/keep.json", "dist/blocked.json"] },
    });
    const relPaths = paths(files);
    expect(relPaths).toContain("dist/keep.json");
    expect(relPaths).not.toContain("dist/drop.js");
    expect(relPaths).not.toContain("dist/blocked.json");
  });

  it("never yields anything under a security-tier directory (e.g. .git)", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/.git/HEAD", "ref: refs/heads/main\n");
    fs.addFile("/repo/.gitignore", "!.git/\n");
    fs.addFile("/repo/README.md", "hello");

    const { files } = await collect({
      fs,
      roots: ["/repo"],
      repoRoot: "/repo",
      ignore: { configInclude: [".git/HEAD"] },
    });
    expect(paths(files)).toEqual([".gitignore", "README.md"]);
  });
});

describe("discoverFiles — symlink safety (architecture.md §23.1)", () => {
  it("terminates on a symlink cycle instead of looping forever", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/sub/real.txt", "hello");
    fs.addSymlink("/repo/sub/back", "/repo/sub");

    const { files, skips } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(paths(files)).toEqual(["sub/real.txt"]);
    expect(skips.some((s) => s.reason === "symlink-cycle")).toBe(true);
  });

  it("rejects a symlink whose target escapes the workspace roots", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/outside/secret.txt", "do not index me");
    fs.addFile("/repo/legit.txt", "fine");
    fs.addSymlink("/repo/escape", "/outside/secret.txt");

    const { files, skips } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(paths(files)).toEqual(["legit.txt"]);
    expect(skips).toContainEqual(
      expect.objectContaining({ relativePath: "escape", reason: "symlink-escape" }),
    );
  });

  it("follows a symlinked directory that stays within the workspace roots", async () => {
    // The symlink target lives in a second workspace root, outside the
    // scanned repo root, and is reachable ONLY through the symlink — this
    // isolates "does the engine follow an in-bounds symlinked directory at
    // all" from the (separately tested) global-visited-real-paths dedup,
    // which would otherwise treat a second route to an already-visited real
    // directory as a repeat visit (see the cycle test above).
    const fs = new MemoryFileSystem();
    fs.addFile("/target/inner.ts", "export {};\n");
    fs.addSymlink("/repo/alias", "/target");

    const { files } = await collect({ fs, roots: ["/repo", "/target"], repoRoot: "/repo" });
    expect(paths(files)).toEqual(["alias/inner.ts"]);
  });
});

describe("discoverFiles — binary / minified classification", () => {
  it("skips binary files instead of yielding them", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile(
      "/repo/logo.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    fs.addFile("/repo/index.ts", "export {};\n");

    const { files, skips } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(paths(files)).toEqual(["index.ts"]);
    expect(skips).toContainEqual(
      expect.objectContaining({ relativePath: "logo.png", reason: "binary" }),
    );
  });

  it("flags a minified file as such but still yields it", async () => {
    const fs = new MemoryFileSystem();
    const minified = `(function(){${"a".repeat(600)}})();`;
    fs.addFile("/repo/bundle.min.js", minified);

    const { files } = await collect({
      fs,
      roots: ["/repo"],
      repoRoot: "/repo",
      ignore: { configInclude: ["bundle.min.js"] },
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.isMinified).toBe(true);
  });
});

describe("discoverFiles — size limit (spec.md §6.1)", () => {
  it("rejects an oversized file via stat, without ever calling readFile", async () => {
    const inner = new MemoryFileSystem();
    inner.addFile("/repo/huge.txt", "x".repeat(1000));
    inner.addFile("/repo/small.txt", "ok");
    const fs = new RecordingFileSystem(inner);

    const { files, skips } = await collect({
      fs,
      roots: ["/repo"],
      repoRoot: "/repo",
      maxFileSizeBytes: 100,
    });

    expect(paths(files)).toEqual(["small.txt"]);
    expect(skips).toContainEqual(
      expect.objectContaining({ relativePath: "huge.txt", reason: "size-limit" }),
    );
    expect(fs.readFileCalls).not.toContain("/repo/huge.txt");
    expect(fs.readFileCalls).toContain("/repo/small.txt");
  });
});

describe("discoverFiles — content hash pipeline (spec.md §12.1)", () => {
  it("produces a stable hash for identical content and different hashes for different content", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/a.ts", "identical content\n");
    fs.addFile("/repo/b.ts", "identical content\n");
    fs.addFile("/repo/c.ts", "different content\n");

    const { files } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    const byPath = new Map(files.map((f) => [f.relativePath, f]));
    expect(byPath.get("a.ts")?.contentHash).toBe(byPath.get("b.ts")?.contentHash);
    expect(byPath.get("a.ts")?.contentHash).not.toBe(byPath.get("c.ts")?.contentHash);
    expect(byPath.get("a.ts")?.contentHash).toBe(
      hashBytes(new TextEncoder().encode("identical content\n")),
    );
  });

  it("changes the hash only, not the identity, when content changes across two scans", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/a.ts", "version one\n");
    const first = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });

    fs.addFile("/repo/a.ts", "version two\n");
    const second = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });

    expect(first.files[0]?.relativePath).toBe(second.files[0]?.relativePath);
    expect(first.files[0]?.contentHash).not.toBe(second.files[0]?.contentHash);
  });
});

describe("discoverFiles — AbortSignal", () => {
  it("stops discovery when the signal is already aborted", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/a.ts", "one");
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect({ fs, roots: ["/repo"], repoRoot: "/repo", signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("stops discovery once aborted mid-stream", async () => {
    const fs = new MemoryFileSystem();
    for (let i = 0; i < 20; i += 1) {
      fs.addFile(`/repo/file${i}.ts`, `export const v${i} = ${i};\n`);
    }
    const controller = new AbortController();
    const seen: string[] = [];

    await expect(
      (async () => {
        for await (const file of discoverFiles({
          fs,
          roots: ["/repo"],
          repoRoot: "/repo",
          concurrency: 1,
          signal: controller.signal,
        })) {
          seen.push(file.relativePath);
          if (seen.length === 1) {
            controller.abort();
          }
        }
      })(),
    ).rejects.toThrow();

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThan(20);
  });
});

// WP-64 regression: `decodeSampleText` used to always decode as UTF-8
// regardless of the encoding `classifyBinarySample` detected. For UTF-16
// files that produced mojibake, which in turn fed garbage into
// `detectLanguage`'s shebang sniff for extensionless scripts, silently
// misclassifying them.
describe("discoverFiles — sample decoding follows detected encoding (WP-64)", () => {
  it("correctly classifies a BOM-less UTF-16LE extensionless shebang script via content sniffing", async () => {
    const fs = new MemoryFileSystem();
    const shebangScript = "#!/usr/bin/env python3\nprint('hello world')\n";
    // No BOM: relies on `detectUtf16WithoutBom`'s heuristic, which requires
    // >= 32 bytes — this script is well over that once encoded as UTF-16.
    const bytes = new Uint8Array(Buffer.from(shebangScript, "utf16le"));
    fs.addFile("/repo/bin/run", bytes);

    const { files } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      relativePath: "bin/run",
      languageId: "python",
      languageDetectedBy: "content",
      encoding: "utf16le",
      hasBom: false,
    });
  });

  it("correctly classifies a BOM-marked UTF-16BE extensionless shebang script via content sniffing", async () => {
    const fs = new MemoryFileSystem();
    const shebangScript = "#!/bin/bash\necho 'hello world'\n";
    const le = Buffer.from(shebangScript, "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1] as number;
      be[i + 1] = le[i] as number;
    }
    const bom = Buffer.from([0xfe, 0xff]);
    const bytes = new Uint8Array(Buffer.concat([bom, be]));
    fs.addFile("/repo/bin/run-be", bytes);

    const { files } = await collect({ fs, roots: ["/repo"], repoRoot: "/repo" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      relativePath: "bin/run-be",
      languageId: "shell",
      languageDetectedBy: "content",
      encoding: "utf16be",
      hasBom: true,
    });
  });
});
