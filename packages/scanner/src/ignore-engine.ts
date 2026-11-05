/**
 * Ignore engine implementing the priority order of spec.md §6.2:
 *
 *   1. security/system excludes         — never overridable
 *   2. explicit config excludes         — `RepositoryConfig.exclude`
 *   3. `.untangleignore`
 *   4. `.gitignore`
 *   5. default excludes                 — spec.md §6.3
 *   6. config includes override (5) only, never (1)-(4)
 *
 * Implementation model: layers are applied from lowest to highest priority
 * (5 → 6 → 4 → 3 → 2 → 1); a layer only changes the running decision when
 * it actually has an opinion (some pattern in it matched), otherwise the
 * decision made by a lower-priority layer is kept. This makes "higher
 * priority" mean exactly "wins whenever it has an opinion", matching the
 * spec text without requiring gitignore-style whole-tree renegotiation.
 *
 * See README, "Entscheidungen" for the two points spec.md leaves implicit
 * and that this engine fixes: (a) which of the §6.3 default-exclude names
 * are promoted to the non-overridable "security/system" tier, and (b) that
 * config includes are read as overriding *only* the default-exclude layer,
 * per the literal wording of §6.2 item 6.
 */
import {
  compileGlobList,
  compilePatterns,
  evaluateLayer,
  type CompiledPattern,
} from "./gitignore-pattern.js";
import type { ExclusionReason, IgnoreConfig, IgnoreDecision } from "./types.js";

/**
 * Non-overridable system/VCS directories (spec.md §6.2 item 1). A subset of
 * §6.3's list is promoted here rather than left in the overridable default
 * tier — see README, "Entscheidungen" (decision 1).
 */
const SECURITY_EXCLUDE_NAMES = [".git", ".svn", ".hg"];

/** Overridable default excludes (spec.md §6.3), minus the security/system tier above. */
const DEFAULT_EXCLUDE_NAMES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  "target",
  ".gradle",
  ".venv",
  "venv",
  "__pycache__",
];

/** "generated assets" (spec.md §6.3) — common generated/minified/output file patterns. */
const DEFAULT_GENERATED_ASSET_PATTERNS = ["**/*.min.js", "**/*.min.css", "**/*.map"];

interface LayerFrame {
  size: number;
}

/**
 * Stateful ignore evaluator. `pushGitignoreLayer`/`popGitignoreLayer` (and
 * the `untangleignore` equivalents) let a directory walker maintain, as a
 * stack, exactly the nested-ignore-file patterns that apply along the
 * current root-to-here path — deeper files are pushed later and therefore
 * win ties within their own layer, matching git's "nearer file wins"
 * behavior.
 */
export class IgnoreEngine {
  private readonly securityPatterns: CompiledPattern[];
  private readonly defaultPatterns: CompiledPattern[];
  private readonly configIncludePatterns: CompiledPattern[];
  private readonly configExcludePatterns: CompiledPattern[];

  private readonly gitignoreStack: CompiledPattern[] = [];
  private readonly gitignoreFrames: LayerFrame[] = [];
  private readonly untangleignoreStack: CompiledPattern[] = [];
  private readonly untangleignoreFrames: LayerFrame[] = [];

  public constructor(config?: IgnoreConfig) {
    this.securityPatterns = compileGlobList(SECURITY_EXCLUDE_NAMES);
    this.defaultPatterns = compileGlobList([
      ...DEFAULT_EXCLUDE_NAMES,
      ...DEFAULT_GENERATED_ASSET_PATTERNS,
      ...(config?.additionalDefaultExcludes ?? []),
    ]);
    this.configIncludePatterns = compileGlobList(config?.configInclude ?? []);
    this.configExcludePatterns = compileGlobList(config?.configExclude ?? []);
  }

  public pushGitignoreLayer(baseDir: string, content: string): void {
    const patterns = compilePatterns(content, baseDir);
    this.gitignoreFrames.push({ size: patterns.length });
    this.gitignoreStack.push(...patterns);
  }

  public popGitignoreLayer(): void {
    const frame = this.gitignoreFrames.pop();
    if (frame !== undefined) {
      this.gitignoreStack.length -= frame.size;
    }
  }

  public pushUntangleIgnoreLayer(baseDir: string, content: string): void {
    const patterns = compilePatterns(content, baseDir);
    this.untangleignoreFrames.push({ size: patterns.length });
    this.untangleignoreStack.push(...patterns);
  }

  public popUntangleIgnoreLayer(): void {
    const frame = this.untangleignoreFrames.pop();
    if (frame !== undefined) {
      this.untangleignoreStack.length -= frame.size;
    }
  }

  public decide(relativePath: string, isDirectory: boolean): IgnoreDecision {
    let ignored = evaluateLayer(this.defaultPatterns, relativePath, isDirectory) ?? false;
    let reason: ExclusionReason | undefined = ignored ? "default-exclude" : undefined;

    if (evaluateLayer(this.configIncludePatterns, relativePath, isDirectory) === true) {
      ignored = false;
      reason = undefined;
    }

    const gitDecision = evaluateLayer(this.gitignoreStack, relativePath, isDirectory);
    if (gitDecision !== undefined) {
      ignored = gitDecision;
      reason = gitDecision ? "gitignore" : undefined;
    }

    const untangleDecision = evaluateLayer(this.untangleignoreStack, relativePath, isDirectory);
    if (untangleDecision !== undefined) {
      ignored = untangleDecision;
      reason = untangleDecision ? "untangleignore" : undefined;
    }

    if (evaluateLayer(this.configExcludePatterns, relativePath, isDirectory) === true) {
      ignored = true;
      reason = "config-exclude";
    }

    if (evaluateLayer(this.securityPatterns, relativePath, isDirectory) === true) {
      ignored = true;
      reason = "security";
    }

    return reason === undefined ? { ignored } : { ignored, reason };
  }
}

export function createIgnoreEngine(config?: IgnoreConfig): IgnoreEngine {
  return new IgnoreEngine(config);
}
