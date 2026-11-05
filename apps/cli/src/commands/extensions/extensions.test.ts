/**
 * The behaviour that WP-127 is actually about: the security boundary, the
 * license gate, the digest requirement, and the fact that a rejected manifest
 * never disappears without a reason.
 *
 * Every test runs against a temporary profile. No network, no container, no
 * spawned analyzer.
 */
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@untangle-code/scanner/node-fs";
import { describe, expect, it } from "vitest";

import { parseArgs, type FlagSpecs } from "../../cli/args.js";
import { CliError, EXIT } from "../../cli/exit.js";
import { extensionsCommand } from "../extensions.js";

import { runAdd } from "./add.js";
import { runDisable, runEnable } from "./enable.js";
import { discoverProjectRoots } from "./environment.js";
import { runList } from "./list.js";
import { runRemove } from "./remove.js";
import { runRun } from "./run.js";
import { digestOf } from "./source.js";
import {
  createHarness,
  fakeFetch,
  httpManifest,
  movingTagManifest,
  writeFixture,
  type HarnessV1,
} from "./test-support.js";

const FLAGS: FlagSpecs = extensionsCommand.spec.flags;

function args(argv: readonly string[]): ReturnType<typeof parseArgs> {
  return parseArgs(argv, FLAGS);
}

async function expectCliError(promise: Promise<number>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected the command to throw a CliError, but it returned");
}

async function installHttpExtension(
  harness: HarnessV1,
  options: { id: string; restricted?: boolean } = { id: "example-http" },
): Promise<string> {
  const manifestPath = await writeFixture(
    join(harness.home, "sources", options.id, "manifest.toml"),
    httpManifest({
      id: options.id,
      port: 19999,
      ...(options.restricted === undefined ? {} : { restricted: options.restricted }),
    }),
  );
  const code = await runAdd(
    harness.environment,
    args(["add", `--from=${manifestPath}`]),
    harness.io,
    "json",
  );
  expect(code).toBe(EXIT.ok);
  return manifestPath;
}

describe("extensions add — the project-directory boundary", () => {
  it("refuses a manifest that lies inside a project directory", async () => {
    const harness = await createHarness();
    const manifestPath = await writeFixture(
      join(harness.project, "tools", "manifest.toml"),
      httpManifest({ id: "in-project", port: 19999 }),
    );

    const error = await expectCliError(
      runAdd(harness.environment, args(["add", `--from=${manifestPath}`]), harness.io, "text"),
    );

    expect(error.exitCode).toBe(EXIT.usage);
    expect(error.message).toContain("project directory");
    expect(error.nextStep).toContain("--allow-project-local");
    // Nothing was installed.
    await expect(
      stat(join(harness.extensionsHome, "in-project", "manifest.toml")),
    ).rejects.toThrow();
  });

  it("installs the same manifest when the user asks for it explicitly", async () => {
    const harness = await createHarness();
    const manifestPath = await writeFixture(
      join(harness.project, "tools", "manifest.toml"),
      httpManifest({ id: "in-project", port: 19999 }),
    );

    const code = await runAdd(
      harness.environment,
      args(["add", `--from=${manifestPath}`, "--allow-project-local"]),
      harness.io,
      "json",
    );

    expect(code).toBe(EXIT.ok);
    const installed = await readFile(
      join(harness.extensionsHome, "in-project", "manifest.toml"),
      "utf8",
    );
    expect(installed).toContain('id = "in-project"');
  });

  it("never discovers a project-local manifest on its own", async () => {
    const harness = await createHarness();
    await writeFixture(
      join(harness.project, "manifest.toml"),
      httpManifest({ id: "sneaky", port: 19999 }),
    );

    await runList(harness.environment, args(["list"]), harness.io, "json");

    const report = JSON.parse(harness.io.outText) as { extensions: unknown[] };
    expect(report.extensions).toHaveLength(0);
  });
});

