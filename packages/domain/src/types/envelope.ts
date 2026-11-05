/**
 * MCP tool response envelope (spec.md §21.2).
 */

/** Structured warning inside a tool response (shape: Untangle decision). */
export interface ToolWarningV1 {
  /** Stable warning code, e.g. "PROFILE_SEPARATION", "REPO_UNAVAILABLE". */
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Tool response envelope (spec.md §21.2) — exact spec shape. */
export interface ToolResponseEnvelopeV1<T> {
  schemaVersion: 1;
  ok: boolean;
  operation: string;
  workspaceId?: string;
  data?: T;
  warnings: ToolWarningV1[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  indexState?: {
    generationId: string;
    status: string;
    stale: boolean;
  };
}
