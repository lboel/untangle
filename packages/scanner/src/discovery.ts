/**
 * Recursive discovery (spec.md §6.1; architecture.md §6.4, §23.1).
 *
 * Walks the repository tree through `FileSystemPort` only (never
 * `node:fs`), applies the ignore engine, resolves and guards symlinks, and
 * hands each surviving path to bounded-concurrency classification/hashing.
 */
import {
  classifyTextFormat,
  assertWithinWorkspace,
  isUntangleError,
  type FileStatV1,
  type FileSystemPort,
} from "@untangle-code/domain";

import { classifyBinarySample, detectMinified } from "./binary-classifier.js";
import { mapConcurrent } from "./concurrency.js";
import { createPortContentHasher } from "./hashing.js";
import type { IgnoreEngine } from "./ignore-engine.js";
import { createIgnoreEngine } from "./ignore-engine.js";
import { detectLanguage } from "./language-classifier.js";
import { portOptions } from "./port-options.js";
import type {
  ContentHasher,
  ScannedFileV1,
  ScanOptions,
  ScanSkipV1,
  TextEncodingGuess,
} from "./types.js";

interface WalkDir {
  relativePath: string;
  absolutePath: string;
}

interface FileCandidate {
  relativePath: string;
  absolutePath: string;
  /** Already-known stat (symlink targets are stat'd during resolution); avoids a redundant call. */
  stat?: FileStatV1;
}

interface WalkContext {
  fs: FileSystemPort;
  ignoreEngine: IgnoreEngine;
  roots: readonly string[];
  visitedRealDirs: Set<string>;
  gitIgnoreFileName: string;
  untangleIgnoreFileName: string;
  onSkip?: ((skip: ScanSkipV1) => void) | undefined;
  signal?: AbortSignal | undefined;
}

function skip(
  context: WalkContext,
  relativePath: string,
  reason: ScanSkipV1["reason"],
  detail?: string,
): void {
  context.onSkip?.(
    detail === undefined ? { relativePath, reason } : { relativePath, reason, detail },
  );
}

async function* walkDirectory(context: WalkContext, dir: WalkDir): AsyncGenerator<FileCandidate> {
  context.signal?.throwIfAborted();
  const entries = await context.fs.readDir(dir.absolutePath, portOptions(context.signal));

  let pushedGitignore = false;
  let pushedUntangleIgnore = false;
  for (const entry of entries) {
    if (entry.kind === "file" && entry.name === context.gitIgnoreFileName) {
      const content = await context.fs.readTextFile(entry.path, portOptions(context.signal));
      context.ignoreEngine.pushGitignoreLayer(dir.relativePath, content);
      pushedGitignore = true;
    } else if (entry.kind === "file" && entry.name === context.untangleIgnoreFileName) {
      const content = await context.fs.readTextFile(entry.path, portOptions(context.signal));
      context.ignoreEngine.pushUntangleIgnoreLayer(dir.relativePath, content);
      pushedUntangleIgnore = true;
    }
  }

  try {
    for (const entry of entries) {
      context.signal?.throwIfAborted();
      const childRelative =
        dir.relativePath === "" ? entry.name : `${dir.relativePath}/${entry.name}`;

      if (entry.kind === "directory") {
        const decision = context.ignoreEngine.decide(childRelative, true);
        if (decision.ignored) {
          skip(context, childRelative, decision.reason ?? "default-exclude");
          continue;
        }
        if (context.visitedRealDirs.has(entry.path)) {
          skip(context, childRelative, "symlink-cycle", "directory real path already visited");
          continue;
        }
        context.visitedRealDirs.add(entry.path);
        yield* walkDirectory(context, { relativePath: childRelative, absolutePath: entry.path });
        continue;
      }

      if (entry.kind === "symlink") {
        yield* handleSymlink(context, entry.path, childRelative);
        continue;
      }

      if (entry.kind === "file") {
        const decision = context.ignoreEngine.decide(childRelative, false);
        if (decision.ignored) {
          skip(context, childRelative, decision.reason ?? "default-exclude");
          continue;
        }
        yield { relativePath: childRelative, absolutePath: entry.path };
        continue;
      }

      skip(
        context,
        childRelative,
        "unreadable",
        `unsupported directory entry kind "${entry.kind}"`,
      );
    }
  } finally {
    if (pushedUntangleIgnore) {
      context.ignoreEngine.popUntangleIgnoreLayer();
    }
    if (pushedGitignore) {
      context.ignoreEngine.popGitignoreLayer();
    }
  }
}