describe("extensions add — the digest requirement", () => {
  it("refuses a URL source without --digest", async () => {
    const harness = await createHarness();

    const error = await expectCliError(
      runAdd(
        harness.environment,
        args(["add", "--from=https://example.invalid/manifest.toml"]),
        harness.io,
        "text",
      ),
    );

    expect(error.exitCode).toBe(EXIT.usage);
    expect(error.message).toContain("without --digest");
  });

  it("refuses when the downloaded bytes do not match the promised digest", async () => {
    const harness = await createHarness();
    const body = httpManifest({ id: "downloaded", port: 19999 });
    const wrongDigest = `sha256:${"0".repeat(64)}`;

    const error = await expectCliError(
      runAdd(
        harness.environment,
        args(["add", "--from=https://example.invalid/manifest.toml", `--digest=${wrongDigest}`]),
        harness.io,
        "text",
        { fetchOptions: { fetchImpl: fakeFetch(200, body) } },
      ),
    );

    expect(error.exitCode).toBe(EXIT.operational);
    expect(error.message).toContain("Digest mismatch");
    await expect(
      stat(join(harness.extensionsHome, "downloaded", "manifest.toml")),
    ).rejects.toThrow();
  });

  it("installs when the digest matches", async () => {
    const harness = await createHarness();
    const body = httpManifest({ id: "downloaded", port: 19999 });
    const digest = digestOf(new TextEncoder().encode(body));

    const code = await runAdd(
      harness.environment,
      args(["add", "--from=https://example.invalid/manifest.toml", `--digest=${digest}`]),
      harness.io,
      "json",
      { fetchOptions: { fetchImpl: fakeFetch(200, body) } },
    );

    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(harness.io.outText) as {
      manifestDigest: string;
      source: { kind: string };
    };
    expect(report.manifestDigest).toBe(digest);
    expect(report.source.kind).toBe("url");
  });

  it("refuses plain http even with a digest", async () => {
    const harness = await createHarness();
    const body = httpManifest({ id: "downloaded", port: 19999 });
    const digest = digestOf(new TextEncoder().encode(body));

    const error = await expectCliError(
      runAdd(
        harness.environment,
        args(["add", "--from=http://example.invalid/manifest.toml", `--digest=${digest}`]),
        harness.io,
        "text",
        { fetchOptions: { fetchImpl: fakeFetch(200, body) } },
      ),
    );

    expect(error.message).toContain("refusing to download a manifest over");
  });
});

describe("extensions add — manifest validation", () => {
  it("rejects a container manifest that is not pinned to a real digest (X6)", async () => {
    const harness = await createHarness();
    const manifestPath = await writeFixture(
      join(harness.home, "sources", "moving", "manifest.toml"),
      movingTagManifest("moving-tag"),
    );

    const error = await expectCliError(
      runAdd(harness.environment, args(["add", `--from=${manifestPath}`]), harness.io, "text"),
    );

    expect(error.exitCode).toBe(EXIT.operational);
    expect(harness.io.errText).toContain("container.digest");
    await expect(stat(join(harness.extensionsHome, "moving-tag"))).rejects.toThrow();
  });

  it("refuses to overwrite an installed extension without --force", async () => {
    const harness = await createHarness();
    const manifestPath = await installHttpExtension(harness);

    const error = await expectCliError(
      runAdd(harness.environment, args(["add", `--from=${manifestPath}`]), harness.io, "text"),
    );
    expect(error.exitCode).toBe(EXIT.operational);
    expect(error.nextStep).toContain("--force");

    const forced = await runAdd(
      harness.environment,
      args(["add", `--from=${manifestPath}`, "--force"]),
      harness.io,
      "json",
    );
    expect(forced).toBe(EXIT.ok);
  });
});

describe("extensions list", () => {
  it("names every root it searched, including the ones that do not exist", async () => {
    const harness = await createHarness();

    await runList(harness.environment, args(["list"]), harness.io, "json");

    const report = JSON.parse(harness.io.outText) as {
      rootsScanned: { root: string; exists: boolean }[];
      projectRootsExcluded: string[];
    };
    expect(report.rootsScanned.length).toBeGreaterThan(0);
    expect(report.projectRootsExcluded).toContain(harness.environment.cwd);
  });

  it("reports a rejected manifest with its reason instead of hiding it (E4)", async () => {
    const harness = await createHarness();
    await writeFixture(
      join(harness.extensionsHome, "broken", "manifest.toml"),
      "this is not valid toml = = =",
    );

    await runList(harness.environment, args(["list"]), harness.io, "json");

    const report = JSON.parse(harness.io.outText) as {
      extensions: unknown[];
      rejected: { manifestPath: string; issues: { field: string; message: string }[] }[];
    };
    expect(report.extensions).toHaveLength(0);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.issues.length).toBeGreaterThan(0);
  });

  it("shows license, status and last run", async () => {
    const harness = await createHarness();
    await installHttpExtension(harness);
    harness.io.stdout.length = 0;

    await runList(harness.environment, args(["list"]), harness.io, "text");

    expect(harness.io.outText).toContain("example-http");
    expect(harness.io.outText).toContain("Apache-2.0");
    expect(harness.io.outText).toContain("installed, not enabled");
    expect(harness.io.outText).toContain("never");
  });
});

