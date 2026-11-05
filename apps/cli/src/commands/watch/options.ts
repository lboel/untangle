/**
 * Aufrufoptionen von `untangle watch`.
 *
 * Bewusst ohne Argument-Bibliothek: die Menge ist klein, geschlossen und
 * vollstaendig hier dokumentiert. Eine unbekannte Option ist ein FEHLER und
 * wird nie stillschweigend ignoriert — eine ignorierte Option ist die
 * lautloseste Art, etwas anderes zu messen als der Nutzer wollte (E4).
 */
import path from "node:path";

export interface WatchOptionsV1 {
  /** Absoluter, OS-nativer Pfad des ueberwachten Baums. */
  root: string;
  repoId: string;
  refId: string;
  format: "text" | "json";
  /** Absoluter Pfad der Mitschrift, oder `null`. */
  outPath: string | null;
  /** Farbe im Terminal. Nur wahr, wenn stdout ein TTY ist und niemand widerspricht. */
  color: boolean;
  debounceMs: number;
  reconciliationIntervalMs: number;
  /** Dateien groesser als dies gehen mit Grund ins Ledger statt in die Zahlen. */
  maxFileBytes: number;
  /** Hoechstzahl der je Aenderung ausgewiesenen Scope-Deltas. */
  scopeLimit: number;
  /**
   * Nach so vielen Aenderungsereignissen sauber beenden. `null` = nur auf
   * Signal. Existiert, damit ein Lauf reproduzierbar vorfuehrbar ist, ohne
   * dass jemand ein Signal von Hand schicken muss.
   */
  exitAfterChanges: number | null;
  /** Nur die Grundmessung ausgeben und beenden (Selbsttest, kein Watch-Lauf). */
  baselineOnly: boolean;
  help: boolean;
}

export interface ParsedWatchArgsV1 {
  ok: true;
  options: WatchOptionsV1;
}
export interface FailedWatchArgsV1 {
  ok: false;
  message: string;
}

export const WATCH_USAGE = `untangle watch — complexity monitoring

  Watch a tree and report each metric's delta for every change
  (structural, semantic, cyclomatic, cognitive), including whether
  complexity decreased or increased.

Usage:
  untangle watch [OPTIONS]

Options:
  --root PATH            Watched tree (default: current directory)
  --repo-id ID           Repository identity for the lock (default: directory name)
  --ref-id ID            Ref identity for the lock (default: <repo-id>:working-tree)
  --format text|json     Output format (default: text; json = one JSON line per event)
  --out FILE             Also save the stream to FILE (always without color)
  --no-color             Disable color even on a TTY
  --debounce MS          Debounce quiet period (default: 200)
  --reconcile MS         Full reconciliation interval (default: 30000)
  --max-file-bytes N     File size limit (default: 5242880)
  --scopes N             Maximum reported scope deltas per change (default: 5)
  --exit-after N         Stop cleanly after N changes (default: on signal only)
  --baseline-only        Report the baseline and exit
  --index                Maintain the search index instead of complexity stream
  --repo ID              --index: required with several configured repositories
  --ref NAME             --index: must be physically checked out
  --embedder auto|offline --index: current index profile or explicitly offline
  -h, --help             Show this help

Search-index mode:
  --index requires the complete CLI build (pnpm build).
  --reconcile becomes the check interval; --baseline-only checks/updates once;
  --exit-after counts updates. Progress goes to stderr.

Shutdown:
  SIGINT (Ctrl-C) or SIGTERM stops cleanly: watcher stopped, stream
  closed, ref lock released. No orphaned lock is left behind.`;

const DEFAULTS = {
  debounceMs: 200,
  reconciliationIntervalMs: 30_000,
  maxFileBytes: 5 * 1024 * 1024,
  scopeLimit: 5,
};

export interface ParseWatchArgsEnv {
  cwd: string;
  isTty: boolean;
  /** `NO_COLOR` aus der Umgebung (jeder nicht-leere Wert schaltet Farbe ab). */
  noColorEnv: string | undefined;
}

export function parseWatchArgs(
  argv: readonly string[],
  env: ParseWatchArgsEnv,
): ParsedWatchArgsV1 | FailedWatchArgsV1 {
  let root = env.cwd;
  let repoId: string | null = null;
  let refId: string | null = null;
  let format: "text" | "json" = "text";
  let outPath: string | null = null;
  let colorRequested = true;
  let debounceMs = DEFAULTS.debounceMs;
  let reconciliationIntervalMs = DEFAULTS.reconciliationIntervalMs;
  let maxFileBytes = DEFAULTS.maxFileBytes;
  let scopeLimit = DEFAULTS.scopeLimit;
  let exitAfterChanges: number | null = null;
  let baselineOnly = false;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    const takeValue = (): string | null => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      index++;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--no-color":
        colorRequested = false;
        break;
      case "--baseline-only":
        baselineOnly = true;
        break;
      case "--root": {
        const value = takeValue();
        if (value === null) return fail("--root requires a path");
        root = path.resolve(env.cwd, value);
        break;
      }
      case "--repo-id": {
        const value = takeValue();
        if (value === null) return fail("--repo-id requires a string");
        repoId = value;
        break;
      }
      case "--ref-id": {
        const value = takeValue();
        if (value === null) return fail("--ref-id requires a string");
        refId = value;
        break;
      }
      case "--format": {
        const value = takeValue();
        if (value !== "text" && value !== "json") {
          return fail(`--format requires "text" or "json"; received "${String(value)}"`);
        }
        format = value;
        break;
      }
      case "--out": {
        const value = takeValue();
        if (value === null) return fail("--out requires a file path");
        outPath = path.resolve(env.cwd, value);
        break;
      }
      case "--debounce": {
        const value = positiveInt(takeValue());
        if (value === null) return fail("--debounce requires a positive integer");
        debounceMs = value;
        break;
      }
      case "--reconcile": {
        const value = positiveInt(takeValue());
        if (value === null) return fail("--reconcile requires a positive integer");
        reconciliationIntervalMs = value;
        break;
      }
      case "--max-file-bytes": {
        const value = positiveInt(takeValue());
        if (value === null) return fail("--max-file-bytes requires a positive integer");
        maxFileBytes = value;
        break;
      }
      case "--scopes": {
        const value = positiveInt(takeValue());
        if (value === null) return fail("--scopes requires a positive integer");
        scopeLimit = value;
        break;
      }
      case "--exit-after": {
        const value = positiveInt(takeValue());
        if (value === null) return fail("--exit-after requires a positive integer");
        exitAfterChanges = value;
        break;
      }
      default:
        return fail(`unknown option "${arg}"; see "untangle watch --help"`);
    }
  }

  const effectiveRepoId = repoId ?? path.basename(root);
  const colorPossible = env.isTty && (env.noColorEnv === undefined || env.noColorEnv === "");

  return {
    ok: true,
    options: {
      root,
      repoId: effectiveRepoId,
      refId: refId ?? `${effectiveRepoId}:working-tree`,
      format,
      outPath,
      color: colorRequested && colorPossible && format === "text",
      debounceMs,
      reconciliationIntervalMs,
      maxFileBytes,
      scopeLimit,
      exitAfterChanges,
      baselineOnly,
      help,
    },
  };
}

function fail(message: string): FailedWatchArgsV1 {
  return { ok: false, message };
}

function positiveInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}
