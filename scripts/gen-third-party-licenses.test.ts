import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface PackageRecord {
  name: string;
  absDir: string;
  pkg: Record<string, unknown>;
}
interface Variant {
  name: string;
  version: string;
  license: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}
const generator = (await import(
  pathToFileURL(path.resolve("scripts/gen-third-party-licenses.mjs")).href
)) as {
  collectProductionClosure(
    record: PackageRecord,
    packages: Map<string, PackageRecord>,
  ): {
    rows: { name: string; version: string; license: string }[];
    unresolved: string[];
    nativeVariants: Variant[];
    resolvedNativeVariants: { name: string; version: string; license: string }[];
  };
  renderLanceNativeSection(variants: Variant[]): string;
};
const provenance = JSON.parse(readFileSync("scripts/lancedb-native-provenance.json", "utf8")) as {
  package: string;
  version: string;
  variants: Variant[];
};
const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "untangle-license-generator-test-"));
  owned.push(root);
  const pkg = {
    name: "@untangle-code/fixture",
    dependencies: { [provenance.package]: provenance.version },
  };
  const record = { name: pkg.name, absDir: root, pkg };
  function external(name: string, fields: Record<string, unknown>) {
    const directory = path.join(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, ...fields }));
    return directory;
  }
  external(provenance.package, {
    version: provenance.version,
    license: "Apache-2.0",
    dependencies: { "ordinary-runtime": "1.0.0" },
    optionalDependencies: Object.fromEntries(
      provenance.variants.map((entry) => [entry.name, entry.version]),
    ),
  });
  external("ordinary-runtime", {
    version: "1.0.0",
    license: "MIT",
    devDependencies: { "never-installed-dev": "1.0.0" },
  });
  return {
    root,
    record,
    external,
    collect: () => generator.collectProductionClosure(record, new Map([[record.name, record]])),
  };
}

describe("deterministic native optional package attribution", () => {
  it("retains exact required production closure and all declared native variants without inventing installations", () => {
    const f = fixture();
    const report = f.collect();
    expect(report.rows.map(({ name }) => name)).toEqual(["@lancedb/lancedb", "ordinary-runtime"]);
    expect(report.unresolved).toEqual([]);
    expect(report.nativeVariants).toEqual(provenance.variants);
    expect(report.nativeVariants).toHaveLength(7);
    expect(report.resolvedNativeVariants).toEqual([]);
    const section = generator.renderLanceNativeSection(report.nativeVariants);
    expect(section).toContain("not a claim that all seven binaries were installed");
    expect(section).toContain("installed production SBOM");
    expect(section).not.toContain("never-installed-dev");
  });

  it("verifies every installed variant while keeping committed attribution independent of host selection", () => {
    const f = fixture();
    const first = provenance.variants[0]!;
    const second = provenance.variants[1]!;
    const installed = f.external(first.name, first as unknown as Record<string, unknown>);
    const before = f.collect();
    expect(before.resolvedNativeVariants).toEqual([
      { name: first.name, version: first.version, license: first.license },
    ]);
    rmSync(installed, { recursive: true });
    f.external(second.name, second as unknown as Record<string, unknown>);
    const after = f.collect();
    expect(after.resolvedNativeVariants).toEqual([
      { name: second.name, version: second.version, license: second.license },
    ]);
    expect(generator.renderLanceNativeSection(after.nativeVariants)).toBe(
      generator.renderLanceNativeSection(before.nativeVariants),
    );
  });

  it.each(["license", "version", "dependencies"])(
    "refuses installed native %s drift instead of omitting attribution",
    (field) => {
      const f = fixture();
      const native = provenance.variants[0]!;
      const changed = { ...native } as unknown as Record<string, unknown>;
      changed[field] =
        field === "license"
          ? "Unknown"
          : field === "version"
            ? "0.0.0"
            : { "unrecorded-native-runtime": "1.0.0" };
      f.external(native.name, changed);
      expect(f.collect).toThrow("differs from published provenance");
    },
  );

  it("refuses unreviewed new SDK optional integrations", () => {
    const f = fixture();
    f.external(provenance.package, {
      version: provenance.version,
      license: "Apache-2.0",
      optionalDependencies: { "unreviewed-model-runtime": "1.0.0" },
    });
    expect(f.collect).toThrow("optional dependency declarations changed");
  });

  it.each([
    { args: ["--package="] },
    { args: ["--package=@untangle-code/not-a-package"] },
    { args: ["--package=one", "--package=two"] },
  ])("rejects invalid bounded selectors without falling back to all packages: %j", ({ args }) => {
    const result = spawnSync(process.execPath, ["scripts/gen-third-party-licenses.mjs", ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("third-party-licenses:");
  });
});