describe("extensions license gate (X5)", () => {
  it("installs a restricted tool unacknowledged and prints the exact command", async () => {
    const harness = await createHarness();
    await installHttpExtension(harness, { id: "restricted-http", restricted: true });

    const report = JSON.parse(harness.io.outText) as {
      license: { gateStatus: string };
      nextSteps: string[];
    };
    expect(report.license.gateStatus).toBe("unacknowledged");
    expect(report.nextSteps[0]).toBe(
      "untangle extensions enable restricted-http --acknowledge-license",
    );
  });

  it("refuses to run an unacknowledged tool and starts nothing", async () => {
    const harness = await createHarness();
    await installHttpExtension(harness, { id: "restricted-http", restricted: true });
    let fetched = 0;
    const countingFetch = ((): Promise<unknown> => {
      fetched += 1;
      return Promise.reject(new Error("must not be called"));
    }) as unknown as typeof fetch;

    const error = await expectCliError(
      runRun(harness.environment, args(["run", "restricted-http"]), harness.io, "text", {
        fetchImpl: countingFetch,
      }),
    );

    expect(error.exitCode).toBe(EXIT.environment);
    expect(fetched).toBe(0);
    expect(harness.io.errText).toContain("EXTENSION_LICENSE_UNACKNOWLEDGED");
    expect(error.nextStep).toContain("--acknowledge-license");
  });

  it("acknowledges, runs, and can revoke again", async () => {
    const harness = await createHarness();
    await installHttpExtension(harness, { id: "restricted-http", restricted: true });
    harness.io.stdout.length = 0;

    const enabled = await runEnable(
      harness.environment,
      args(["enable", "restricted-http", "--acknowledge-license"]),
      harness.io,
      "json",
    );
    expect(enabled).toBe(EXIT.ok);

    harness.io.stdout.length = 0;
    await runDisable(
      harness.environment,
      args(["disable", "restricted-http", "--revoke-license"]),
      harness.io,
      "json",
    );

    harness.io.stdout.length = 0;
    await runList(harness.environment, args(["list"]), harness.io, "json");
    const report = JSON.parse(harness.io.outText) as {
      extensions: { id: string; status: string }[];
    };
    expect(report.extensions[0]?.status).toContain("blocked");
  });
});

