import { createHash } from "node:crypto";
import path from "node:path";

import type { FileSystemPort } from "@untangle-code/domain";
import {
  compareCodepoints,
  findMarkdownLinks,
  linkFilePath,
  outlineMarkdown,
} from "@untangle-code/domain";
import type { ScannedFileV1 } from "@untangle-code/scanner";

export type ProductContextRoleV1 = "vision" | "specification" | "product";
export type ProductContextSourceStatusV1 =
  "readable" | "empty" | "unreadable" | "changed" | "not_in_scan" | "not_assessed";

export interface ProductContextSourceV1 {
  role: ProductContextRoleV1;
  /** Repository-relative path, including a visible escape for rejected explicit paths. */
  path: string;
  /** Hash of the exact bytes read; absent when no content was read. */
  contentHash?: string;
  /** Accepted scanner hash, retained separately when the subsequent read differs. */
  scannedContentHash?: string;
  status: ProductContextSourceStatusV1;
  selected: boolean;
  selection: "explicit" | "filename_candidate";
  sections: { title: string; startLine: number; endLine: number }[];
}

export interface ProductContextReferenceV1 {
  sourcePath: string;
  sourceLine: number;
  targetPath: string;
  status: "present" | "missing" | "not_in_scan" | "outside_workspace";
  /** Hash from the accepted scan, never a claim of semantic implementation. */
  targetContentHash?: string;
}

export interface ProductContextAssessmentV1 {
  schemaVersion: 1;
  status: "needs_context" | "needs_selection" | "ready_for_review" | "incomplete";
  sources: ProductContextSourceV1[];
  missingRoles: ProductContextRoleV1[];
  ambiguousRoles: ProductContextRoleV1[];
  references: ProductContextReferenceV1[];
  referencesTruncated: boolean;
  alignment: { status: "unverified"; reason: "feature_and_ownership_not_confirmed" };
  reviewDraft: { features: []; ownership: []; questions: string[] };
  limitations: string[];
}

export interface AssessProductContextInputV1 {
  fs: FileSystemPort;
  root: string;
  /** Files already accepted by the same bounded, ignore-aware scanner pass. */
  files: readonly ScannedFileV1[];
  inventoryTruncated: boolean;
  visionPath?: string;
  specPath?: string;
  signal?: AbortSignal;
  /** Number of distinct documents to read, from zero to the hard ceiling of 32. */
  maxDocuments?: number;
}

const ROLES: readonly ProductContextRoleV1[] = ["vision", "specification", "product"];
const REQUIRED_ROLES: readonly ProductContextRoleV1[] = ["vision", "specification"];
const MAX_DOCUMENTS = 32;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCES = 256;
const MAX_LINE_CHARACTERS = 16_384;
const MAX_LINK_OPENINGS = 4_096;
const MAX_HEADING_CANDIDATES = 2_048;

interface DocumentRead {
  status: ProductContextSourceStatusV1;
  contentHash?: string;
  scannedContentHash?: string;
  lines?: string[];
  limitation?: string;
}

interface InspectionContext {
  input: AssessProductContextInputV1;
  root: string;
  inventory: ReadonlyMap<string, ScannedFileV1>;
}

/** Discover and bind product documents; neither filenames nor links prove conformance. */
export async function assessProductContext(
  input: AssessProductContextInputV1,
): Promise<ProductContextAssessmentV1> {
  input.signal?.throwIfAborted();
  const maximum = documentLimit(input.maxDocuments);
  const root = path.resolve(input.root);
  const inventory = acceptedInventory(root, input.files);
  const sources = discoverSources(input, root, inventory);
  const ambiguousRoles = ambiguousSourceRoles(sources);
  selectSources(sources, ambiguousRoles, input.inventoryTruncated);

  const context: InspectionContext = { input, root, inventory };
  const reads = await inspectDocuments(context, sources, maximum);
  const { references, referencesTruncated, pathLimitations } = await inspectReferences(
    context,
    reads,
  );
  const missingRoles = missingSourceRoles(sources, input.inventoryTruncated);
  const limitations = inspectionLimitations(
    input,
    reads,
    references,
    referencesTruncated,
    pathLimitations,
  );

  input.signal?.throwIfAborted();
  return {
    schemaVersion: 1,
    status: assessmentStatus(
      sources,
      missingRoles,
      ambiguousRoles,
      input.inventoryTruncated || referencesTruncated,
    ),
    sources,
    missingRoles,
    ambiguousRoles,
    references,
    referencesTruncated,
    alignment: { status: "unverified", reason: "feature_and_ownership_not_confirmed" },
    reviewDraft: { features: [], ownership: [], questions: reviewQuestions(sources, references) },
    limitations,
  };
}

