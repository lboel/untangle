/**
 * Docker / Compose adapter (architecture.md §20: "Services, Stages").
 *
 * spec.md §19.1's `ContextArtifactType` union has no `"docker"` (or
 * `"compose"`) literal — see README "Entscheidungen" and this WP's
 * openIssues entry. `ArtifactDocument.type` is therefore `"text"` for
 * documents this adapter produces (the closest fit in the frozen contract).
 * `supports()` matches on filename for BOTH `type === "auto"` and
 * `type === "text"` — `"text"` is the only literal an explicit config
 * could even use for a Dockerfile/Compose artifact, so treating it the
 * same as `"auto"` here is what lets an explicit `type: "text"` still get
 * real stage/service chunking instead of being indistinguishable from a
 * plain text file; the registry's `resolve()` tries this adapter before
 * the text fallback either way, so a genuine plain-text file is never
 * misrouted here. `ArtifactDocument.language` carries which of the two a
 * given document is (`"dockerfile"` / `"docker-compose"`), so this
 * adapter's own `chunk()` (and the registry's document→adapter dispatch)
 * can tell a Dockerfile from a Compose file from a genuinely generic text
 * document — `language` is a general-purpose optional field on the frozen
 * contract, so this uses it without needing any contract change.
 *
 * Dockerfile: each `FROM ... [AS name]` starts a build stage that runs to
 * the line before the next `FROM` (or EOF) — kind `"docker_stage"`.
 * Compose: each entry under top-level `services:` becomes one chunk — kind
 * `"compose_service"`.
 *
 * `FROM` detection skips heredoc bodies (WP-81 review's defect class,
 * applied here: a separator-looking token inside a "quoted" region must
 * never be mistaken for a real one). A modern Dockerfile can write
 * `RUN <<EOF` / `COPY <<-EOF /dst` and have arbitrary script text up to a
 * closing `EOF` line — that text is user content, not Dockerfile
 * instructions, so a line reading e.g. `FROM scratch` inside such a heredoc
 * (a Python/shell snippet building its OWN Dockerfile-ish text, or just a
 * coincidence) must never be read as a new build stage.
 */
import type {
  ArtifactAdapter,
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ArtifactLink,
} from "@untangle-code/domain";

import { buildLineIndex, splitLines } from "../text/line-index.js";
import { mapGet, parseYamlNode, YamlParseError } from "../text/yaml-lite.js";

import type { ChunkDraft, SkipLedgerReporter } from "./shared.js";
import { buildChunksReportingSkips, buildDocuments, wholeDocumentDraft } from "./shared.js";

const DOCKERFILE_NAME = /(^|\/)Dockerfile(\.[\w-]+)?$/;
const COMPOSE_NAME = /(^|\/)(docker-)?compose\.ya?ml$/i;

const FROM_RE = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

/** `RUN <<EOF`, `COPY <<-'EOF' /dst`, … — an optional `-` (strip leading tabs on the closing line) and an optional quoted/bare delimiter word. */
const HEREDOC_OPEN_RE = /<<(-)?\s*(['"]?)([A-Za-z_][\w]*)\2/;

function dockerfileDrafts(lines: string[]): ChunkDraft[] {
  const stageStarts: { line: number; base: string; name?: string }[] = [];
  let heredocDelimiter: string | null = null;
  let heredocStripLeadingTabs = false;
  for (const [index, line] of lines.entries()) {
    if (heredocDelimiter !== null) {
      const closingCandidate = heredocStripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (closingCandidate === heredocDelimiter) {
        heredocDelimiter = null;
      }
      continue; // heredoc body: never Dockerfile instructions, whatever they contain
    }
    const heredocOpen = HEREDOC_OPEN_RE.exec(line);
    if (heredocOpen) {
      heredocDelimiter = heredocOpen[3]!;
      heredocStripLeadingTabs = heredocOpen[1] === "-";
      continue; // the opener line itself (e.g. "RUN <<EOF") is never a FROM either
    }
    const match = FROM_RE.exec(line);
    if (match) {
      const entry: { line: number; base: string; name?: string } = {
        line: index + 1,
        base: match[1]!,
      };
      stageStarts.push(match[2] === undefined ? entry : { ...entry, name: match[2] });
    }
  }
  const totalLines = Math.max(lines.length, 1);
  return stageStarts.map((stage, position) => {
    const endLine =
      position + 1 < stageStarts.length ? stageStarts[position + 1]!.line - 1 : totalLines;
    return {
      kind: "docker_stage",
      startLine: stage.line,
      endLine,
      title: stage.name === undefined ? `stage ${position} (${stage.base})` : stage.name,
    };
  });
}

function composeDrafts(document: ArtifactDocument): ChunkDraft[] {
  try {
    const root = parseYamlNode(document.content);
    const services = mapGet(root, "services");
    if (services === undefined || services.kind !== "map") return [];
    return services.entries.map((entry): ChunkDraft => ({
      kind: "compose_service",
      startLine: entry.value.startLine,
      endLine: entry.value.endLine,
      title: entry.key,
    }));
  } catch (error) {
    const reason = error instanceof YamlParseError ? error.message : "unknown parse error";
    return [
      wholeDocumentDraft(
        "compose_parse_error",
        buildLineIndex(document.content),
        `parse error: ${reason}`,
      ),
    ];
  }
}

export interface DockerAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createDockerAdapter(options: DockerAdapterOptions = {}): ArtifactAdapter {
  return {
    supports(type: string, path: string): boolean {
      return (
        (type === "auto" || type === "text") &&
        (DOCKERFILE_NAME.test(path) || COMPOSE_NAME.test(path))
      );
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      const dockerfiles = input.files.filter((file) => DOCKERFILE_NAME.test(file.path));
      const composeFiles = input.files.filter((file) => COMPOSE_NAME.test(file.path));
      return [
        ...buildDocuments({ config: input.config, files: dockerfiles }, "text", "dockerfile"),
        ...buildDocuments({ config: input.config, files: composeFiles }, "text", "docker-compose"),
      ];
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      const index = buildLineIndex(document.content);
      if (document.language === "dockerfile") {
        const { lines } = splitLines(document.content);
        return buildChunksReportingSkips(
          document,
          index,
          dockerfileDrafts(lines),
          options.onSkipLedgerGap,
        );
      }
      // Anything else (including "docker-compose" and any unrecognized
      // label an external caller might set) is treated as Compose YAML —
      // the only other shape this adapter's own `read()` ever produces.
      return buildChunksReportingSkips(
        document,
        index,
        composeDrafts(document),
        options.onSkipLedgerGap,
      );
    },

    links(): ArtifactLink[] {
      return [];
    },
  };
}
