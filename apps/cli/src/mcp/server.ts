import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { CLI_VERSION } from "../cli/version.js";

import { DefaultUntangleMcpRuntime } from "./default-runtime.js";
import { mcpFailure } from "./envelope.js";
import {
  canonicalPotentialPath,
  canonicalizeToolPathsInsideWorkspace,
  InvalidWorkspacePathError,
  PathOutsideWorkspaceError,
} from "./path-sandbox.js";
import { UNTANGLE_MCP_TOOLS, type McpToolDefinition } from "./tools.js";
import {
  UNTANGLE_MCP_TOOL_NAMES,
  type UntangleMcpRuntime,
  type UntangleMcpToolName,
} from "./types.js";

const warningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.json()).optional(),
  })
  .strict();

const toolErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.json()).optional(),
  })
  .strict();

const indexStateSchema = z
  .object({
    generationId: z.string(),
    status: z.string(),
    stale: z.boolean(),
  })
  .strict();

const toolNameSchema = z.enum(UNTANGLE_MCP_TOOL_NAMES);
const successDataSchemas = new Map(
  UNTANGLE_MCP_TOOLS.map((definition) => [definition.name, definition.successDataSchema] as const),
);

const knownSuccessEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    operation: toolNameSchema,
    workspaceId: z.string().optional(),
    data: z.unknown(),
    warnings: z.array(warningSchema),
    indexState: indexStateSchema.optional(),
  })
  .strict()
  .superRefine((envelope, context) => {
    const schema = successDataSchemas.get(envelope.operation);
    const parsed = schema?.safeParse(envelope.data);
    if (parsed?.success === true) return;
    context.addIssue({
      code: "custom",
      path: ["data"],
      message: `Data does not match the success contract for ${envelope.operation}.`,
    });
  });

/** The wire contract from spec.md section 21.2. */
export const toolResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  knownSuccessEnvelopeSchema,
  z
    .object({
      schemaVersion: z.literal(1),
      ok: z.literal(false),
      operation: toolNameSchema,
      workspaceId: z.string().optional(),
      warnings: z.array(warningSchema),
      error: toolErrorSchema,
      indexState: indexStateSchema.optional(),
    })
    .strict(),
]);

export interface CreateUntangleMcpServerOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runtime?: UntangleMcpRuntime;
  /** Canonical containment roots. An omitted/empty list is restricted to cwd. */
  readonly workspaceRoots?: readonly string[];
}

/**
 * Creates one transport-neutral server instance. The public CLI package owns
 * this runtime so programmatic and binary consumers cannot drift apart.
 */
export function createUntangleMcpServer(options: CreateUntangleMcpServerOptions = {}): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? new DefaultUntangleMcpRuntime();
  const configuredRoots = options.workspaceRoots ?? [];
  const workspaceRoots = uniqueCanonicalRoots(
    configuredRoots.length === 0 ? [cwd] : configuredRoots,
  );
  const server = new McpServer(
    { name: "untangle", version: CLI_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const definition of UNTANGLE_MCP_TOOLS) {
    const outputSchema = outputEnvelopeSchema(definition);
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        // The SDK normally turns validation failures into a text-only tool
        // error before our handler runs. Advertise the exact schema, but let
        // this boundary validate manually so EVERY tool result still carries
        // the normative §21.2 envelope.
        inputSchema: advertiseSchemaWithoutPrevalidation(definition.inputSchema),
        outputSchema,
      },
      async (input, requestContext): Promise<CallToolResult> => {
        return executeMcpToolInvocation(definition, input, {
          cwd,
          env,
          runtime,
          workspaceRoots,
          signal: requestContext.mcpReq.signal,
        });
      },
    );
  }

  return server;
}

interface ExecuteMcpToolInvocationOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: UntangleMcpRuntime;
  readonly workspaceRoots: readonly string[];
  readonly signal: AbortSignal;
}

/**
 * One testable invocation boundary. Keeping cancellation here means an
 * already-aborted request never reaches a storage adapter or mutating use case.
 */
