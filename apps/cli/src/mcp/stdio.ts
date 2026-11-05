import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import { createUntangleMcpServer, type CreateUntangleMcpServerOptions } from "./server.js";

export interface ServeUntangleMcpStdioOptions extends CreateUntangleMcpServerOptions {
  readonly onerror?: (error: Error) => void;
  /** Injection seam for lifecycle tests and non-process stdio bindings. */
  readonly transport?: StdioServerTransport;
}

export type UntangleStdioCloseOutcome =
  { readonly reason: "closed" } | { readonly reason: "error"; readonly error: Error };

export interface UntangleStdioServerHandle extends StdioServerHandle {
  /** Settles when the owned wire transport actually closes. */
  readonly closed: Promise<UntangleStdioCloseOutcome>;
}

/** Starts the dual-era MCP stdio binding. stdout remains JSON-RPC only. */
export function serveUntangleMcpStdio(
  options: ServeUntangleMcpStdioOptions = {},
): UntangleStdioServerHandle {
  const transport = options.transport ?? new StdioServerTransport();
  let pendingTransportError: Error | undefined;
  let closingFromHandle = false;
  let settleClosed!: (outcome: UntangleStdioCloseOutcome) => void;
  let didSettle = false;
  const closed = new Promise<UntangleStdioCloseOutcome>((resolve) => {
    settleClosed = (outcome) => {
      if (didSettle) return;
      didSettle = true;
      resolve(outcome);
    };
  });

  // The upstream handle exposes close(), but not the wire's close event. A
  // fatal buffer/stdout failure calls transport.close() while stdin may stay
  // open; intercepting that actual close gives the CLI a lifecycle signal.
  // Recoverable protocol errors only call onerror and therefore do not end
  // this promise.
  const closeTransport = transport.close.bind(transport);
  const startTransport = transport.start.bind(transport);
  transport.start = async (): Promise<void> => {
    try {
      await startTransport();
    } catch (error) {
      settleClosed({
        reason: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  };
  transport.close = async (): Promise<void> => {
    const fatalError = closingFromHandle ? undefined : pendingTransportError;
    try {
      await closeTransport();
    } finally {
      settleClosed(
        fatalError === undefined ? { reason: "closed" } : { reason: "error", error: fatalError },
      );
    }
  };

  const handle = serveStdio(() => createUntangleMcpServer(options), {
    legacy: "serve",
    transport,
    onerror: (error) => {
      pendingTransportError = error;
      queueMicrotask(() => {
        if (pendingTransportError === error) pendingTransportError = undefined;
      });
      options.onerror?.(error);
    },
  });

  return {
    closed,
    async close(): Promise<void> {
      closingFromHandle = true;
      try {
        await handle.close();
      } finally {
        settleClosed({ reason: "closed" });
      }
    },
  };
}
