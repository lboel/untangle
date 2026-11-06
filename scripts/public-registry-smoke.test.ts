import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface PackageRecord {
  name: string;
  version: string;
  integrity: string;
}
interface RequestRecord {
  name: string;
  version: string;
  url: string;
  status?: number;
  metadataSha256?: string;
  integrity?: string;
  tarball?: string;
}
interface PublicModule {
  PUBLIC_REGISTRY: string;
  parseOptions(args: string[]): { bundle: string; out: string };
  anonymousEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  preflightPublicRegistry(
    packages: PackageRecord[],
    requests: RequestRecord[],
    options?: {
      fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
      signal?: AbortSignal;
    },
  ): Promise<void>;
  runPublicRegistrySmoke(options: { bundle: string; out: string }): Promise<{ verified: boolean }>;
}
const smoke = (await import(
  pathToFileURL(path.resolve("scripts/public-registry-smoke.mjs")).href
)) as PublicModule;
const directories: string[] = [];
function directory() {
  const root = mkdtempSync(path.join(tmpdir(), "untangle-public-test-"));
  directories.push(root);
  return root;
}
const expected = { name: "@untangle-code/core", version: "0.1.0", integrity: "sha512-original" };
function metadata(record = expected) {
  return {
    name: record.name,
    versions: {
      [record.version]: {
        name: record.name,
        version: record.version,
        dist: {
          integrity: record.integrity,
          tarball: `https://registry.npmjs.org/${record.name}/-/core-0.1.0.tgz`,
        },
      },
    },
  };
}
function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("public release registry preflight", () => {
  it("records anonymous exact metadata and all original package integrities before consumers run", async () => {
    const packages = [expected, { ...expected, name: "@untangle-code/cli" }];
    const requests: RequestRecord[] = [];
    const calls: { url: string; options: RequestInit }[] = [];
    await smoke.preflightPublicRegistry(packages, requests, {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return response(metadata(packages[calls.length - 1]));
      },
    });
    expect(calls.map((call) => call.url)).toEqual(
      packages.map((record) => `https://registry.npmjs.org/${encodeURIComponent(record.name)}`),
    );
    expect(
      calls.every(
        (call) =>
          call.options.credentials === "omit" &&
          call.options.redirect === "error" &&
          call.options.headers === undefined &&
          call.options.signal instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(requests.map((record) => [record.name, record.status, record.integrity])).toEqual(
      packages.map((record) => [record.name, 200, record.integrity]),
    );
    expect(requests[0]?.metadataSha256).toBe(
      createHash("sha256").update(JSON.stringify(metadata())).digest("hex"),
    );
  });
  it.each([404, 401, 403, 429, 500])(
    "fails honestly on HTTP %s and keeps the actual receipt",
    async (status) => {
      const requests: RequestRecord[] = [];
      await expect(
        smoke.preflightPublicRegistry([expected], requests, {
          fetchImpl: () => response({}, status),
        }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(requests).toEqual([
        {
          name: expected.name,
          version: expected.version,
          url: `https://registry.npmjs.org/${encodeURIComponent(expected.name)}`,
          status,
        },
      ]);
    },
  );
  it("rejects absent exact release version even if another version exists", async () => {
    await expect(
      smoke.preflightPublicRegistry([expected], [], {
        fetchImpl: () => response(metadata({ ...expected, version: "0.2.0" })),
      }),
    ).rejects.toThrow("Public version is missing");
  });
  it("rejects a registry manifest with a conflicting version", async () => {
    const body = metadata();
    body.versions["0.1.0"]!.version = "0.2.0";
    await expect(
      smoke.preflightPublicRegistry([expected], [], { fetchImpl: () => response(body) }),
    ).rejects.toThrow("Registry version differs");
  });
  it("rejects different package identities in metadata and versions", async () => {
    const body = metadata();
    body.name = "@untangle-code/other";
    await expect(
      smoke.preflightPublicRegistry([expected], [], { fetchImpl: () => response(body) }),
    ).rejects.toThrow("Registry package name differs");
    body.name = expected.name;
    body.versions["0.1.0"]!.name = "@untangle-code/other";
    await expect(
      smoke.preflightPublicRegistry([expected], [], { fetchImpl: () => response(body) }),
    ).rejects.toThrow("Registry version package name differs");
  });
  it("rejects a tarball whose SHA-512 integrity differs from the original", async () => {
    await expect(
      smoke.preflightPublicRegistry([expected], [], {
        fetchImpl: () => response(metadata({ ...expected, integrity: "sha512-other" })),
      }),
    ).rejects.toThrow("Public tarball integrity differs");
  });
  it.each([
    "https://example.com/core.tgz",
    "http://registry.npmjs.org/core.tgz",
    "https://token:secret@registry.npmjs.org/core.tgz",
    "https://registry.npmjs.org/core.tgz#fragment",
  ])("rejects nonpublic or credential-bearing tarball URL %s", async (url) => {
    const body = metadata();
    body.versions["0.1.0"]!.dist.tarball = url;
    await expect(
      smoke.preflightPublicRegistry([expected], [], { fetchImpl: () => response(body) }),
    ).rejects.toThrow(/Tarball/);
  });
  it("preserves cancellation reason without sending another request", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    controller.abort(reason);
    const requests: RequestRecord[] = [];
    await expect(
      smoke.preflightPublicRegistry([expected], requests, {
        signal: controller.signal,
        fetchImpl: () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toBe(reason);
    expect(requests).toEqual([]);
  });
  it("retains a failed network attempt and does not continue to later packages", async () => {
    const failure = new Error("offline");
    const requests: RequestRecord[] = [];
    await expect(
      smoke.preflightPublicRegistry(
        [expected, { ...expected, name: "@untangle-code/cli" }],
        requests,
        {
          fetchImpl: () => {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
  });
});

describe("public acceptance isolation and immutable reports", () => {
  it("requires exact bundle/output arguments and forbids overwriting reports", () => {
    const root = directory();
    const out = path.join(root, "report.json");
    expect(smoke.parseOptions([`--bundle=${root}`, `--out=${out}`])).toEqual({ bundle: root, out });
    for (const args of [
      [],
      [`--bundle=${root}`],
      ["--bundle=", `--out=${out}`],
      [`--bundle=${root}`, "--out="],
      ["--publish"],
      [`--bundle=${root}`, `--out=${out}`, `--out=${out}`],
    ])
      expect(() => smoke.parseOptions(args)).toThrow();
    writeFileSync(out, "existing evidence");
    expect(() => smoke.parseOptions([`--bundle=${root}`, `--out=${out}`])).toThrow(
      "not be overwritten",
    );
    expect(readFileSync(out, "utf8")).toBe("existing evidence");
  });
  it("removes bootstrap credentials and inherited configs without mutating input", () => {
    const original = {
      PATH: "/safe/bin",
      HOME: "/home",
      NODE_AUTH_TOKEN: "bootstrap",
      GH_TOKEN: "github",
      NPM_TOKEN: "npm",
      npm_config_registry: "https://local",
      NPM_CONFIG_USERCONFIG: "/secret",
      PNPM_HOME: "/local",
      NODE_OPTIONS: "--require=inject",
      NODE_PATH: "/workspace",
      PASSWORD: "password",
      ordinary: "retained",
    };
    const before = { ...original };
    expect(smoke.anonymousEnvironment(original)).toEqual({
      PATH: "/safe/bin",
      HOME: "/home",
      ordinary: "retained",
    });
    expect(original).toEqual(before);
  });
  it("writes a source-bound unverified report on missing originals and restores the environment", async () => {
    const root = directory();
    const out = path.join(root, "failure.json");
    const before = process.env;
    await expect(
      smoke.runPublicRegistrySmoke({ bundle: path.join(root, "absent"), out }),
    ).rejects.toThrow();
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report).toMatchObject({
      schemaVersion: 1,
      verified: false,
      status: "unverified",
      registry: { origin: "https://registry.npmjs.org", requests: [] },
      consumers: [],
    });
    expect(report.failure.message).toMatch(/ENOENT/);
    expect(report.tooling).toHaveLength(7);
    expect(
      report.tooling.some((tool: { path: string }) =>
        tool.path.endsWith("release-local-search-consumer.mjs"),
      ),
    ).toBe(true);
    expect(
      report.tooling.some((tool: { path: string }) =>
        tool.path.endsWith("release-frontend-consumer.mjs"),
      ),
    ).toBe(true);
    for (const tool of report.tooling)
      expect(tool.sha256).toBe(createHash("sha256").update(readFileSync(tool.path)).digest("hex"));
    expect(process.env).toBe(before);
    await expect(smoke.runPublicRegistrySmoke({ bundle: root, out })).rejects.toThrow(
      "not be overwritten",
    );
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(report);
  });
});