async function* handleSymlink(
  context: WalkContext,
  entryAbsolutePath: string,
  childRelative: string,
): AsyncGenerator<FileCandidate> {
  let real: string;
  try {
    real = await context.fs.realPath(entryAbsolutePath, portOptions(context.signal));
  } catch {
    skip(context, childRelative, "unreadable", "symlink target could not be resolved");
    return;
  }

  try {
    assertWithinWorkspace(real, context.roots);
  } catch (error) {
    if (isUntangleError(error) && error.code === "PATH_OUTSIDE_WORKSPACE") {
      skip(context, childRelative, "symlink-escape", real);
      return;
    }
    throw error;
  }

  const targetStat = await context.fs.stat(real, portOptions(context.signal));
  if (targetStat === null) {
    skip(context, childRelative, "unreadable", "dangling symlink");
    return;
  }

  if (targetStat.kind === "directory") {
    const decision = context.ignoreEngine.decide(childRelative, true);
    if (decision.ignored) {
      skip(context, childRelative, decision.reason ?? "default-exclude");
      return;
    }
    if (context.visitedRealDirs.has(real)) {
      skip(context, childRelative, "symlink-cycle", real);
      return;
    }
    context.visitedRealDirs.add(real);
    yield* walkDirectory(context, { relativePath: childRelative, absolutePath: real });
    return;
  }

  if (targetStat.kind === "file") {
    const decision = context.ignoreEngine.decide(childRelative, false);
    if (decision.ignored) {
      skip(context, childRelative, decision.reason ?? "default-exclude");
      return;
    }
    yield { relativePath: childRelative, absolutePath: real, stat: targetStat };
    return;
  }

  skip(
    context,
    childRelative,
    "unreadable",
    `symlink target has unsupported kind "${targetStat.kind}"`,
  );
}

/**
 * Decodes a content sample as text using the *detected* encoding
 * (WP-64 fix, spec.md E4: silent data loss is worse than a slightly slower
 * decode). Before this fix, the sample was always decoded as UTF-8
 * regardless of `classifyBinarySample`'s detected `encoding`, which produced
 * mojibake for BOM-less UTF-16 files (their bytes are ~50% NUL under a
 * UTF-8 reading) and, worse, fed that mojibake into `detectLanguage`'s
 * shebang sniff for extensionless scripts — silently misclassifying a
 * legitimate `#!/usr/bin/env python3` UTF-16 script as unknown/no language.
 *
 * UTF-16 (LE/BE, whether BOM-confirmed or detected BOM-less by
 * `detectUtf16WithoutBom`) decodes under its own `TextDecoder` label so the
 * BOM — if present — is consumed correctly. Every other guess (`utf8`,
 * `ascii`, `unknown`) falls back to UTF-8 non-fatal decoding, which is a
 * safe superset of ASCII and the correct default per spec.md.
 */