function documentLimit(candidate: number | undefined): number {
  const value = candidate ?? MAX_DOCUMENTS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_DOCUMENTS) {
    throw new RangeError("maxDocuments must be an integer between 0 and 32");
  }
  return value;
}

function normalizedRelativePath(root: string, candidate: string): string {
  return path
    .relative(root, path.resolve(root, candidate.replaceAll("\\", "/")))
    .split(path.sep)
    .join("/");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function acceptedInventory(
  root: string,
  files: readonly ScannedFileV1[],
): Map<string, ScannedFileV1> {
  const inventory = new Map<string, ScannedFileV1>();
  for (const file of files) {
    const relative = normalizedRelativePath(root, file.relativePath);
    if (isWithinRoot(root, path.resolve(root, relative)) && isWithinRoot(root, file.absolutePath)) {
      inventory.set(relative, file);
    }
  }
  return inventory;
}

function filenameRole(filePath: string): ProductContextRoleV1 | undefined {
  const name = path.posix.basename(filePath).toLowerCase();
  if (!/\.(md|markdown|mdx)$/u.test(name)) return undefined;
  const stem = name.replace(/\.(md|markdown|mdx)$/u, "");
  if (/^(vision|product[-_]vision)(?:[-_.].+)?$/u.test(stem)) return "vision";
  if (/^(spec|specification|requirements)(?:[-_.].+)?$/u.test(stem)) return "specification";
  if (/^(prd|product)(?:[-_.].+)?$/u.test(stem)) return "product";
  return undefined;
}

function sourceEntry(
  role: ProductContextRoleV1,
  filePath: string,
  selection: ProductContextSourceV1["selection"],
): ProductContextSourceV1 {
  return { role, path: filePath, selection, status: "not_assessed", selected: false, sections: [] };
}

function discoverSources(
  input: AssessProductContextInputV1,
  root: string,
  inventory: ReadonlyMap<string, ScannedFileV1>,
): ProductContextSourceV1[] {
  const entries = new Map<string, ProductContextSourceV1>();
  for (const filePath of inventory.keys()) {
    const role = filenameRole(filePath);
    if (role !== undefined)
      entries.set(`${role}\0${filePath}`, sourceEntry(role, filePath, "filename_candidate"));
  }
  for (const [role, explicit] of [
    ["vision", input.visionPath],
    ["specification", input.specPath],
  ] as const) {
    if (explicit === undefined) continue;
    const filePath = normalizedRelativePath(root, explicit);
    entries.set(`${role}\0${filePath}`, sourceEntry(role, filePath, "explicit"));
  }
  return [...entries.values()].sort(
    (left, right) =>
      ROLES.indexOf(left.role) - ROLES.indexOf(right.role) ||
      compareCodepoints(left.path, right.path),
  );
}

function ambiguousSourceRoles(sources: readonly ProductContextSourceV1[]): ProductContextRoleV1[] {
  return ROLES.filter((role) => {
    const candidates = sources.filter((source) => source.role === role);
    if (candidates.some((source) => source.selection === "explicit")) return false;
    return candidates.length > 1;
  });
}

function selectSources(
  sources: ProductContextSourceV1[],
  ambiguousRoles: readonly ProductContextRoleV1[],
  inventoryTruncated: boolean,
): void {
  for (const role of ROLES) {
    const candidates = sources.filter((source) => source.role === role);
    const explicit = candidates.find((source) => source.selection === "explicit");
    if (explicit !== undefined) explicit.selected = true;
    else if (!inventoryTruncated && !ambiguousRoles.includes(role) && candidates.length === 1) {
      (candidates[0] as ProductContextSourceV1).selected = true;
    }
  }
}

async function inspectDocuments(
  context: InspectionContext,
  sources: ProductContextSourceV1[],
  maximum: number,
): Promise<Map<string, DocumentRead>> {
  const reads = new Map<string, DocumentRead>();
  const prioritized = [...sources].sort(
    (left, right) =>
      Number(right.selection === "explicit") - Number(left.selection === "explicit") ||
      Number(right.selected) - Number(left.selected) ||
      ROLES.indexOf(left.role) - ROLES.indexOf(right.role) ||
      compareCodepoints(left.path, right.path),
  );
  let readCount = 0;
  for (const source of prioritized) {
    context.input.signal?.throwIfAborted();
    let result = reads.get(source.path);
    if (result === undefined) {
      const file = context.inventory.get(source.path);
      if (file === undefined)
        result = {
          status: "not_in_scan",
          limitation: `Source "${source.path}" is absent from the accepted scan; it may be missing, ignored, or outside the workspace.`,
        };
      else if (readCount >= maximum)
        result = {
          status: "not_assessed",
          limitation: `Source "${source.path}" was not read because the document limit of ${String(maximum)} was reached.`,
        };
      else {
        readCount += 1;
        result = await inspectDocument(context, file);
      }
      reads.set(source.path, result);
    }
    applyDocumentRead(source, result);
  }
  return reads;
}

async function inspectDocument(
  context: InspectionContext,
  file: ScannedFileV1,
): Promise<DocumentRead> {
  const { fs, signal } = context.input;
  const options = signal === undefined ? {} : { signal };
  let contentHash: string | undefined;
  try {
    const realPath = await fs.realPath(path.resolve(context.root, file.relativePath), options);
    signal?.throwIfAborted();
    if (!isWithinRoot(context.root, realPath)) {
      return {
        status: "not_in_scan",
        limitation: `Source "${file.relativePath}" now resolves outside the workspace; no content was read.`,
      };
    }
    const stat = await fs.stat(realPath, options);
    signal?.throwIfAborted();
    if (stat === null || stat.kind !== "file" || stat.sizeBytes > MAX_DOCUMENT_BYTES) {
      return {
        status: "unreadable",
        limitation: `Source "${file.relativePath}" is not a readable file within the 5 MiB document ceiling.`,
      };
    }
    const bytes = await fs.readFile(realPath, options);
    signal?.throwIfAborted();
    contentHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      return {
        status: "unreadable",
        contentHash,
        limitation: `Source "${file.relativePath}" exceeded the 5 MiB document ceiling during reading.`,
      };
    }
    if (contentHash !== file.contentHash) {
      return {
        status: "changed",
        contentHash,
        scannedContentHash: file.contentHash,
        limitation: `Source "${file.relativePath}" changed after discovery; its content was not interpreted.`,
      };
    }
    if (file.encoding === "utf16le" || file.encoding === "utf16be") {
      return {
        status: "unreadable",
        contentHash,
        limitation: `Source "${file.relativePath}" has unsupported ${file.encoding} encoding; no headings were inferred.`,
      };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = text.split(/\r?\n/u);
    const parseLimitation = markdownParseLimitation(lines);
    if (parseLimitation !== undefined) {
      return {
        status: "not_assessed",
        contentHash,
        limitation: `Source "${file.relativePath}" was not interpreted: ${parseLimitation}.`,
      };
    }
    return {
      status: text.trim() === "" ? "empty" : "readable",
      contentHash,
      lines,
    };
  } catch (error) {
    rethrowCancellation(error, signal);
    return {
      status: "unreadable",
      ...(contentHash === undefined ? {} : { contentHash }),
      limitation: `Source "${file.relativePath}" could not be read or decoded as UTF-8.`,
    };
  }
}

/** Conservative input bounds precede the shared outline and link parsers. */
function markdownParseLimitation(lines: readonly string[]): string | undefined {
  let linkOpenings = 0;
  let headingCandidates = 0;
  for (const line of lines) {
    if (line.length > MAX_LINE_CHARACTERS) {
      return "the Markdown parse budget of 16,384 characters per line was exceeded";
    }
    if (line.trimStart().startsWith("#")) headingCandidates += 1;
    if (headingCandidates > MAX_HEADING_CANDIDATES) {
      return "the Markdown parse budget of 2,048 heading candidates was exceeded";
    }
    for (const character of line) {
      if (character === "[") linkOpenings += 1;
      if (linkOpenings > MAX_LINK_OPENINGS) {
        return "the Markdown parse budget of 4,096 opening link brackets was exceeded";
      }
    }
  }
  return undefined;
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
  if (
    error instanceof Error &&
    (error.name === "AbortError" || ("code" in error && error.code === "JOB_CANCELLED"))
  )
    throw error;
}

function applyDocumentRead(source: ProductContextSourceV1, result: DocumentRead): void {
  source.status = result.status;
  if (result.contentHash !== undefined) source.contentHash = result.contentHash;
  if (result.scannedContentHash !== undefined)
    source.scannedContentHash = result.scannedContentHash;
  if (result.status !== "readable") source.selected = false;
  if (result.status === "readable" && result.lines !== undefined) {
    source.sections = outlineMarkdown(result.lines).map((section) => ({
      title: section.breadcrumb,
      startLine: section.startLine,
      endLine: section.endLine,
    }));
  }
}

async function inspectReferences(
  context: InspectionContext,
  reads: ReadonlyMap<string, DocumentRead>,
): Promise<{
  references: ProductContextReferenceV1[];
  referencesTruncated: boolean;
  pathLimitations: string[];
}> {
  const references: ProductContextReferenceV1[] = [];
  const pathLimitations: string[] = [];
  for (const [sourcePath, document] of reads) {
    if (document.status !== "readable" || document.lines === undefined) continue;
    for (const link of findMarkdownLinks(document.lines)) {
      context.input.signal?.throwIfAborted();
      if (link.kind !== "relative_file") continue;
      if (references.length >= MAX_REFERENCES)
        return {
          references: sortedReferences(references),
          referencesTruncated: true,
          pathLimitations,
        };
      const target = referencePath(context.root, sourcePath, link.target);
      const reference = { sourcePath, sourceLine: link.line, targetPath: target.path };
      if (target.limitation !== undefined) {
        references.push({ ...reference, status: "not_in_scan" });
        pathLimitations.push(target.limitation);
      } else references.push(await inspectReference(context, reference));
    }
  }
  return { references: sortedReferences(references), referencesTruncated: false, pathLimitations };
}

function referencePath(
  root: string,
  sourcePath: string,
  target: string,
): { path: string; limitation?: string } {
  const filePart = linkFilePath(target);
  try {
    const decoded = decodeURIComponent(filePart).replaceAll("\\", "/");
    return {
      path: normalizedRelativePath(
        root,
        path.resolve(root, path.posix.dirname(sourcePath), decoded),
      ),
    };
  } catch {
    return {
      path: normalizedRelativePath(
        root,
        path.resolve(root, path.posix.dirname(sourcePath), filePart),
      ),
      limitation: `Reference from "${sourcePath}" to "${target}" has a malformed URI path; no target path was inspected.`,
    };
  }
}

function sortedReferences(references: ProductContextReferenceV1[]): ProductContextReferenceV1[] {
  return references.sort(
    (left, right) =>
      compareCodepoints(left.sourcePath, right.sourcePath) ||
      left.sourceLine - right.sourceLine ||
      compareCodepoints(left.targetPath, right.targetPath),
  );
}

async function inspectReference(
  context: InspectionContext,
  reference: Omit<ProductContextReferenceV1, "status" | "targetContentHash">,
): Promise<ProductContextReferenceV1> {
  const absolute = path.resolve(context.root, reference.targetPath);
  if (!isWithinRoot(context.root, absolute)) return { ...reference, status: "outside_workspace" };
  const accepted = context.inventory.get(reference.targetPath);
  if (accepted !== undefined)
    return { ...reference, status: "present", targetContentHash: accepted.contentHash };
  const options = context.input.signal === undefined ? {} : { signal: context.input.signal };
  try {
    const stat = await context.input.fs.stat(absolute, options);
    context.input.signal?.throwIfAborted();
    if (stat === null) return { ...reference, status: "missing" };
    const realPath = await context.input.fs.realPath(absolute, options);
    context.input.signal?.throwIfAborted();
    return {
      ...reference,
      status: isWithinRoot(context.root, realPath) ? "not_in_scan" : "outside_workspace",
    };
  } catch (error) {
    rethrowCancellation(error, context.input.signal);
    return { ...reference, status: "not_in_scan" };
  }
}

function missingSourceRoles(
  sources: readonly ProductContextSourceV1[],
  inventoryTruncated: boolean,
): ProductContextRoleV1[] {
  if (inventoryTruncated) return [];
  return REQUIRED_ROLES.filter((role) => !sources.some((source) => source.role === role));
}

function assessmentStatus(
  sources: readonly ProductContextSourceV1[],
  missingRoles: readonly ProductContextRoleV1[],
  ambiguousRoles: readonly ProductContextRoleV1[],
  inventoryTruncated: boolean,
): ProductContextAssessmentV1["status"] {
  if (
    inventoryTruncated ||
    sources.some((source) =>
      ["unreadable", "changed", "not_in_scan", "not_assessed"].includes(source.status),
    )
  )
    return "incomplete";
  if (ambiguousRoles.some((role) => REQUIRED_ROLES.includes(role))) return "needs_selection";
  if (
    missingRoles.length > 0 ||
    REQUIRED_ROLES.some(
      (role) =>
        !sources.some(
          (source) => source.role === role && source.selected && source.status === "readable",
        ),
    )
  )
    return "needs_context";
  return "ready_for_review";
}

function inspectionLimitations(
  input: AssessProductContextInputV1,
  reads: ReadonlyMap<string, DocumentRead>,
  references: readonly ProductContextReferenceV1[],
  referencesTruncated: boolean,
  pathLimitations: readonly string[],
): string[] {
  const limitations = [
    "Document roles inferred from filenames are candidates, not confirmed authority.",
    "References confirm accepted-scan paths only; anchors, features, behavior, and ownership remain unverified.",
    ...pathLimitations,
  ];
  if (input.inventoryTruncated)
    limitations.push(
      "The accepted file inventory was truncated; missing roles and unique filename selection cannot be established.",
    );
  if (referencesTruncated)
    limitations.push(
      "Local document references exceeded the limit of 256; further reference paths were not assessed.",
    );
  for (const document of reads.values())
    if (document.limitation !== undefined) limitations.push(document.limitation);
  for (const reference of references) {
    if (reference.status !== "present")
      limitations.push(
        `Reference from "${reference.sourcePath}":${String(reference.sourceLine)} to "${reference.targetPath}" is ${reference.status}.`,
      );
  }
  return [...new Set(limitations)].sort(compareCodepoints);
}

function reviewQuestions(
  sources: readonly ProductContextSourceV1[],
  references: readonly ProductContextReferenceV1[],
): string[] {
  const questions = [
    "Which product features are intended, and which current code and tests demonstrate each one?",
    "Who owns each feature and requirement, and which source takes precedence when documents disagree?",
  ];
  for (const role of REQUIRED_ROLES) {
    if (
      !sources.some(
        (source) => source.role === role && source.selected && source.status === "readable",
      )
    )
      questions.push(`Which readable document is the authoritative ${role} source?`);
  }
  if (references.some((reference) => reference.status !== "present"))
    questions.push(
      "Which unresolved document references should be corrected or explicitly excluded from the review?",
    );
  return questions;
}
