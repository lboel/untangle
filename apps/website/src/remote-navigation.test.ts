import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const website = fileURLToPath(new URL("..", import.meta.url));
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "untangle-remote-navigation-"));
  mkdirSync(path.join(root, "scripts"));
  cpSync(path.join(website, "scripts/check.mjs"), path.join(root, "scripts/check.mjs"));
  cpSync(
    path.join(website, "scripts/generate-example.mjs"),
    path.join(root, "scripts/generate-example.mjs"),
  );
  cpSync(path.join(website, "src"), path.join(root, "src"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function check() {
  return execFileSync(process.execPath, [path.join(root, "scripts/check.mjs"), "src"], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

describe("Repository navigation preserves the page's local-resource boundary", () => {
  it("accepts the two exact repository anchors and the displayed clone command", () => {
    expect(check()).toContain("passed static, privacy and design constraints");
  });

  it.each([
    ["image", "index.html", '<img src="https://github.com/lboel/untangle">'],
    ["script", "index.html", '<script src="https://github.com/lboel/untangle"></script>'],
    ["CSS", "styles.css", '.remote { background: url("https://github.com/lboel/untangle"); }'],
    ["JavaScript", "site.js", 'fetch("https://github.com/lboel/untangle");'],
    ["another link", "index.html", '<a href="https://example.com">Another site</a>'],
    ["protocol-relative URL", "index.html", '<img src="//example.com/pixel">'],
    [
      "active anchor attributes",
      "index.html",
      '<a href="https://github.com/lboel/untangle" ping="https://example.com">Repository</a>',
    ],
    [
      "an extra clone span outside setup",
      "index.html",
      "<span>git clone https://github.com/lboel/untangle.git</span>",
    ],
  ])("still rejects a remote %s", (_name, file, injected) => {
    const target = path.join(root, "src", file);
    writeFileSync(target, `${readFileSync(target, "utf8")}\n${injected}`);
    expect(check).toThrow();
  });
});