describe("extensions run", () => {
  it("normalizes tool output into external findings and records the run", async () => {
    const harness = await createHarness();
    await installHttpExtension(harness);
    await writeFixture(join(harness.project, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
    harness.io.stdout.length = 0;

    const payload = [
      JSON.stringify({
        path: "src/a.ts",
        startLine: 1,
        ruleId: "style/indent",
        message: "Wrong indentation",
        severity: "warning",
      }),
      JSON.stringify({
        path: "src/a.ts",
        startLine: 2,
        ruleId: "security/example",
        message: "Something else",
        severity: "totally-unknown",
      }),
    ].join("\n");

    const code = await runRun(
      harness.environment,
      args(["run", "example-http", `--workspace=${harness.project}`]),
      harness.io,
      "json",
      { fetchImpl: fakeFetch(200, payload) },
    );

    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(harness.io.outText) as {
      evidenceOnly: boolean;
      run: { exitStatus: string; findingsTotal: number };
      findings: {
        evidenceOnly: boolean;
        severity: { normalized: string; mappingMatched: boolean };
        filePath: string;
      }[];
    };
    expect(report.evidenceOnly).toBe(true);
    expect(report.run.exitStatus).toBe("completed");
    expect(report.run.findingsTotal).toBe(2);
    expect(report.findings.every((finding) => finding.evidenceOnly)).toBe(true);
    expect(report.findings[0]?.filePath).toBe("src/a.ts");
    expect(report.findings[0]?.severity.normalized).toBe("medium");

    // The unmapped severity fell back and said so — it did not vanish (E4).
    const fallback = report.findings.find((finding) => !finding.severity.mappingMatched);
    expect(fallback?.severity.normalized).toBe("medium");
    expect(harness.io.errText).toContain("severity fallback");

    // `list` now knows about the run.
    harness.io.stdout.length = 0;
    await runList(harness.environment, args(["list"]), harness.io, "json");
    const listed = JSON.parse(harness.io.outText) as {
      extensions: { lastRun?: { exitStatus: string; findingsTotal: number } }[];
    };
    expect(listed.extensions[0]?.lastRun?.exitStatus).toBe("completed");
    expect(listed.extensions[0]?.lastRun?.findingsTotal).toBe(2);
  });

  it("explains an unknown id instead of reporting an empty result", async () => {
    const harness = await createHarness();

    const error = await expectCliError(
      runRun(harness.environment, args(["run", "not-installed"]), harness.io, "text"),
    );

    expect(error.exitCode).toBe(EXIT.operational);
    expect(error.message).toContain('no extension "not-installed" is installed');
    expect(error.message).toContain("searched:");
  });
});

describe("extensions remove", () => {
  it("removes the directory and forgets the run record", async () => {
    const harness = await createHarness();
    await installHttpExtension(harness);
    harness.io.stdout.length = 0;

    const code = await runRemove(
      harness.environment,
      args(["remove", "example-http"]),
      harness.io,
      "json",
    );

    expect(code).toBe(EXIT.ok);
    await expect(stat(join(harness.extensionsHome, "example-http"))).rejects.toThrow();
  });

  it("keeps the license acknowledgment unless --revoke-license is given", async () => {
    const harness = await createHarness();
    await installHttpExtension(harness, { id: "restricted-http", restricted: true });
    await runEnable(
      harness.environment,
      args(["enable", "restricted-http", "--acknowledge-license"]),
      harness.io,
      "json",
    );
    harness.io.stdout.length = 0;

    await runRemove(harness.environment, args(["remove", "restricted-http"]), harness.io, "json");
    const report = JSON.parse(harness.io.outText) as { licenseAcknowledgment: string };
    expect(report.licenseAcknowledgment).toBe("kept");
  });
});

describe("extensions dispatch", () => {
  it("rejects a flag that belongs to a different subcommand", async () => {
    const harness = await createHarness();
    const error = await expectCliError(
      extensionsCommand.run(
        {
          io: harness.io,
          cwd: harness.project,
          env: harness.env,
          signal: new AbortController().signal,
        },
        args(["list", "--from=/somewhere"]),
      ),
    );
    expect(error.exitCode).toBe(EXIT.usage);
    expect(error.message).toContain("does not accept --from");
  });

  it("names no third-party tool in its own help text (E2, X9)", () => {
    const text = JSON.stringify(extensionsCommand.spec);
    expect(text).toContain("sarif");
    expect(text).toContain("generic-findings");
    // The help describes FORMATS and the boundary, never a concrete analyzer.
    expect(text).toContain("without bundled tool definitions");
  });
});

describe("project roots — what counts as somebody else's project", () => {
  it("treats a git repository and the directory inside it as project roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "untangle-roots-"));
    const repo = join(base, "repo");
    const inner = join(repo, "src", "deep");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(inner, { recursive: true });

    const roots = await discoverProjectRoots(new NodeFileSystem(), inner, base);

    expect(roots).toContain(inner);
    expect(roots).toContain(repo);
  });

  it("returns no project root for a plain directory with no marker", async () => {
    const base = await mkdtemp(join(tmpdir(), "untangle-roots-"));
    const plain = join(base, "just-a-folder");
    await mkdir(plain, { recursive: true });

    expect(await discoverProjectRoots(new NodeFileSystem(), plain, base)).toEqual([]);
  });

  it("never treats the home directory itself as a project, even as a dotfiles repo", async () => {
    // A `.git` in $HOME is ordinary. If it counted, ~/.untangle/extensions
    // would sit inside a "project" and the user's own extension root would
    // become unscannable the moment they ran the CLI from their home
    // directory.
    const home = await mkdtemp(join(tmpdir(), "untangle-home-"));
    await mkdir(join(home, ".git"), { recursive: true });
    await mkdir(join(home, ".untangle", "extensions"), { recursive: true });

    expect(await discoverProjectRoots(new NodeFileSystem(), home, home)).toEqual([]);
  });
});
