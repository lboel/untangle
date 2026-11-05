/**
 * Ignore rules: `.gitignore` plus sensible defaults.
 *
 * The scanner evaluates `.gitignore` and `.untangleignore` itself, at every
 * directory level, every time it runs (spec.md §6.2). So this module does NOT
 * copy those rules into the configuration — a duplicated rule set is a rule
 * set that drifts. What it does instead is two things the scanner cannot do
 * for the user:
 *
 * 1. It writes the built-in default excludes into the file EXPLICITLY. They
 *    are the rules most likely to be wrong for a given project (a repository
 *    whose real source lives in `build/` exists), and a default you cannot
 *    see is a default you cannot correct.
 * 2. It lifts project-specific output directories out of `.gitignore` — the
 *    ones the defaults do not already cover — and pins them, because those
 *    are exactly the directories the defaults could not have known about.
 *
 * Negation rules (`!…`) are read but deliberately never lifted: taken out of
 * their ordered context a negation inverts meaning, and half a `.gitignore`
 * is worse than none of it. Their count is reported instead.
 *
 * ONE CONSEQUENCE WORTH KNOWING: a rule lifted into `repositories[].exclude`
 * moves from the `.gitignore` layer (spec.md §6.2 item 4) up to the explicit
 * config-exclude layer (item 2), where a later `.untangleignore` can no
 * longer take it back. That is the intent of pinning — the indexed scope
 * becomes visible and stable in one list — but it is a real change of
 * priority, so only plain directory names are ever lifted, never patterns.
 */

import type { FileSystemPort } from "@untangle-code/domain";
import { sortByCodepoints } from "@untangle-code/domain";

import type { IgnoreFindingsV1 } from "./types.js";

/**
 * The exclude list written into the configuration.
 *
 * Mirrors `@untangle-code/scanner`'s own overridable default tier, plus
 * `.git`, which the scanner treats as a security-tier exclusion the user
 * cannot switch off — it is listed here so the written file tells the whole
 * truth about what is skipped, not just the switchable half.
 */
export const DEFAULT_PROJECT_EXCLUDES: readonly string[] = [
  ".cache",
  ".git",
  ".gradle",
  ".next",
  ".nuxt",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
];

const DEFAULT_EXCLUDE_SET = new Set(DEFAULT_PROJECT_EXCLUDES);

/** One effective line of a `.gitignore`. */
export interface GitignoreRuleV1 {
  pattern: string;
  negated: boolean;
  /** True when the rule can only ever match a directory (trailing `/`). */
  directoryOnly: boolean;
}

/**
 * Splits `.gitignore` text into effective rules. Blank lines and `#` comments
 * are dropped; a leading `\#` is git's escape for a literal `#` and is
 * unescaped rather than treated as a comment.
 */
export function parseGitignore(text: string): GitignoreRuleV1[] {
  const rules: GitignoreRuleV1[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/u, "").trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
      pattern = pattern.slice(1);
    }
    if (pattern.length === 0) {
      continue;
    }
    rules.push({ pattern, negated, directoryOnly: pattern.endsWith("/") });
  }
  return rules;
}

/**
 * Picks the rules worth pinning into the configuration: plain directory names
 * that the defaults do not already cover.
 *
 * "Plain" means no glob metacharacter and no nested path — `output/` and
 * `.ruff_cache/` qualify, `*.log` and `backend/.env` do not. A file pattern
 * is left to the scanner's runtime `.gitignore` evaluation; the point of
 * pinning is to make the coarse SCOPE of the index visible in one list, not
 * to restate every rule.
 */
export function selectAdditionalExcludes(rules: readonly GitignoreRuleV1[]): string[] {
  const picked = new Set<string>();
  for (const rule of rules) {
    if (rule.negated) {
      continue;
    }
    const bare = rule.pattern.replace(/^\/+/u, "").replace(/\/+$/u, "");
    if (bare.length === 0 || bare.includes("/")) {
      continue;
    }
    if (/[*?[\]!]/u.test(bare)) {
      continue;
    }
    // `foo.log` and `.untangle.local.json` carry an extension and are files,
    // not directories; only a trailing slash makes such a name worth pinning.
    // A leading dot alone does not count as an extension, so `.turbo` and
    // `.venv` still qualify.
    if (!rule.directoryOnly && bare.slice(1).includes(".")) {
      continue;
    }
    if (DEFAULT_EXCLUDE_SET.has(bare)) {
      continue;
    }
    picked.add(bare);
  }
  return sortByCodepoints([...picked]);
}

export interface IgnoreInput {
  fs: FileSystemPort;
  /** Absolute, canonical repository root. */
  repoRoot: string;
}

export async function detectIgnoreRules(input: IgnoreInput): Promise<IgnoreFindingsV1> {
  const { fs, repoRoot } = input;
  const gitignoreText = await readOptionalText(fs, `${trimSlash(repoRoot)}/.gitignore`);
  const untangleIgnoreText = await readOptionalText(fs, `${trimSlash(repoRoot)}/.untangleignore`);
  const rules = gitignoreText === null ? [] : parseGitignore(gitignoreText);

  return {
    gitignorePresent: gitignoreText !== null,
    gitignoreRuleCount: rules.length,
    gitignoreNegationCount: rules.filter((rule) => rule.negated).length,
    untangleIgnorePresent: untangleIgnoreText !== null,
    defaultExcludes: [...DEFAULT_PROJECT_EXCLUDES],
    additionalExcludes: selectAdditionalExcludes(rules),
  };
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function readOptionalText(fs: FileSystemPort, path: string): Promise<string | null> {
  const stat = await fs.stat(path);
  if (stat === null || stat.kind !== "file") {
    return null;
  }
  try {
    return await fs.readTextFile(path);
  } catch {
    return null;
  }
}
