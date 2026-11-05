import path from "node:path";

import type { HttpBoundaryFileFactsV1 } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";
import { candidatePaths, DEFAULT_EXTENSION_ORDER } from "@untangle-code/file-graph";

import type { ProductInventory } from "../product-alignment/analysis.js";

import type {
  FrontendBoundaryIssueV1,
  FrontendBoundaryReportV1,
  FrontendImportEdgeV1,
} from "./types.js";

const MAX_IMPORT_DEPTH = 4;
const MAX_IMPORT_CONTEXTS = 10_000;

/** File-level imports are context, never proof of a function-level invocation. */
export function frontendImportContext(
  inventory: ProductInventory,
  facts: readonly HttpBoundaryFileFactsV1[],
  requestPaths: readonly string[],
  limit: number,
  signal?: AbortSignal,
): FrontendBoundaryReportV1["importContext"] {
  const accepted = new Map(inventory.files.map((file) => [file.relativePath, file]));
  const edges: FrontendImportEdgeV1[] = [];
  const unresolved: FrontendBoundaryIssueV1[] = [];
  for (const file of facts) {
    signal?.throwIfAborted();
    for (const item of file.imports) {
      if (!item.specifier.startsWith(".")) {
        unresolved.push({
          path: file.path,
          reason: `non_relative_import_not_resolved: ${item.specifier}`,
        });
        continue;
      }
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), item.specifier),
      );
      if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) {
        unresolved.push({ path: file.path, reason: `outside_root_import: ${item.specifier}` });
        continue;
      }
      const target = candidatePaths(base, [...DEFAULT_EXTENSION_ORDER, ".vue"], {
        preferSourceExtension: /\.(?:[cm]?ts|tsx|vue)$/u.test(file.path),
      }).find((candidate) => accepted.has(candidate));
      if (target === undefined) {
        unresolved.push({
          path: file.path,
          reason: `relative_import_target_not_in_scan: ${item.specifier}`,
        });
        continue;
      }
      edges.push({
        fromPath: file.path,
        toPath: target,
        rawSpecifier: item.specifier,
        range: item.range,
        sourceHash: file.contentHash,
        targetHash: accepted.get(target)!.contentHash,
      });
    }
  }
  edges.sort(
    (left, right) =>
      compareCodepoints(left.fromPath, right.fromPath) ||
      compareCodepoints(left.toPath, right.toPath) ||
      left.range.startByte - right.range.startByte,
  );
  unresolved.sort(
    (left, right) =>
      compareCodepoints(left.path, right.path) || compareCodepoints(left.reason, right.reason),
  );
  const incoming = new Map<string, FrontendImportEdgeV1[]>();
  for (const edge of edges) {
    const group = incoming.get(edge.toPath) ?? [];
    group.push(edge);
    incoming.set(edge.toPath, group);
  }
  const requestImporters: FrontendBoundaryReportV1["importContext"]["requestImporters"] = [];
  let depthTruncated = false;
  outer: for (const requestPath of [...new Set(requestPaths)].sort(compareCodepoints)) {
    const visited = new Set([requestPath]);
    const queue: { path: string; via: FrontendImportEdgeV1[] }[] = [{ path: requestPath, via: [] }];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      signal?.throwIfAborted();
      const current = queue[cursor]!;
      for (const edge of incoming.get(current.path) ?? []) {
        if (visited.has(edge.fromPath)) continue;
        if (current.via.length >= MAX_IMPORT_DEPTH) {
          depthTruncated = true;
          continue;
        }
        if (requestImporters.length >= MAX_IMPORT_CONTEXTS) {
          depthTruncated = true;
          break outer;
        }
        visited.add(edge.fromPath);
        const via = [edge, ...current.via];
        requestImporters.push({
          requestPath,
          path: edge.fromPath,
          contentHash: edge.sourceHash,
          distance: via.length,
          via,
        });
        queue.push({ path: edge.fromPath, via });
      }
    }
  }
  return {
    kind: "file-imports-not-function-calls",
    edges,
    requestImporters,
    unresolved,
    summary: {
      edges: edges.length,
      unresolved: unresolved.length,
      requestImporters: requestImporters.length,
    },
    truncated:
      depthTruncated ||
      edges.length > limit ||
      unresolved.length > limit ||
      requestImporters.length > limit,
  };
}
