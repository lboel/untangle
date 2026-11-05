import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(sourceRoot, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "untangle-scroll-delivery-"));
  roots.push(root);
  const website = path.join(root, "apps/website");
  await mkdir(path.join(website, "src"), { recursive: true });
  await mkdir(path.join(website, "scripts"));
  await Promise.all(
    [
      "index.html",
      "styles.css",
      "site.js",
      "story.js",
      "yarn-scene.js",
      "untangle-logo.svg",
      "untangle-yarn-3d.png",
      "untangle-example.html",
      "untangle-example.json",
    ].map((name) => copyFile(path.join(sourceRoot, name), path.join(website, "src", name))),
  );
  await Promise.all(
    ["build.mjs", "check.mjs", "generate-example.mjs"].map((name) =>
      copyFile(path.join(packageRoot, "scripts", name), path.join(website, "scripts", name)),
    ),
  );
  await Promise.all(
    ["LICENSE", "NOTICE"].map((name) =>
      copyFile(path.join(packageRoot, name), path.join(website, name)),
    ),
  );
  return { root, website, source: path.join(website, "src"), output: path.join(website, "dist") };
}

async function runScript(root: string, name: string, args: string[] = []) {
  return execute(process.execPath, [path.join(root, "apps/website/scripts", name), ...args], {
    cwd: root,
    timeout: 3_000,
  });
}

async function publicationScript(root: string, step: string) {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/pages.yml"), "utf8");
  const section = workflow.split(`- name: ${step}\n`)[1];
  const script = section?.match(/<<'NODE'\n([\s\S]*?)\n {10}NODE/u)?.[1];
  if (!script) throw new Error(`Missing executable publication step: ${step}`);
  return execute(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    timeout: 3_000,
    env: { ...process.env, GITHUB_STEP_SUMMARY: path.join(root, "summary.txt") },
  });
}

async function preparePublication(root: string) {
  await runScript(root, "build.mjs");
  await runScript(root, "check.mjs", ["dist"]);
  await publicationScript(root, "Include the website license and notice");
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("Scroll-story static delivery", () => {
  it("ships the browser module dependency graph and the exact transparent brand image", async () => {
    const { root, output } = await fixture();
    await preparePublication(root);
    await publicationScript(root, "Verify the public artifact boundary and record its source");

    const html = await readFile(path.join(output, "index.html"), "utf8");
    const modules = [...html.matchAll(/<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/gu)].map(
      (match) => match[1],
    );
    expect(modules).toContain("./story.js");
    const visited = new Set<string>();
    const pending = modules.map((name) => path.resolve(output, name));
    while (pending.length > 0) {
      const file = pending.pop()!;
      expect(file.startsWith(`${output}${path.sep}`)).toBe(true);
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\b(?:from\s+|import\s*)["']([^"']+)["']/gu)) {
        expect(match[1].startsWith("./"), `nonlocal browser module: ${match[1]}`).toBe(true);
        pending.push(path.resolve(path.dirname(file), match[1]));
      }
    }
    expect([...visited].map((name) => path.basename(name))).toContain("yarn-scene.js");

    const image = await readFile(path.join(output, "untangle-yarn-3d.png"));
    expect(
      image.equals(await readFile(path.join(repositoryRoot, "docs/assets/untangle-yarn-3d.png"))),
    ).toBe(true);
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(image[25]).toBe(6); // PNG IHDR color type 6 preserves the native RGBA channel.
  });

  it.each(["story.js", "yarn-scene.js"])(
    "rejects a remote resource introduced into %s",
    async (name) => {
      const { root, source } = await fixture();
      await writeFile(path.join(source, name), 'fetch("https://example.invalid/tracker");\n');
      await expect(runScript(root, "check.mjs", ["src"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("contains forbidden remote URL"),
      });
    },
  );

  it("refuses a build with an absent renderer instead of shipping a broken enhancement", async () => {
    const { root, source } = await fixture();
    await rm(path.join(source, "yarn-scene.js"));
    await expect(runScript(root, "build.mjs")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("yarn-scene.js"),
    });
  });

  it("leaves unselected source data out of the published artifact", async () => {
    const { root, source, output } = await fixture();
    await writeFile(path.join(source, "private-index.json"), '{"privateFixture":true}\n');
    await preparePublication(root);
    await publicationScript(root, "Verify the public artifact boundary and record its source");
    await expect(readFile(path.join(output, "private-index.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an extra output file before the Pages upload", async () => {
    const { root, output } = await fixture();
    await preparePublication(root);
    await writeFile(path.join(output, "private-index.json"), '{"privateFixture":true}\n');
    await expect(
      publicationScript(root, "Verify the public artifact boundary and record its source"),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("private-index.json") });
  });

  it("rejects a symlinked brand image before the Pages upload", async () => {
    const { root, output } = await fixture();
    await preparePublication(root);
    await rm(path.join(output, "untangle-yarn-3d.png"));
    await symlink("../src/untangle-yarn-3d.png", path.join(output, "untangle-yarn-3d.png"));
    await expect(
      publicationScript(root, "Verify the public artifact boundary and record its source"),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Only regular website assets may be published."),
    });
  });

  it("refuses a symlinked source image during the source check", async () => {
    const { root, source } = await fixture();
    await rm(path.join(source, "untangle-yarn-3d.png"));
    await symlink(
      path.join(repositoryRoot, "docs/assets/untangle-yarn-3d.png"),
      path.join(source, "untangle-yarn-3d.png"),
    );
    await expect(runScript(root, "check.mjs", ["src"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("asset must be a regular file"),
    });
  });
});
