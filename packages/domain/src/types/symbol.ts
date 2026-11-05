/**
 * Symbol records and call edges (architecture.md §10.4; spec.md §15.1–§15.2).
 */
import type { CallConfidence, SourceRange } from "./common.js";

/** Persisted symbol record used for identity and change matching (architecture.md §10.4). */
export interface SymbolRecordV1 {
  symbolId: string;
  repoId: string;
  refId: string;
  fileId: string;
  /** "/"-normalized path relative to the repository root. */
  path: string;
  name: string;
  qualifiedName: string;
  /** Language-adapter symbol kind, e.g. "function", "class", "method". */
  kind: string;
  /** Signature normalized for identity (whitespace/parameter-name insensitive). */
  normalizedSignature: string;
  range: SourceRange;
  /** Fingerprint of the symbol's AST shape (change matching, spec.md §17.3). */
  astHash: string;
  /** Token-level fingerprint (MinHash or similar; change matching, spec.md §17.3). */
  tokenFingerprint: string;
  exportedNames: string[];
  visibility?: string;
}

/** Symbol graph node (spec.md §15.1). */
export interface SymbolNodeV1 {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  signature?: string;
  repoId: string;
  refId: string;
  fileId: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  exportedAs?: string[];
  visibility?: string;
  contentHash: string;
}

/** Call edge in the symbol graph (spec.md §15.2). */
export interface CallEdgeV1 {
  callerId: string;
  calleeName: string;
  /** Symbol ids of compatible resolution candidates. */
  calleeCandidates: string[];
  /**
   * Resolution confidence (architecture.md §17.2). `ambiguous` edges must
   * never be treated as certain.
   */
  confidence: CallConfidence;
  callSite: {
    repoId: string;
    refId: string;
    filePath: string;
    line: number;
    column?: number;
  };
}
