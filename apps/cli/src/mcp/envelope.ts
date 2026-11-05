import type { ToolResponseEnvelopeV1, ToolWarningV1 } from "@untangle-code/domain";

import type { UntangleMcpToolName } from "./types.js";

export function mcpSuccess(
  operation: UntangleMcpToolName,
  data: unknown,
  options: { workspaceId?: string; warnings?: readonly ToolWarningV1[] } = {},
): ToolResponseEnvelopeV1<unknown> {
  return {
    schemaVersion: 1,
    ok: true,
    operation,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    data,
    warnings: [...(options.warnings ?? [])],
  };
}

export function mcpFailure(
  operation: UntangleMcpToolName,
  code: string,
  message: string,
  retryable: boolean,
  options: {
    workspaceId?: string;
    details?: Record<string, unknown>;
    warnings?: readonly ToolWarningV1[];
  } = {},
): ToolResponseEnvelopeV1<unknown> {
  return {
    schemaVersion: 1,
    ok: false,
    operation,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    warnings: [...(options.warnings ?? [])],
    error: {
      code,
      message,
      retryable,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
}

export function unavailableEnvelope(
  operation: UntangleMcpToolName,
  missingCapability: string,
): ToolResponseEnvelopeV1<unknown> {
  return mcpFailure(
    operation,
    "FEATURE_UNAVAILABLE",
    `The MCP operation "${operation}" is registered but unavailable: ${missingCapability}. No empty success result was fabricated.`,
    false,
    { details: { missingCapability } },
  );
}
