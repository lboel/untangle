/**
 * The language census: which languages a project is written in, weighted by
 * lines (WP-125 "Gewichtung nach Zeilen").
 *
 * Discovery is `@untangle-code/scanner`'s job and is not re-implemented here:
 * `discoverFiles` already applies the security tier, the default excludes,
 * every nested `.gitignore`/`.untangleignore`, the size ceiling, the symlink
 * sandbox and the binary classifier, and it already reports a language id per
 * file. What this module adds is the one thing the scanner has no reason to
 * compute — the LINE count — plus the cross-check against
 * `@untangle-code/parser-registry`: a language that dominates the line count
 * but has no adapter is the single most useful thing `init` can tell a user,
 * because it is the difference between "Untangle understands your code" and
 * "Untangle can only search its text".
 */

import type { ParserRegistry, FileSystemPort, SkipLedgerEntryV1 } from "@untangle-code/domain";
import { buildSkipLedgerEntry, compareCodepoints } from "@untangle-code/domain";
import { discoverFiles, mapConcurrent } from "@untangle-code/scanner";
import type { ScannedFileV1, ScanSkipV1, ExclusionReason } from "@untangle-code/scanner";

import { probeLanguageSupport } from "../../cli/language-support.js";

import type {
  ExclusionCountV1,
  InitLimitsV1,
  LanguageCensusEntryV1,
  LanguageCensusV1,
} from "./types.js";

/**
 * Exclusion reasons that are the DESIGNED scope of a scan rather than a
 * surprise. They are reported as counts (`LanguageCensusV1.excluded`); the
 * rest additionally earn an individual skip-ledger entry.
 */
const ROUTINE_EXCLUSIONS: ReadonlySet<ExclusionReason> = new Set<ExclusionReason>([
  "security",
  "config-exclude",
  "untangleignore",
  "gitignore",
  "default-exclude",
  "binary",
]);

/**
 * Maps a scanner exclusion reason onto the closed `SkipReason` set of
 * `@untangle-code/domain`. The domain set has no "I/O error" member, so an
 * unreadable path is filed as `provider_unavailable` (the file system IS the
 * provider at this stage) and marked recoverable; a symlink that cycles or
 * escapes the workspace is a failed resolution.
 */
function skipReasonOf(reason: ExclusionReason): SkipLedgerEntryV1["reason"] {
  switch (reason) {
    case "size-limit":
      return "file_too_large";
    case "binary":
      return "binary_content";
    case "symlink-cycle":
    case "symlink-escape":
      return "resolution_failed";
    case "unreadable":
      return "provider_unavailable";
    default:
      return "excluded_by_configuration";
  }
}

/**
 * Counts lines the way a line-oriented tool does: the number of newline
 * characters, plus one when the last line is unterminated. Empty content has
 * zero lines. `\r\n` counts once, because the `\n` is what is counted.
 */
export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      newlines += 1;
    }
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Rounds a ratio to four decimals so the value is stable across runs. */
export function roundShare(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 10_000) / 10_000;
}

interface Accumulator {
  fileCount: number;
  lineCount: number;
  byteCount: number;
  /** Repo-relativer Pfad der ERSTEN Datei dieser Sprache — nur zur Adapterwahl. */
  samplePath: string;
}

export interface LanguageCensusInput {
  fs: FileSystemPort;
  parserRegistry: ParserRegistry;
  /** Absolute, canonical repository root. */
  repoRoot: string;
  limits: InitLimitsV1;
  /** Extra exclude globs on top of the scanner defaults. */
  additionalExcludes: readonly string[];
  /**
   * Repo-relative paths that `init` itself owns (its output file and that
   * file's temporary sibling). They are excluded from the scan AND from the
   * exclusion counts: counting them would make the second run observe a
   * project the first one did not, and idempotency would be a coin flip.
   */
  selfManagedPaths: readonly string[];
  /** Collector for the non-routine skips (E4). */
  onSkipEntry: (entry: SkipLedgerEntryV1) => void;
  /** Accepted files within the census budget, including failed second reads. */
  onDiscoveredFile?: (file: ScannedFileV1) => void;
  signal?: AbortSignal;
}

/**
 * Sorting rule of the census: most lines first, ties broken by language id
 * codepoints. Descending on a number and ascending on codepoints — never
 * `localeCompare`, so the order is the same on every machine.
 */
export function compareCensusEntries(a: LanguageCensusEntryV1, b: LanguageCensusEntryV1): number {
  if (a.lineCount !== b.lineCount) {
    return b.lineCount - a.lineCount;
  }
  return compareCodepoints(a.languageId, b.languageId);
}

