import path from "node:path";

import { boolFlag, stringFlag, type FlagSpecs, type ParsedArgs } from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { EXIT, UsageError } from "../cli/exit.js";
import { note } from "../cli/io.js";
import { loadWorkspace } from "../cli/workspace.js";
import { serveUntangleMcpStdio, type UntangleStdioCloseOutcome } from "../mcp/stdio.js";

const FLAGS: FlagSpecs = {
  stdio: {
    kind: "boolean",
    describe: "Serve MCP over stdin/stdout; stdout contains JSON-RPC only.",
  },
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Workspace starting point and additional path-sandbox root.",
    defaultLabel: "current directory",
  },
};

export const mcpCommand: Command = {
  spec: {
    name: "mcp",
    implementedBy: "commands/mcp.js",
    summary: "Expose Untangle tools as a local MCP stdio server",
    usage: "untangle mcp --stdio [--root=<PATH>]",
    details: [
      "Registers the complete stable MCP v1 tool set. Unimplemented capabilities return FEATURE_UNAVAILABLE rather than invented empty results.",
      "Path parameters are checked against the loaded workspace root and configured repository roots. The server does not launch arbitrary external commands.",
      "stdout is reserved exclusively for the MCP JSON-RPC protocol; diagnostics go to stderr.",
    ],
    flags: FLAGS,
    examples: ["untangle mcp --stdio", "untangle mcp --stdio --root=/path/to/workspace"],
    exitCodes: [
      [EXIT.ok, "The MCP connection closed cleanly."],
      [EXIT.operational, "The MCP transport failed."],
      [EXIT.usage, "--stdio is missing or positional arguments were supplied."],
      [EXIT.cancelled, "SIGINT/SIGTERM stopped the server."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    if (!boolFlag(args, "stdio")) {
      throw new UsageError("The MCP command requires --stdio.", "Run `untangle mcp --stdio`.");
    }
    if (args.positionals.length > 0) {
      throw new UsageError(
        `The MCP command does not accept positional arguments: ${args.positionals.join(" ")}`,
        "Run `untangle mcp --stdio`.",
      );
    }

    const cwd = path.resolve(ctx.cwd, stringFlag(args, "root") ?? ".");
    const workspaceRoots = discoverWorkspaceRoots(cwd, ctx.env);
    const handle = serveUntangleMcpStdio({
      cwd,
      env: ctx.env,
      workspaceRoots,
      onerror: (error) => {
        note(ctx.io, `MCP transport error: ${error.message}`);
      },
    });

    const reason = await waitForConnectionEnd(ctx.signal, handle.closed);
    await handle.close();
    if (reason === "aborted") return EXIT.cancelled;
    if (reason === "transport_error") return EXIT.operational;
    return EXIT.ok;
  },
};

export function discoverWorkspaceRoots(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const roots = new Set<string>([path.resolve(cwd)]);
  try {
    const view = loadWorkspace({ cwd, env, strict: false });
    roots.add(path.resolve(view.root));
    for (const repository of view.config.repositories ?? []) {
      roots.add(path.resolve(repository.path));
    }
  } catch {
    // The runtime reports configuration errors per tool. The server itself
    // still starts, confined to the explicit cwd.
  }
  return [...roots];
}

function waitForConnectionEnd(
  signal: AbortSignal,
  transportClosed: Promise<UntangleStdioCloseOutcome>,
): Promise<"closed" | "aborted" | "transport_error"> {
  if (signal.aborted) return Promise.resolve("aborted");
  if (process.stdin.readableEnded || process.stdin.destroyed) return Promise.resolve("closed");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: "closed" | "aborted" | "transport_error"): void => {
      if (settled) return;
      settled = true;
      process.stdin.off("end", onClosed);
      process.stdin.off("close", onClosed);
      signal.removeEventListener("abort", onAborted);
      resolve(reason);
    };
    const onClosed = (): void => {
      finish("closed");
    };
    const onAborted = (): void => {
      finish("aborted");
    };
    process.stdin.once("end", onClosed);
    process.stdin.once("close", onClosed);
    signal.addEventListener("abort", onAborted, { once: true });
    process.stdin.resume();
    void transportClosed.then((outcome) => {
      finish(outcome.reason === "error" ? "transport_error" : "closed");
    });
  });
}
