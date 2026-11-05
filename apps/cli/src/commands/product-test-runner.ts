import { spawn } from "node:child_process";

import type { ProductTestProcessRequestV1, ProductTestProcessResultV1 } from "@untangle-code/core";

/** Host-only subprocess adapter. Never invoke a shell or infer a repository test command. */
export function executeProductTests(
  request: ProductTestProcessRequestV1,
): Promise<ProductTestProcessResultV1> {
  request.signal?.throwIfAborted();
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let status: ProductTestProcessResultV1["status"] = "completed";
    const child = spawn(request.command[0]!, request.command.slice(1), {
      cwd: request.root,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") {
          const terminator = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            shell: false,
            windowsHide: true,
          });
          terminator.on("error", () => {
            child.kill(signal);
          });
        } else process.kill(-child.pid, signal);
      } catch {
        /* An already exited process group requires no further action. */
      }
    };
    const stop = (reason: ProductTestProcessResultV1["status"]): void => {
      if (status !== "completed") return;
      status = reason;
      killTree("SIGTERM");
      forceKill = setTimeout(() => killTree("SIGKILL"), 250);
    };
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      const available = request.outputLimitBytes - captured;
      if (available > 0) chunks.push(chunk.subarray(0, available));
      captured += chunk.byteLength;
      if (captured > request.outputLimitBytes) stop("output_limit");
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const timeout = setTimeout(() => stop("timed_out"), request.timeoutMs);
    const abort = (): void => stop("cancelled");
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) abort();
    child.on("error", (error) => {
      if (status === "completed") status = "spawn_failed";
      capture(stderr, Buffer.from(error.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      killTree("SIGKILL");
      if (forceKill !== undefined) {
        // Reap descendants even if the direct child closed its streams first.
        killTree("SIGKILL");
        clearTimeout(forceKill);
      }
      request.signal?.removeEventListener("abort", abort);
      resolve({
        status: code === null && status === "completed" ? "spawn_failed" : status,
        exitCode: status === "spawn_failed" ? null : code,
        ...(signal === null ? {} : { terminationSignal: signal }),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}
