import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isEntryPoint } from "./entry-point.js";

describe("isEntryPoint", () => {
  it("recognizes a direct invocation", async () => {
    const base = await mkdtemp(join(tmpdir(), "untangle-entry-"));
    const file = join(base, "program.js");
    await writeFile(file, "// program\n", "utf8");

    expect(isEntryPoint(pathToFileURL(file).href, file)).toBe(true);
  });

  it("recognizes an invocation through a symlink — how npm installs a global bin", async () => {
    const base = await mkdtemp(join(tmpdir(), "untangle-entry-"));
    const real = join(base, "program.js");
    const link = join(base, "untangle");
    await writeFile(real, "// program\n", "utf8");
    await symlink(real, link);

    // This is the shape that broke: the module URL is the resolved real path
    // (Node's ESM loader resolves symlinks), argv[1] is the link in bin/.
    const moduleUrl = pathToFileURL(real).href;
    expect(pathToFileURL(link).href).not.toBe(moduleUrl);
    expect(isEntryPoint(moduleUrl, link)).toBe(true);
  });

  it("says no when the module was merely imported", async () => {
    const base = await mkdtemp(join(tmpdir(), "untangle-entry-"));
    const module = join(base, "library.js");
    const program = join(base, "program.js");
    await writeFile(module, "// library\n", "utf8");
    await writeFile(program, "// program\n", "utf8");

    expect(isEntryPoint(pathToFileURL(module).href, program)).toBe(false);
  });

  it("says no instead of throwing when argv[1] is absent or unresolvable", () => {
    expect(isEntryPoint("file:///whatever.js", undefined)).toBe(false);
    expect(isEntryPoint("file:///whatever.js", "/does/not/exist/anywhere")).toBe(false);
  });
});