export async function executeMcpToolInvocation(
  definition: McpToolDefinition,
  input: unknown,
  options: ExecuteMcpToolInvocationOptions,
): Promise<CallToolResult> {
  let envelope;
  try {
    if (options.signal.aborted) {
      envelope = mcpFailure(
        definition.name,
        "CANCELLED",
        "The MCP operation was cancelled.",
        false,
      );
      return toCallToolResult(definition, envelope);
    }
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      envelope = mcpFailure(
        definition.name,
        "INVALID_ARGUMENT",
        `Invalid arguments for MCP tool "${definition.name}".`,
        false,
        { details: { issues: publicZodIssues(parsed.error) } },
      );
      return toCallToolResult(definition, envelope);
    }
    const canonicalInput = canonicalizeToolPathsInsideWorkspace(
      parsed.data,
      definition.pathFields,
      {
        cwd: options.cwd,
        workspaceRoots: options.workspaceRoots,
      },
    );
    if (options.signal.aborted) {
      envelope = mcpFailure(
        definition.name,
        "CANCELLED",
        "The MCP operation was cancelled.",
        false,
      );
      return toCallToolResult(definition, envelope);
    }
    envelope = await options.runtime.invoke(definition.name, canonicalInput, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
    });
    if (options.signal.aborted) {
      envelope = mcpFailure(
        definition.name,
        "CANCELLED",
        "The MCP operation was cancelled.",
        false,
      );
    }
  } catch (error) {
    envelope = options.signal.aborted
      ? mcpFailure(definition.name, "CANCELLED", "The MCP operation was cancelled.", false)
      : serverFailure(definition.name, error);
  }
  return toCallToolResult(definition, envelope);
}

/**
 * Keeps the advertised JSON Schema byte-for-byte equivalent to the Zod
 * schema while deferring validation to our envelope-producing handler.
 */
function advertiseSchemaWithoutPrevalidation(
  schema: z.ZodType<Record<string, unknown>>,
): z.ZodType<Record<string, unknown>> {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => ({ value }),
    },
  } as unknown as z.ZodType<Record<string, unknown>>;
}

function outputEnvelopeSchema(definition: McpToolDefinition) {
  return z.discriminatedUnion("ok", [
    z
      .object({
        schemaVersion: z.literal(1),
        ok: z.literal(true),
        operation: z.literal(definition.name),
        workspaceId: z.string().optional(),
        data: definition.successDataSchema,
        warnings: z.array(warningSchema),
        indexState: indexStateSchema.optional(),
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        ok: z.literal(false),
        operation: z.literal(definition.name),
        workspaceId: z.string().optional(),
        warnings: z.array(warningSchema),
        error: toolErrorSchema,
        indexState: indexStateSchema.optional(),
      })
      .strict(),
  ]);
}

function publicZodIssues(error: z.ZodError): Array<{
  code: string;
  path: string;
  message: string;
}> {
  return error.issues.slice(0, 32).map((issue) => ({
    code: issue.code,
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

function toCallToolResult(definition: McpToolDefinition, value: unknown): CallToolResult {
  const operation = definition.name;
  let envelope;
  try {
    const parsed = toolResponseEnvelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.operation !== operation) {
      envelope = invalidRuntimeEnvelope(
        operation,
        parsed.success ? "operation mismatch" : "schema mismatch",
      );
    } else if (parsed.data.ok) {
      const data = definition.successDataSchema.safeParse(parsed.data.data);
      envelope = data.success
        ? { ...parsed.data, data: data.data }
        : invalidRuntimeEnvelope(operation, "success data schema mismatch");
    } else {
      envelope = parsed.data;
    }
    const structuredContent = jsonObject(envelope);
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: !envelope.ok,
    };
  } catch {
    envelope = invalidRuntimeEnvelope(operation, "response was not JSON serializable");
    const structuredContent = jsonObject(envelope);
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    };
  }
}

function invalidRuntimeEnvelope(
  operation: UntangleMcpToolName,
  reason: string,
): ReturnType<typeof mcpFailure> {
  return mcpFailure(
    operation,
    "INVALID_INTERNAL_OUTPUT",
    `The MCP runtime returned an invalid response envelope (${reason}).`,
    false,
  );
}

function serverFailure(operation: UntangleMcpToolName, error: unknown) {
  if (error instanceof PathOutsideWorkspaceError) {
    return mcpFailure(operation, "PATH_OUTSIDE_WORKSPACE", error.message, false, {
      details: { requestedPath: error.requestedPath },
    });
  }
  if (error instanceof InvalidWorkspacePathError) {
    return mcpFailure(operation, "INVALID_ARGUMENT", error.message, false, {
      details: { requestedPath: error.requestedPath },
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return mcpFailure(operation, "CANCELLED", "The MCP operation was cancelled.", false);
  }
  return mcpFailure(
    operation,
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
    false,
  );
}

function uniqueCanonicalRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map(canonicalPotentialPath))];
}

/** Makes the JSON boundary explicit and rejects accidental non-JSON values. */
function jsonObject(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("The MCP response is not JSON serializable.");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("The MCP response envelope must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