function decodeSampleText(sample: Uint8Array, encoding: TextEncodingGuess): string {
  try {
    if (encoding === "utf16le" || encoding === "utf16be") {
      return new TextDecoder(encoding === "utf16le" ? "utf-16le" : "utf-16be", {
        fatal: false,
      }).decode(sample);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(sample);
  } catch {
    return "";
  }
}

interface ProcessConfig {
  fs: FileSystemPort;
  maxFileSizeBytes: number;
  sampleBytes: number;
  nonPrintableThreshold: number;
  hasher: ContentHasher;
  onSkip?: ((skip: ScanSkipV1) => void) | undefined;
  signal?: AbortSignal | undefined;
}

async function processCandidate(
  config: ProcessConfig,
  candidate: FileCandidate,
): Promise<ScannedFileV1 | null> {
  const stat =
    candidate.stat ?? (await config.fs.stat(candidate.absolutePath, portOptions(config.signal)));
  if (stat === null) {
    config.onSkip?.({
      relativePath: candidate.relativePath,
      reason: "unreadable",
      detail: "vanished before stat",
    });
    return null;
  }
  if (stat.sizeBytes > config.maxFileSizeBytes) {
    config.onSkip?.({ relativePath: candidate.relativePath, reason: "size-limit" });
    return null;
  }

  const bytes = await config.fs.readFile(candidate.absolutePath, portOptions(config.signal));
  const sample = bytes.subarray(0, Math.min(bytes.length, config.sampleBytes));
  const binary = classifyBinarySample(sample, {
    nonPrintableThreshold: config.nonPrintableThreshold,
  });
  if (binary.isBinary) {
    config.onSkip?.({ relativePath: candidate.relativePath, reason: "binary" });
    return null;
  }

  const sampleText = decodeSampleText(sample, binary.encoding);
  const language = detectLanguage(candidate.relativePath, sampleText);
  // Die Textklasse steht eine Zeile weiter oben schon fest und kostet nichts:
  // sie ist rein pfadbasiert. Ohne sie entschied die Einzelzeilenregel auch
  // ueber Prosa — und ob sie zuschlug, haing daran, ob die erste lange Zeile
  // zufaellig in die 8-KB-Stichprobe fiel.
  const isMinified = detectMinified(sample, undefined, classifyTextFormat(candidate.relativePath));
  const contentHash = await config.hasher.hashFile(
    candidate.absolutePath,
    stat.sizeBytes,
    portOptions(config.signal),
  );

  return {
    relativePath: candidate.relativePath,
    absolutePath: candidate.absolutePath,
    sizeBytes: stat.sizeBytes,
    mtimeEpochMs: stat.mtimeEpochMs,
    contentHash,
    languageId: language.languageId,
    languageDetectedBy: language.detectedBy,
    isMinified,
    encoding: binary.encoding,
    hasBom: binary.hasBom,
  };
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SAMPLE_BYTES = 8192;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_NON_PRINTABLE_THRESHOLD = 0.3;

/**
 * Discovers files under `options.repoRoot`, applying ignore rules and
 * symlink safety, and yields a `ScannedFileV1` for every file accepted for
 * downstream analysis. Excluded/skipped paths are reported via `onSkip`,
 * never yielded. Respects `options.signal` throughout.
 */
export async function* discoverFiles(
  options: ScanOptions,
): AsyncGenerator<ScannedFileV1, void, void> {
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const sampleBytes = options.sampleBytes ?? DEFAULT_SAMPLE_BYTES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const nonPrintableThreshold = options.nonPrintableThreshold ?? DEFAULT_NON_PRINTABLE_THRESHOLD;
  const gitIgnoreFileName = options.ignore?.gitIgnoreFileName ?? ".gitignore";
  const untangleIgnoreFileName = options.ignore?.untangleIgnoreFileName ?? ".untangleignore";

  options.signal?.throwIfAborted();
  // Step 2 (architecture.md §23.1): lexical check before any I/O.
  assertWithinWorkspace(options.repoRoot, options.roots);

  // Step 1+3: canonically resolve the roots themselves too, not just the
  // repo root and symlink targets encountered later — a root path can
  // itself contain an unresolved symlink component (e.g. macOS's
  // `/var` -> `/private/var`), and comparing a realpath-resolved candidate
  // against a *literal* root would then spuriously look like an escape.
  const resolvedRoots = await Promise.all(
    options.roots.map((root) => options.fs.realPath(root, portOptions(options.signal))),
  );
  const rootReal = await options.fs.realPath(options.repoRoot, portOptions(options.signal));
  assertWithinWorkspace(rootReal, resolvedRoots);

  const context: WalkContext = {
    fs: options.fs,
    ignoreEngine: createIgnoreEngine(options.ignore),
    roots: resolvedRoots,
    visitedRealDirs: new Set<string>([rootReal]),
    gitIgnoreFileName,
    untangleIgnoreFileName,
    onSkip: options.onSkip,
    signal: options.signal,
  };

  const candidates = walkDirectory(context, { relativePath: "", absolutePath: rootReal });

  const processConfig: ProcessConfig = {
    fs: options.fs,
    maxFileSizeBytes,
    sampleBytes,
    nonPrintableThreshold,
    hasher: options.hasher ?? createPortContentHasher(options.fs),
    onSkip: options.onSkip,
    signal: options.signal,
  };

  for await (const result of mapConcurrent(
    candidates,
    concurrency,
    (candidate) => processCandidate(processConfig, candidate),
    options.signal,
  )) {
    if (result !== null) {
      yield result;
    }
  }
}
