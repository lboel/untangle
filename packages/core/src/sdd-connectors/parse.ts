import path from "node:path";

import type { ProductFeatureV1 } from "@untangle-code/domain";

import { validProductPath } from "../product-alignment/manifest.js";

import type { SddReader } from "./reader.js";
import type { SddFeatureV1, SddFileReferenceV1, SddRequirementV1, SddTaskV1 } from "./types.js";

/** Markdown examples and HTML comments are not live framework declarations. */
export function markdownLines(text: string): { text: string; line: number }[] {
  let fence: { marker: string; length: number } | undefined,
    comment = false;
  return text.split(/\r?\n/u).map((raw, index) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(raw)?.[1];
      if (close && close[0] === fence.marker && close.length >= fence.length) fence = undefined;
      return { text: "", line: index + 1 };
    }
    let value = "",
      offset = 0;
    while (offset < raw.length) {
      if (comment) {
        const end = raw.indexOf("-->", offset);
        if (end < 0) break;
        offset = end + 3;
        comment = false;
      } else {
        const begin = raw.indexOf("<!--", offset);
        if (begin < 0) {
          value += raw.slice(offset);
          break;
        }
        value += raw.slice(offset, begin);
        offset = begin + 4;
        comment = true;
      }
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(value);
    if (opening && (opening[1]![0] !== "`" || !opening[2]!.includes("`"))) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      return { text: "", line: index + 1 };
    }
    return { text: value, line: index + 1 };
  });
}
export function documentHeading(text: string): string | null {
  return (
    markdownLines(text)
      .map((line) => /^#{1,6}\s+(.+?)\s*#*$/u.exec(line.text)?.[1])
      .find((heading) => heading !== undefined) ?? null
  );
}
const readable = (value: string): string => value.replace(/\*\*/gu, "").trim();

export function parseRequirements(
  text: string,
  file: string,
  framework: SddFeatureV1["framework"],
): SddRequirementV1[] {
  const result: SddRequirementV1[] = [];
  let current: SddRequirementV1 | undefined;
  let heading = "",
    change: SddRequirementV1["change"];
  for (const line of markdownLines(text)) {
    const h = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line.text);
    if (h) {
      current = undefined;
      heading = h[2]!;
      if (h[1] === "##")
        change = ({ ADDED: "added", MODIFIED: "modified", REMOVED: "removed" } as const)[
          /^([A-Z]+) Requirements$/u.exec(heading)?.[1] as "ADDED" | "MODIFIED" | "REMOVED"
        ];
      if (framework === "openspec") {
        const kind = /^Requirement:\s*(.+)$/u.exec(heading)
          ? "requirement"
          : /^Scenario:\s*(.+)$/u.exec(heading)
            ? "scenario"
            : null;
        if (kind) {
          current = {
            id: `${kind}-${String(result.length + 1)}`,
            description: readable(heading.replace(/^(?:Requirement|Scenario):\s*/u, "")),
            body: "",
            path: file,
            line: line.line,
            heading,
            kind,
            ...(change ? { change } : {}),
          };
          result.push(current);
        }
      }
    }
    if (framework === "openspec" && !h && current) current.body += `${line.text}\n`;
    if (framework === "spec-kit") {
      const requirement = /^\s*[-*]\s+\*{0,2}((?:FR|SC)-[A-Za-z0-9_-]+)\*{0,2}\s*:\s*(.+)$/u.exec(
        line.text,
      );
      if (requirement && readable(requirement[2]!).length > 0) {
        current = {
          id: requirement[1]!,
          description: readable(requirement[2]!),
          body: requirement[2]!.trim(),
          path: file,
          line: line.line,
          heading,
          kind: requirement[1]!.startsWith("SC-") ? "success_criterion" : "requirement",
        };
        result.push(current);
      } else if (current && !h && line.text.trim() && !/^\s*[-*]\s/u.test(line.text))
        current.body += `\n${line.text.trim()}`;
      else current = undefined;
    }
  }
  for (const requirement of result) requirement.body = requirement.body.trim();
  return result;
}
export function parseTasks(
  text: string,
  file: string,
  framework: SddFeatureV1["framework"],
): SddTaskV1[] {
  const result: SddTaskV1[] = [];
  for (const line of markdownLines(text)) {
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/u.exec(line.text);
    if (!task) continue;
    const body = task[2]!;
    const id = (framework === "spec-kit" ? /^(T\d+)\b/u : /^(\d+(?:\.\d+)+)\b/u).exec(body)?.[1];
    if (!id) continue;
    const story = /\[(US\d+)\]/u.exec(body)?.[1];
    result.push({
      id,
      description: readable(body),
      checked: task[1]!.toLowerCase() === "x",
      path: file,
      line: line.line,
      ...(story ? { story } : {}),
    });
  }
  return result;
}
function pathRole(file: string): SddFileReferenceV1["role"] {
  if (/\.(?:md|mdx|json|ya?ml|toml|lock|txt)$/iu.test(file)) return "document";
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|[./_-])(?:test|spec)(?:[./_-]|$)|(?:^|\/)test_[^/]+\./iu.test(
    file,
  )
    ? "test"
    : "code";
}
/** Keep literal references and provenance; an unmentioned source never becomes a selection. */
export async function extractFileReferences(
  text: string,
  file: string,
  reader: SddReader,
): Promise<SddFileReferenceV1[]> {
  const result: SddFileReferenceV1[] = [];
  for (const line of markdownLines(text)) {
    const literals = new Set([
      ...[...line.text.matchAll(/`([^`\n]+)`/gu)].map((m) => m[1]!),
      ...[...line.text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/gu)].map((m) => m[1]!),
      ...[
        ...line.text.matchAll(
          /(?:^|\s)((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|[\s,;)])/gu,
        ),
      ].map((m) => m[1]!),
    ]);
    for (const literal of literals) {
      if (!/\.[A-Za-z0-9]+(?:#[^\s]*)?$/u.test(literal) || /^https?:\/\//iu.test(literal)) continue;
      if (result.length >= 512) {
        reader.issue(
          "reference_limit",
          file,
          "Only the first 512 literal file references per document are inspected.",
        );
        return result;
      }
      const clean = literal.replace(/#[^#]*$/u, "");
      const candidates = [
        ...new Set([clean, path.posix.normalize(path.posix.join(path.posix.dirname(file), clean))]),
      ];
      const reference: SddFileReferenceV1 = {
        literal,
        sourcePath: file,
        line: line.line,
        path: null,
        role: pathRole(clean),
        status: "missing",
      };
      if (path.posix.isAbsolute(clean) || /[:\\]/u.test(clean)) {
        reference.status = "unsafe";
        result.push(reference);
        continue;
      }
      let unsafe = false;
      const matches: string[] = [];
      for (const candidate of candidates) {
        const state = await reader.safe(candidate);
        if (state === "unsafe") {
          unsafe = true;
          continue;
        }
        if (state !== "file") continue;
        matches.push(candidate);
      }
      if (matches.length > 1) {
        reference.status = "ambiguous";
        reader.issue(
          "ambiguous_reference",
          file,
          `The literal reference ${JSON.stringify(literal)} resolves to multiple in-project files.`,
        );
        result.push(reference);
        continue;
      }
      for (const candidate of matches) {
        const content = await reader.read(candidate);
        reference.path = candidate;
        reference.role = pathRole(candidate);
        reference.status = content === null ? "unreadable" : "resolved";
        const source = reader.sources.get(candidate);
        if (source) reference.sha256 = source.sha256;
      }
      if (!reference.path && unsafe) reference.status = "unsafe";
      result.push(reference);
    }
  }
  return result;
}

export function featureDraft(
  feature: SddFeatureV1,
  texts: ReadonlyMap<string, string>,
  issue: SddReader["issue"],
  constitution?: string,
): ProductFeatureV1 | null {
  if (feature.id.length > 4096 || feature.title.length > 4096) {
    issue(
      "draft_field_limit",
      feature.directory,
      "The feature identifier or title exceeds 4096 characters; this feature is omitted from the draft and retained in the connector evidence.",
    );
    return null;
  }
  const intent: ProductFeatureV1["intent"] = [];
  const addIntent = (file: string, role: "vision" | "specification") => {
    const heading = documentHeading(texts.get(file) ?? "");
    if (!heading) return;
    if (heading.length > 4096 || !validProductPath(file)) {
      issue(
        "draft_field_limit",
        file,
        "The exact document authority exceeds the manifest path or heading budget; it is omitted rather than shortened.",
      );
      return;
    }
    intent.push({ path: file, heading, role });
  };
  for (const file of feature.documents) {
    if (file.endsWith("/spec.md") || file.endsWith("/proposal.md"))
      addIntent(file, file.endsWith("/proposal.md") ? "vision" : "specification");
  }
  if (constitution && intent.length < 32) addIntent(constitution, "vision");
  const paths = (role: "code" | "test") =>
    [
      ...new Set(
        feature.references
          .filter((ref) => ref.status === "resolved" && ref.role === role && ref.path)
          .map((ref) => ref.path!),
      ),
    ]
      .filter((file) => {
        if (file.length <= 512 && validProductPath(file) && !file.startsWith("!")) return true;
        issue(
          "draft_selection_limit",
          file,
          "The exact resolved file cannot satisfy the manifest's bounded literal selection contract; it is omitted from the draft and retained in the connector evidence.",
        );
        return false;
      })
      .sort()
      .slice(0, 512);
  return {
    id: feature.id,
    title: feature.title,
    stage: "planned",
    review: "proposed",
    intent: intent.slice(0, 32),
    owners: [],
    code: { include: paths("code") },
    tests: { include: paths("test") },
    dependsOn: [],
    criteria: feature.requirements
      .filter((requirement) => requirement.kind !== "scenario" && requirement.change !== "removed")
      .slice(0, 128)
      .flatMap((requirement, index) => {
        const id = `${requirement.id}-${String(index + 1)}`;
        const description = readable(
          feature.framework === "spec-kit"
            ? requirement.body
            : requirement.body && requirement.body !== requirement.description
              ? `${requirement.description}: ${requirement.body}`
              : requirement.description,
        );
        if (!description || description.length > 4096 || id.length > 4096) {
          issue(
            "draft_criterion_limit",
            requirement.path,
            "An exact criterion identifier or description exceeds the manifest string budget; it is omitted rather than shortened and remains in the connector evidence.",
          );
          return [];
        }
        return [{ id, description, tests: [] }];
      }),
  };
}
