import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeProductTests } from "./product-test-runner.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("explicit shell-free product test process", () => {
  it("preserves argv literally, stderr and an actual nonzero exit code", async () => {
    const literal = "$(touch not-created); * && echo bad";
    const result = await executeProductTests({
      root: process.cwd(),
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic'); process.exitCode=3",
        literal,
      ],
      timeoutMs: 3000,
      outputLimitBytes: 1024,
    });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(3);
    expect(Buffer.from(result.stdout).toString()).toBe(literal);
    expect(Buffer.from(result.stderr).toString()).toBe("diagnostic");
  });

  it("returns a real spawn failure with bounded diagnostics", async () => {
    const result = await executeProductTests({
      root: process.cwd(),
      command: ["/nonexistent/untangle-test-runner"],
      timeoutMs: 1000,
      outputLimitBytes: 1024,
    });
    expect(result.status).toBe("spawn_failed");
    expect(result.exitCode).toBeNull();
    expect(result.stderr.byteLength).toBeGreaterThan(0);
  });

  it("bounds output and terminates the actual producer", async () => {
    const result = await executeProductTests({
      root: process.cwd(),
      command: [
        process.execPath,
        "-e",
        "setInterval(() => process.stdout.write('x'.repeat(1024)), 1)",
      ],
      timeoutMs: 3000,
      outputLimitBytes: 128,
    });
    expect(result.status).toBe("output_limit");
    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(128);
  });

  it("cancels an actual process and clears its lifecycle handlers", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const result = await executeProductTests({
      root: process.cwd(),
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 3000,
      outputLimitBytes: 1024,
      signal: controller.signal,
    });
    clearTimeout(timer);
    expect(result.status).toBe("cancelled");
  });

  it.skipIf(process.platform === "win32")(
    "kills a timed-out POSIX process group including a child that ignores SIGTERM",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "untangle-child-tree-"));
      cleanup.push(directory);
      const marker = path.join(directory, "marker");
      const childProgram =
        "process.on('SIGTERM',()=>{}); setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'.'),20)";
      const parentProgram =
        "process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'inherit'}); setInterval(()=>{},1000)";
      const result = await executeProductTests({
        root: process.cwd(),
        command: [process.execPath, "-e", parentProgram, childProgram, marker],
        timeoutMs: 500,
        outputLimitBytes: 1024,
      });
      expect(result.status).toBe("timed_out");
      const final = await readFile(marker, "utf8");
      expect(final.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await readFile(marker, "utf8")).toBe(final);
    },
  );
});