export async function buildLanguageCensus(input: LanguageCensusInput): Promise<LanguageCensusV1> {
  const { fs, parserRegistry, repoRoot, limits, onSkipEntry, signal } = input;

  const byLanguage = new Map<string, Accumulator>();
  const exclusionCounts = new Map<string, number>();
  let totalFiles = 0;
  let totalLines = 0;
  let truncated = false;

  const selfManaged = new Set(input.selfManagedPaths);
  const onSkip = (skip: ScanSkipV1): void => {
    if (selfManaged.has(skip.relativePath)) {
      return;
    }
    exclusionCounts.set(skip.reason, (exclusionCounts.get(skip.reason) ?? 0) + 1);
    if (ROUTINE_EXCLUSIONS.has(skip.reason)) {
      return;
    }
    onSkipEntry(
      buildSkipLedgerEntry({
        stage: "scan",
        subjectKind: "file",
        path: skip.relativePath,
        reason: skipReasonOf(skip.reason),
        detail: skip.detail ?? `scanner reason: ${skip.reason}`,
        recoverable: skip.reason === "unreadable",
      }),
    );
  };

  const discovered = discoverFiles({
    fs,
    roots: [repoRoot],
    repoRoot,
    maxFileSizeBytes: limits.maxFileSizeBytes,
    concurrency: limits.concurrency,
    onSkip,
    ignore: {
      additionalDefaultExcludes: [...input.additionalExcludes, ...input.selfManagedPaths],
    },
    ...(signal === undefined ? {} : { signal }),
  });

  /**
   * The scanner has already read every accepted file once (to hash it), but
   * `FileSystemPort` exposes no way to hand that buffer on, so the line count
   * costs a second read. Bounded parallelism keeps that from turning a large
   * repository into a serial walk; a file that cannot be re-read lands in the
   * ledger instead of quietly counting as zero lines.
   */
  const counted = mapConcurrent(
    limitFiles(discovered, limits.maxFilesScanned, () => {
      truncated = true;
    }),
    limits.concurrency,
    async (file: ScannedFileV1): Promise<{ file: ScannedFileV1; lines: number | null }> => {
      try {
        const text = await fs.readTextFile(
          file.absolutePath,
          signal === undefined ? {} : { signal },
        );
        return { file, lines: countLines(text) };
      } catch {
        return { file, lines: null };
      }
    },
    signal,
  );

  for await (const { file, lines } of counted) {
    input.onDiscoveredFile?.(file);
    if (lines === null) {
      onSkipEntry(
        buildSkipLedgerEntry({
          stage: "scan",
          subjectKind: "file",
          path: file.relativePath,
          reason: "provider_unavailable",
          detail: "The file was discovered but became unreadable before line counting.",
          recoverable: true,
        }),
      );
      continue;
    }
    totalFiles += 1;
    totalLines += lines;
    const accumulator = byLanguage.get(file.languageId) ?? {
      fileCount: 0,
      lineCount: 0,
      byteCount: 0,
      // WP-240: EIN Pfad je Sprache, damit die Adapterfrage auch fuer die
      // Sprachen beantwortbar bleibt, deren Scanner-ID keine Adapter-ID ist.
      // Der Scanner meldet "yaml", "json" und "toml"; die Registry fuehrt sie
      // alle drei als "structured-text". `getAdapterByLanguage("yaml")` gab
      // deshalb null zurueck, und `init` meldete "kein Parser — nur
      // Textsuche" ueber ein Format, das sehr wohl einen Adapter hat.
      samplePath: file.relativePath,
    };
    accumulator.fileCount += 1;
    accumulator.lineCount += lines;
    accumulator.byteCount += file.sizeBytes;
    byLanguage.set(file.languageId, accumulator);
  }

  if (truncated) {
    onSkipEntry(
      buildSkipLedgerEntry({
        stage: "scan",
        subjectKind: "file",
        reason: "excluded_by_configuration",
        detail: `Language counting stopped after ${String(limits.maxFilesScanned)} files (maxFilesScanned); proportions describe only those files.`,
        recoverable: true,
      }),
    );
  }

  const entries: LanguageCensusEntryV1[] = [];
  let parsedLines = 0;
  for (const [languageId, accumulator] of byLanguage) {
    const adapter =
      parserRegistry.getAdapterByLanguage(languageId) ??
      parserRegistry.getAdapterForPath(accumulator.samplePath);
    if (adapter !== null) {
      parsedLines += accumulator.lineCount;
    }
    // WP-240: NICHT `adapter.supportLevel`. Das ist die Konstante aus der
    // Sprachtabelle und sagt nichts darueber, ob die Grammatik auf dieser
    // Maschine geladen werden kann. `probeLanguageSupport` misst es (die
    // Begruendung steht in `cli/language-support.ts`) — und eine Sprache
    // ohne Grammatik erscheint hier mit Stufe "text" und einem Grund, statt
    // mit einem "deep", das der erste Indexlauf widerlegt.
    const support =
      adapter === null ? null : probeLanguageSupport(parserRegistry, adapter.languageId);
    entries.push({
      languageId,
      fileCount: accumulator.fileCount,
      lineCount: accumulator.lineCount,
      byteCount: accumulator.byteCount,
      lineShare: roundShare(totalLines === 0 ? 0 : accumulator.lineCount / totalLines),
      hasParserAdapter: adapter !== null,
      ...(support === null
        ? {}
        : {
            supportLevel: support.effectiveSupportLevel,
            ...(support.available
              ? {}
              : {
                  declaredSupportLevel: support.declaredSupportLevel,
                  grammarUnavailableReason: support.reason ?? "no details",
                }),
          }),
    });
  }
  entries.sort(compareCensusEntries);

  const excluded: ExclusionCountV1[] = [...exclusionCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => compareCodepoints(a.reason, b.reason));

  return {
    entries,
    totalFiles,
    totalLines,
    parsedLineShare: roundShare(totalLines === 0 ? 0 : parsedLines / totalLines),
    truncated,
    excluded,
  };
}

/** Yields at most `max` items, invoking `onTruncate` the first time it stops early. */
async function* limitFiles(
  source: AsyncIterable<ScannedFileV1>,
  max: number,
  onTruncate: () => void,
): AsyncGenerator<ScannedFileV1, void, void> {
  let seen = 0;
  for await (const item of source) {
    if (seen >= max) {
      onTruncate();
      return;
    }
    seen += 1;
    yield item;
  }
}
