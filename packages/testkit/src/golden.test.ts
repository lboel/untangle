import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertGoldenJson, stableStringify } from "./golden.js";

describe("stableStringify", () => {
  it("sorts object keys and pretty-prints with 2-space indent", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it("sorts nested object keys recursively while keeping array order", () => {
    expect(stableStringify({ z: [{ y: 1, x: 2 }] })).toBe(
      '{\n  "z": [\n    {\n      "x": 2,\n      "y": 1\n    }\n  ]\n}\n',
    );
  });

  it("omits properties whose value is undefined", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{\n  "a": 1\n}\n');
  });
});

describe("assertGoldenJson", () => {
  let dir: string;
  let metaUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "untangle-golden-test-"));
    // A plausible-looking test file path inside the temp dir — golden files
    // land in "<dir>/__golden__/<name>.json", never touching this
    // package's own real __golden__ directories.
    metaUrl = pathToFileURL(path.join(dir, "fake.test.ts")).toString();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the golden file on first run and passes", () => {
    expect(() => assertGoldenJson("case1", { a: 1 }, { metaUrl })).not.toThrow();
    const filePath = path.join(dir, "__golden__", "case1.json");
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ a: 1 });
  });

  it("passes on a second run with an identical value", () => {
    assertGoldenJson("case1", { a: 1 }, { metaUrl });
    expect(() => assertGoldenJson("case1", { a: 1 }, { metaUrl })).not.toThrow();
  });

  it("fails when the value differs from the stored golden", () => {
    assertGoldenJson("case1", { a: 1 }, { metaUrl });
    expect(() => assertGoldenJson("case1", { a: 2 }, { metaUrl })).toThrow();
  });

  it("UNTANGLE_UPDATE_GOLDEN=1 overwrites a mismatching golden instead of failing", () => {
    assertGoldenJson("case1", { a: 1 }, { metaUrl });
    process.env["UNTANGLE_UPDATE_GOLDEN"] = "1";
    try {
      expect(() => assertGoldenJson("case1", { a: 2 }, { metaUrl })).not.toThrow();
    } finally {
      delete process.env["UNTANGLE_UPDATE_GOLDEN"];
    }
    const filePath = path.join(dir, "__golden__", "case1.json");
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ a: 2 });
    // And it now matches again without update mode.
    expect(() => assertGoldenJson("case1", { a: 2 }, { metaUrl })).not.toThrow();
  });

  it("honors a custom updateEnvVar name instead of the default", () => {
    assertGoldenJson("case1", { a: 1 }, { metaUrl });
    process.env["MY_CUSTOM_UPDATE"] = "1";
    try {
      assertGoldenJson("case1", { a: 2 }, { metaUrl, updateEnvVar: "MY_CUSTOM_UPDATE" });
    } finally {
      delete process.env["MY_CUSTOM_UPDATE"];
    }
    const filePath = path.join(dir, "__golden__", "case1.json");
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ a: 2 });
  });

  it("different golden names under the same metaUrl do not collide", () => {
    assertGoldenJson("caseA", { a: 1 }, { metaUrl });
    assertGoldenJson("caseB", { b: 2 }, { metaUrl });
    expect(() => assertGoldenJson("caseA", { a: 1 }, { metaUrl })).not.toThrow();
    expect(() => assertGoldenJson("caseB", { b: 2 }, { metaUrl })).not.toThrow();
  });

  it("rejects a golden name that is not a plain filename-safe string", () => {
    expect(() => assertGoldenJson("../escape", { a: 1 }, { metaUrl })).toThrow();
    expect(() => assertGoldenJson("weird/slash", { a: 1 }, { metaUrl })).toThrow();
  });
});
