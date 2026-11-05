import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

interface Artifact {
  tarball: string;
  manifest: {
    name: string;
    version: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}
interface SmokeModule {
  parseOptions(args: string[]): { json: boolean; packageManagers: string[]; outDir?: string };
  orderReleasePackages(artifacts: Artifact[]): Artifact[];
  startReleaseRegistry(artifacts: Artifact[]): Promise<{ origin: string; close(): Promise<void> }>;
  validateDependencyTree(tree: unknown, expected: { name: string; version: string }[]): string[];
  writeVerifiedBundle(
    outDir: string,
    artifacts: Artifact[],
    report: unknown,
    renameDirectory?: (source: string, destination: string) => void,
  ): void;
  runOwnedCommand(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs: number;
    },
  ): Promise<{ stdout: string; exitCode: number }>;
  runExpectedCommand(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs: number;
    },
    expectedExit?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  validateProductionSbom(
    content: string,
    packages: { name: string; version: string }[],
  ): { specVersion: string; componentCount: number };
}
// A URL import keeps the script runnable directly and avoids adding a test-only declaration file.
const smoke = (await import(
  pathToFileURL(path.resolve("scripts/release-smoke.mjs")).href
)) as SmokeModule;
const productConsumer = (await import(
  pathToFileURL(path.resolve("scripts/release-product-consumer.mjs")).href
)) as {
  fixtureTestIdentities(execution: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }): { path: string; name: string; status: string }[];
  assertConsumerPath(consumerRoot: string, target: string): string;
};
const ownedDirectories: string[] = [];
function ownedDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "untangle-release-test-"));
  ownedDirectories.push(directory);
  return directory;
}
function artifact(name: string, dependencies?: Record<string, string>): Artifact {
  return {
    tarball: path.join(ownedDirectory(), `${name.slice(name.lastIndexOf("/") + 1)}.tgz`),
    manifest: { name, version: "0.1.0", ...(dependencies ? { dependencies } : {}) },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of ownedDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("release candidate dependency contract", () => {
  it("defaults to both real production installers and rejects unexpected arguments", () => {
    expect(smoke.parseOptions([]).packageManagers).toEqual(["npm", "pnpm"]);
    expect(smoke.parseOptions(["--package-manager=npm", "--json"])).toMatchObject({
      packageManagers: ["npm"],
      json: true,
    });
    expect(() => smoke.parseOptions(["--package-manager=yarn"])).toThrow("Unknown package manager");
    expect(() => smoke.parseOptions(["--out-dir="])).toThrow("new directory");
    expect(() => smoke.parseOptions(["--ignore-errors"])).toThrow("Unknown option");
  });
  it("orders prerequisites before their consumers without changing packed manifests", () => {
    const domain = artifact("@untangle-code/domain");
    const core = artifact("@untangle-code/core", { "@untangle-code/domain": "0.1.0" });
    const cli = artifact("@untangle-code/cli", { "@untangle-code/core": "0.1.0", zod: "4.5.4" });
    const before = JSON.stringify([cli, core, domain]);
    expect(
      smoke.orderReleasePackages([cli, core, domain]).map((entry) => entry.manifest.name),
    ).toEqual([domain.manifest.name, core.manifest.name, cli.manifest.name]);
    expect(JSON.stringify([cli, core, domain])).toBe(before);
  });
  it.each(["workspace:*", "^0.1.0", "0.2.0"])("rejects non-exact internal edge %s", (spec) => {
    const domain = artifact("@untangle-code/domain");
    const cli = artifact("@untangle-code/cli", { "@untangle-code/domain": spec });
    expect(() => smoke.orderReleasePackages([cli, domain])).toThrow(
      /workspace|exact packed version/,
    );
  });
  it("rejects absent private dependencies, duplicate packages and cycles", () => {
    const cli = artifact("@untangle-code/cli", { "@untangle-code/testkit": "0.1.0" });
    expect(() => smoke.orderReleasePackages([cli])).toThrow("Missing public release dependency");
    expect(() => smoke.orderReleasePackages([cli, cli])).toThrow("Duplicate release package");
    const a = artifact("@untangle-code/a", { "@untangle-code/b": "0.1.0" });
    const b = artifact("@untangle-code/b", { "@untangle-code/a": "0.1.0" });
    expect(() => smoke.orderReleasePackages([a, b])).toThrow("cycle");
    b.manifest.private = true;
    expect(() => smoke.orderReleasePackages([a, b])).toThrow("private release");
  });
  it("checks optional and peer internal edges as well as direct dependencies", () => {
    const cli = artifact("@untangle-code/cli");
    cli.manifest.peerDependencies = { "@untangle-code/domain": "^0.1.0" };
    expect(() => smoke.orderReleasePackages([cli, artifact("@untangle-code/domain")])).toThrow(
      "exact packed version",
    );
    cli.manifest.peerDependencies = {};
    cli.manifest.optionalDependencies = { "@untangle-code/missing": "0.1.0" };
    expect(() => smoke.orderReleasePackages([cli])).toThrow("Missing public release dependency");
  });
  it("rejects a wrong nested internal version even when the root version matches", () => {
    const expected = [
      { name: "@untangle-code/cli", version: "0.1.0" },
      { name: "@untangle-code/domain", version: "0.1.0" },
    ];
    const tree = {
      dependencies: {
        "@untangle-code/cli": {
          version: "0.1.0",
          dependencies: { "@untangle-code/domain": { version: "0.1.0" } },
        },
      },
    };
    expect(smoke.validateDependencyTree(tree, expected)).toEqual([
      "@untangle-code/cli",
      "@untangle-code/domain",
    ]);
    tree.dependencies["@untangle-code/cli"].dependencies["@untangle-code/domain"].version = "0.2.0";
    expect(() => smoke.validateDependencyTree([tree], expected)).toThrow("unexpected");
    expect(() => smoke.validateDependencyTree({}, expected)).toThrow("missing");
  });
});

describe("original tarball registry and verified bundle", () => {
  it("serves original bytes with matching integrity and the exact packed dependency manifest", async () => {
    const cli = artifact("@untangle-code/cli", { zod: "4.5.4" });
    const bytes = Buffer.from("these stand in for original packed bytes");
    writeFileSync(cli.tarball, bytes);
    const registry = await smoke.startReleaseRegistry([cli]);
    try {
      const response = await fetch(`${registry.origin}/@untangle-code%2fcli`);
      const metadata = (await response.json()) as {
        versions: Record<
          string,
          { dependencies: object; dist: { tarball: string; integrity: string } }
        >;
      };
      const packed = metadata.versions["0.1.0"];
      expect(packed?.dependencies).toEqual(cli.manifest.dependencies);
      expect(packed?.dist.integrity).toBe(
        `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      );
      expect(Buffer.from(await (await fetch(packed!.dist.tarball)).arrayBuffer())).toEqual(bytes);
      expect((await fetch(`${registry.origin}/@untangle-code%2fmissing`)).status).toBe(404);
      expect(
        (await fetch(`${registry.origin}/@untangle-code%2fcli`, { method: "POST" })).status,
      ).toBe(405);
    } finally {
      await registry.close();
    }
    await expect(fetch(`${registry.origin}/@untangle-code%2fcli`)).rejects.toThrow();
  });
  it("preserves existing output paths and removes its staging directory on a hash mismatch", () => {
    const root = ownedDirectory();
    const cli = artifact("@untangle-code/cli");
    writeFileSync(cli.tarball, "candidate bytes");
    const outDir = path.join(root, "candidate");
    expect(() =>
      smoke.writeVerifiedBundle(outDir, [cli], { packages: [{ sha256: "wrong" }] }),
    ).toThrow("changed");
    expect(existsSync(outDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(outDir, "foreign file");
    expect(() => smoke.parseOptions([`--out-dir=${outDir}`])).toThrow("already exists");
    expect(() => smoke.writeVerifiedBundle(outDir, [cli], {})).toThrow("already exists");
    expect(readFileSync(outDir, "utf8")).toBe("foreign file");
  });
  it("removes only its empty output reservation when the final rename fails", () => {
    const root = ownedDirectory();
    const cli = artifact("@untangle-code/cli");
    const bytes = Buffer.from("candidate bytes");
    writeFileSync(cli.tarball, bytes);
    const report = {
      verified: true,
      packages: [{ sha256: createHash("sha256").update(bytes).digest("hex") }],
    };
    const outDir = path.join(root, "candidate");
    const injectedFailure = new Error("injected rename failure");
    expect(() =>
      smoke.writeVerifiedBundle(outDir, [cli], report, () => {
        throw injectedFailure;
      }),
    ).toThrow(injectedFailure);
    expect(existsSync(outDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
  it("keeps foreign contents added to its reservation on rename failure", () => {
    const root = ownedDirectory();
    const cli = artifact("@untangle-code/cli");
    const bytes = Buffer.from("candidate bytes");
    writeFileSync(cli.tarball, bytes);
    const report = {
      verified: true,
      packages: [{ sha256: createHash("sha256").update(bytes).digest("hex") }],
    };
    const outDir = path.join(root, "candidate");
    expect(() =>
      smoke.writeVerifiedBundle(outDir, [cli], report, (_source, destination) => {
        writeFileSync(path.join(destination, "foreign.txt"), "keep me");
        throw new Error("injected rename failure");
      }),
    ).toThrow("injected rename failure");
    expect(readFileSync(path.join(outDir, "foreign.txt"), "utf8")).toBe("keep me");
    expect(readdirSync(root)).toEqual(["candidate"]);
  });
  it("retains checked original bytes, checksums, package order and verification report", () => {
    const root = ownedDirectory();
    const cli = artifact("@untangle-code/cli");
    const bytes = Buffer.from("candidate bytes");
    writeFileSync(cli.tarball, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const report = {
      verified: true,
      packages: [{ name: cli.manifest.name, version: "0.1.0", sha256 }],
    };
    const outDir = path.join(root, "candidate");
    smoke.writeVerifiedBundle(outDir, [cli], report);
    expect(readFileSync(path.join(outDir, "tarballs", "cli.tgz"))).toEqual(bytes);
    expect(readFileSync(path.join(outDir, "SHA256SUMS"), "utf8")).toBe(
      `${sha256}  tarballs/cli.tgz\n`,
    );
    expect(JSON.parse(readFileSync(path.join(outDir, "release-report.json"), "utf8"))).toEqual(
      report,
    );
    expect(JSON.parse(readFileSync(path.join(outDir, "publish-order.json"), "utf8"))).toEqual([
      { name: cli.manifest.name, version: "0.1.0", file: "tarballs/cli.tgz" },
    ]);
    expect(readdirSync(root)).toEqual(["candidate"]);
  });
});

describe("owned subprocess lifecycle", () => {
  it("propagates command failures and enforces a timeout", async () => {
    const options = { cwd: ownedDirectory(), env: process.env, timeoutMs: 100 };
    await expect(
      smoke.runOwnedCommand(
        process.execPath,
        ["-e", "console.error('bad install');process.exit(7)"],
        { ...options, timeoutMs: 2_000 },
      ),
    ).rejects.toThrow("bad install");
    await expect(
      smoke.runOwnedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], options),
    ).rejects.toThrow("exceeded");
  });
  it("keeps the timeout reason when macOS denies the post-kill signal-zero probe", async () => {
    const actualKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("signal-zero denied"), { code: "EPERM" });
      return actualKill(pid, signal);
    });
    await expect(
      smoke.runOwnedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: ownedDirectory(),
        env: process.env,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("exceeded 100ms");
    expect(kill.mock.calls.some(([, signal]) => signal === 0)).toBe(true);
    expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(true);
  });
  it("cancels only the process it owns and leaves a separate process alive", async () => {
    const controller = new AbortController();
    const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      const completion = smoke.runOwnedCommand(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { cwd: ownedDirectory(), env: process.env, signal: controller.signal, timeoutMs: 2_000 },
      );
      controller.abort(new Error("owned cancellation"));
      await expect(completion).rejects.toThrow("owned cancellation");
      expect(foreign.exitCode).toBeNull();
      expect(foreign.signalCode).toBeNull();
    } finally {
      const closed = new Promise<void>((resolve) => foreign.once("close", () => resolve()));
      foreign.kill();
      await closed;
    }
  });
  it("waits for a SIGTERM-ignoring grandchild after its parent closes early", async () => {
    const root = ownedDirectory();
    const readyPath = path.join(root, "grandchild-ready.json");
    const descendantCode = `const fs = require('node:fs');
const server = require('node:http').createServer((_request, response) => response.end('alive'));
process.on('SIGTERM', () => {});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({port: server.address().port, pid: process.pid})));`;
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio: 'ignore'}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const completion = smoke.runOwnedCommand(process.execPath, ["-e", parentCode], {
      cwd: root,
      env: process.env,
      signal: controller.signal,
      timeoutMs: 8_000,
    });
    try {
      const started = performance.now();
      while (!existsSync(readyPath)) {
        if (performance.now() - started > 3_000) throw new Error("Grandchild did not start.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const { port } = JSON.parse(readFileSync(readyPath, "utf8")) as { port: number };
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("alive");
      controller.abort(new Error("owned group cancellation"));
      await expect(completion).rejects.toThrow("owned group cancellation");
      await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    } finally {
      controller.abort(new Error("test cleanup"));
      await completion.catch(() => {});
    }
  }, 12_000);
});

describe("installed product fixture evidence", () => {
  const tap =
    "TAP version 13\nok 1 - positive\nok 2 - nonpositive\nok 3 - invalid\n1..3\n# tests 3\n# pass 3\n# fail 0\n";

  it("extracts only the three actually passed case identities from real TAP output", () => {
    expect(productConsumer.fixtureTestIdentities({ exitCode: 0, stdout: tap, stderr: "" })).toEqual(
      [
        { path: "main.test.js", name: "positive", status: "passed" },
        { path: "main.test.js", name: "nonpositive", status: "passed" },
        { path: "main.test.js", name: "invalid", status: "passed" },
      ],
    );
  });

  it.each([
    { label: "failed case", stdout: tap.replace("ok 3 - invalid", "not ok 3 - invalid") },
    { label: "skipped case", stdout: tap.replace("ok 3 - invalid", "ok 3 - invalid # SKIP") },
    { label: "missing case", stdout: tap.replace("ok 3 - invalid\n", "") },
    { label: "duplicate case", stdout: tap.replace("ok 3 - invalid", "ok 3 - positive") },
    { label: "extra case", stdout: tap.replace("1..3", "ok 4 - extra\n1..4") },
  ])("does not synthesize passing evidence from a $label", ({ stdout }) => {
    expect(() =>
      productConsumer.fixtureTestIdentities({ exitCode: 0, stdout, stderr: "" }),
    ).toThrow();
  });

  it("rejects a nonzero runner exit or runner stderr despite passing-looking TAP", () => {
    expect(() =>
      productConsumer.fixtureTestIdentities({ exitCode: 1, stdout: tap, stderr: "" }),
    ).toThrow();
    expect(() =>
      productConsumer.fixtureTestIdentities({ exitCode: 0, stdout: tap, stderr: "runner warning" }),
    ).toThrow();
  });

  it("rejects installed entrypoints outside the isolated consumer, including neighboring prefixes", () => {
    const root = ownedDirectory();
    const target = path.join(root, "node_modules", "core", "index.js");
    expect(productConsumer.assertConsumerPath(root, target)).toBe(
      path.join("node_modules", "core", "index.js"),
    );
    expect(() => productConsumer.assertConsumerPath(root, path.dirname(root))).toThrow("escapes");
    expect(() => productConsumer.assertConsumerPath(root, `${root}-neighbor/index.js`)).toThrow(
      "escapes",
    );
  });

  it("retains gate-failure output only for the explicitly expected exit code", async () => {
    const options = { cwd: ownedDirectory(), env: process.env, timeoutMs: 2_000 };
    const result = await smoke.runExpectedCommand(
      process.execPath,
      ["-e", "console.log(JSON.stringify({status:'needs_review'}));process.exit(5)"],
      options,
      5,
    );
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ status: "needs_review" });
    await expect(
      smoke.runExpectedCommand(process.execPath, ["-e", "process.exit(2)"], options, 5),
    ).rejects.toThrow();
  });

  it("preserves owned-command cancellation and deadline failure for expected-exit probes", async () => {
    const controller = new AbortController();
    const reason = new Error("product probe cancellation");
    const options = { cwd: ownedDirectory(), env: process.env, timeoutMs: 2_000 };
    const pending = smoke.runExpectedCommand(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { ...options, signal: controller.signal },
      5,
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(
      smoke.runExpectedCommand(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { ...options, timeoutMs: 100 },
        5,
      ),
    ).rejects.toThrow("exceeded 100ms");
  });
});

describe("production CycloneDX SBOM and exact candidate binding", () => {
  const packages = [{ name: "@untangle-code/cli", version: "0.1.0" }];
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    components: [
      { group: "@untangle-code", name: "cli", version: "0.1.0", type: "library" },
      { name: "zod", version: "4.5.4", type: "library" },
    ],
  };

  it("checks the actual generated components and exact internal versions", () => {
    expect(smoke.validateProductionSbom(JSON.stringify(document), packages)).toEqual({
      specVersion: "1.5",
      componentCount: 2,
    });
    expect(() => smoke.validateProductionSbom("not JSON", packages)).toThrow();
    expect(() =>
      smoke.validateProductionSbom(JSON.stringify({ ...document, bomFormat: "other" }), packages),
    ).toThrow("CycloneDX");
    expect(() =>
      smoke.validateProductionSbom(JSON.stringify({ ...document, components: [] }), packages),
    ).toThrow("missing");
    expect(() =>
      smoke.validateProductionSbom(
        JSON.stringify({
          ...document,
          components: [{ group: "@untangle-code", name: "cli", version: "0.2.0" }],
        }),
        packages,
      ),
    ).toThrow("unexpected version");
  });

  it("rejects a pnpm-only bundle instead of inventing an npm-consumer SBOM", () => {
    expect(() =>
      smoke.parseOptions([
        "--package-manager=pnpm",
        `--out-dir=${path.join(ownedDirectory(), "candidate")}`,
      ]),
    ).toThrow("npm consumer");
    expect(smoke.parseOptions(["--package-manager=pnpm"]).packageManagers).toEqual(["pnpm"]);
  });

  it("writes unchanged SBOM bytes with a checksum bound to the verification report", () => {
    const root = ownedDirectory();
    const cli = artifact("@untangle-code/cli");
    const bytes = Buffer.from("candidate bytes");
    writeFileSync(cli.tarball, bytes);
    const content = JSON.stringify(document, null, 2) + "\n";
    const sbomSha = createHash("sha256").update(content).digest("hex");
    const packageSha = createHash("sha256").update(bytes).digest("hex");
    const report = {
      verified: true,
      packages: [{ ...packages[0], sha256: packageSha }],
      sbom: {
        file: "sbom.cdx.json",
        format: "CycloneDX",
        specVersion: "1.5",
        componentCount: 2,
        sha256: sbomSha,
        bytes: Buffer.byteLength(content),
        content,
      },
    };
    const outDir = path.join(root, "candidate");
    smoke.writeVerifiedBundle(outDir, [cli], report);
    expect(readFileSync(path.join(outDir, "sbom.cdx.json"), "utf8")).toBe(content);
    expect(readFileSync(path.join(outDir, "SHA256SUMS"), "utf8")).toBe(
      `${packageSha}  tarballs/cli.tgz\n${sbomSha}  sbom.cdx.json\n`,
    );
    expect(JSON.parse(readFileSync(path.join(outDir, "release-report.json"), "utf8"))).toEqual(
      report,
    );
  });

  it("refuses a modified SBOM and removes only its owned staging directory", () => {
    const root = ownedDirectory();
    const cli = artifact("@untangle-code/cli");
    const bytes = Buffer.from("candidate bytes");
    writeFileSync(cli.tarball, bytes);
    const content = JSON.stringify(document);
    const outDir = path.join(root, "candidate");
    expect(() =>
      smoke.writeVerifiedBundle(outDir, [cli], {
        packages: [{ ...packages[0], sha256: createHash("sha256").update(bytes).digest("hex") }],
        sbom: {
          file: "sbom.cdx.json",
          format: "CycloneDX",
          content,
          bytes: Buffer.byteLength(content),
          sha256: "wrong",
        },
      }),
    ).toThrow("SBOM changed");
    expect(existsSync(outDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
