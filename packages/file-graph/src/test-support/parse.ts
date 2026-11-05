/**
 * Testhilfe: echter Parser statt handgeschriebener Importlisten.
 *
 * Alle Tests dieses Pakets bauen ihre Eingaben ueber die ECHTEN Adapter aus
 * `@untangle-code/parser-registry`. Eine handgeschriebene `RawImport`-Liste
 * wuerde nur beweisen, dass der Graph das verarbeitet, was der Test sich
 * ausgedacht hat — nicht, dass er das verarbeitet, was der Parser liefert
 * (docs/BUILD_PLAN.md E5).
 */
import type { LanguageAdapter, ParseResult, RawImport, SourceFile } from "@untangle-code/domain";
import { buildFileId, classifyAdapterFailure, sha256Hex } from "@untangle-code/domain";
import {
  createJavaScriptAdapter,
  createPythonAdapter,
  createTsxAdapter,
  createTypeScriptAdapter,
} from "@untangle-code/parser-registry";

import { extensionOf, normalizePath } from "../paths.js";
import type { FileImportsV1 } from "../types.js";

const adapters = new Map<string, LanguageAdapter>();

function adapterFor(path: string): LanguageAdapter | null {
  const extension = extensionOf(path);
  const languageId =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? "typescript"
      : extension === ".tsx"
        ? "tsx"
        : extension === ".js" ||
            extension === ".mjs" ||
            extension === ".cjs" ||
            extension === ".jsx"
          ? "javascript"
          : extension === ".py"
            ? "python"
            : null;
  if (languageId === null) return null;
  let adapter = adapters.get(languageId);
  if (adapter === undefined) {
    adapter =
      languageId === "typescript"
        ? createTypeScriptAdapter()
        : languageId === "tsx"
          ? createTsxAdapter()
          : languageId === "javascript"
            ? createJavaScriptAdapter()
            : createPythonAdapter();
    adapters.set(languageId, adapter);
  }
  return adapter;
}

export interface ParseFileInput {
  workspaceId: string;
  repoId: string;
  refId: string;
  path: string;
  content: string;
}

/** Parst eine Datei mit dem echten Adapter und liefert die Graph-Eingabe. */
export function fileImportsOf(input: ParseFileInput): FileImportsV1 {
  const path = normalizePath(input.path);
  const contentHash = sha256Hex(input.content);
  const fileId = buildFileId({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    refId: input.refId,
    relativePath: path,
  });
  const adapter = adapterFor(path);
  if (adapter === null) {
    return {
      fileId,
      repoId: input.repoId,
      refId: input.refId,
      path,
      languageId: "unknown",
      contentHash,
      imports: [],
      importsMissingReason: `no language adapter for "${path}"`,
    };
  }
  const source: SourceFile = {
    fileId,
    repoId: input.repoId,
    refId: input.refId,
    path,
    languageId: adapter.languageId,
    content: input.content,
    contentHash,
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
  };
  // Ein geworfener Parserfehler DARF hier nicht stillschweigend zu "diese
  // Datei hat keine Importe" werden — er wird zum benannten
  // `importsMissingReason` und damit zu einem Ledger-Eintrag (E4).
  // WP-216: der GRUND kommt aus `classifyAdapterFailure`, nicht aus
  // `error.message`. Ein durchgereichtes "Invalid argument" sagt niemandem,
  // was zu tun ist.
  let parsed: ParseResult;
  try {
    parsed = adapter.parse(source);
  } catch (error) {
    const failure = classifyAdapterFailure(error, { sizeBytes: source.sizeBytes, path });
    return {
      fileId,
      repoId: input.repoId,
      refId: input.refId,
      path,
      languageId: adapter.languageId,
      contentHash,
      imports: [],
      importsMissingReason: `${failure.kind} (${failure.reason}) for "${path}": ${failure.detail}`,
    };
  }
  if (parsed.ast === null) {
    return {
      fileId,
      repoId: input.repoId,
      refId: input.refId,
      path,
      languageId: adapter.languageId,
      contentHash,
      imports: [],
      importsMissingReason: `parse failed (${parsed.parseQuality}, ${String(parsed.errorNodeCount)} error nodes)`,
    };
  }
  const imports: RawImport[] = adapter.extractImports(parsed.ast);
  return {
    fileId,
    repoId: input.repoId,
    refId: input.refId,
    path,
    languageId: adapter.languageId,
    contentHash,
    imports,
  };
}
