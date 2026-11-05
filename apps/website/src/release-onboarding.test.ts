import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { beforeAll, describe, expect, it, vi } from "vitest";

let html = "";
let script = "";

beforeAll(async () => {
  [html, script] = await Promise.all([
    readFile(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8"),
    readFile(fileURLToPath(new URL("./site.js", import.meta.url)), "utf8"),
  ]);
});

describe("Release onboarding", () => {
  it("reaches a service-free report before the optional feature and search setup", () => {
    const start = html.indexOf('id="local-install"');
    const feature = html.indexOf('id="start"');
    const mcp = html.indexOf('id="mcp"');
    expect(start).toBeGreaterThan(0);
    expect(feature).toBeGreaterThan(start);
    expect(mcp).toBeGreaterThan(feature);

    const setup = html.slice(start, feature);
    expect(setup).toContain("untangle complexity");
    expect(setup).toContain("needs no");
    expect(setup).not.toContain("untangle index");
    expect(setup).not.toContain("untangle doctor");
    expect(setup).toContain("pnpm 10.34.5");
    expect(setup).toContain("npm package is not published yet");
    expect(html).toMatch(/href="#local-install"\s*>\s*Analyze your first repository\s*<\/a\s*>/u);
  });

  it("keeps the first copied commands executable without target-path placeholders", () => {
    const commands = html.match(/<code id="setup-command">([\s\S]*?)<\/code>/u)?.[1];
    expect(commands).toBeDefined();
    expect(commands).toContain("pnpm setup:local");
    expect(commands).toContain('UNTANGLE_CLI="$PWD/apps/cli/dist/index.js"');
    expect(commands).toContain('untangle() { node "$UNTANGLE_CLI" "$@"; }');
    expect(commands).not.toContain("/path/to/");
    expect(commands).not.toContain("npm install --global");
    expect(html).toMatch(/data-copy-command="setup-command" hidden/u);
  });

  it("keeps setup anchors and copy targets unambiguous after moving the install flow", () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const targets = [...html.matchAll(/data-copy-command="([^"]+)"/gu)].map((match) => match[1]);
    expect(targets).toEqual(["setup-command"]);
    expect(ids).toContain("copy-announcement");
    expect(ids).toContain("local-install");
    expect(html).toContain('id="copy-announcement" role="status" aria-live="polite"');
  });

  it("distinguishes declarations, whole-feature measurement and actual test execution", () => {
    const feature = html.slice(html.indexOf('id="start"'), html.indexOf('id="measurement"'));
    const copy = feature.replace(/\s+/gu, " ");
    expect(feature).toContain("untangle product --path=src/accounts/lookup.ts");
    expect(feature).toContain("untangle product --draft --feature=accounts.lookup");
    expect(copy).toContain("prints a review draft to stdout");
    expect(copy).toContain("writes no feature map and invents no owners");
    expect(copy).toContain("the full report is not the manifest.");
    expect(copy).toContain("measures the whole feature, including its helpers");
    expect(feature).toContain("--run-tests -- pnpm exec vitest run src/accounts/lookup.test.ts");
    expect(copy).toContain("Declared test files alone do not count as passed tests.");
    expect(copy).toContain("Replace");
    expect(copy).toContain("repository-relative file");
  });

  it("keeps provider scopes and monitoring opt-in explicit", () => {
    const copy = html.replace(/\s+/gu, " ");
    expect(html).toContain("untangle scan --feature=accounts.lookup --format=json");
    expect(copy).toContain("repository-wide values remain repository context.");
    expect(copy).toContain("caller-declared model, harness and strategy context");
    expect(copy).toContain("an MCP connection alone starts no monitoring.");
    expect(copy).toContain("This context is declared, not independently verified.");
  });
});

class CopyElement {
  hidden = true;
  disabled = false;
  textContent: string;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => Promise<void>>();

  constructor(textContent: string) {
    this.textContent = textContent;
  }

  getAttribute(name: string): string {
    return this.attributes.get(name) ?? "";
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(event: string, listener: () => Promise<void>): void {
    this.listeners.set(event, listener);
  }
}

function copyHarness(writeText?: (text: string) => Promise<void>) {
  const button = new CopyElement("Copy commands");
  button.attributes.set("data-copy-command", "setup-command");
  const command = new CopyElement("\npnpm install --frozen-lockfile\npnpm run build\n");
  const announcement = new CopyElement("");
  const elements = new Map([
    ["setup-command", command],
    ["copy-announcement", announcement],
  ]);
  const document = {
    documentElement: { classList: { add() {}, remove() {} } },
    getElementById: (id: string) => elements.get(id),
    querySelectorAll: (selector: string) => (selector === "[data-copy-command]" ? [button] : []),
  };

  runInNewContext(script, {
    document,
    navigator: writeText ? { clipboard: { writeText } } : {},
  });
  return { button, announcement, click: () => button.listeners.get("click")?.() };
}

describe("Command copying", () => {
  it("preserves selectable commands without an available clipboard API", () => {
    const harness = copyHarness();
    expect(harness.button.hidden).toBe(true);
    expect(harness.button.listeners.size).toBe(0);
    expect(harness.announcement.textContent).toBe("");
  });

  it("copies only command text and announces completion after the clipboard resolves", async () => {
    let complete: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const harness = copyHarness(writeText);
    expect(harness.button.hidden).toBe(false);

    const pending = harness.click();
    expect(harness.button.disabled).toBe(true);
    expect(harness.button.getAttribute("aria-busy")).toBe("true");
    expect(harness.announcement.textContent).toBe("");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      "pnpm install --frozen-lockfile\npnpm run build",
    );

    complete?.();
    await pending;
    expect(harness.button.disabled).toBe(false);
    expect(harness.button.getAttribute("aria-busy")).toBe("false");
    expect(harness.button.textContent).toBe("Copy again");
    expect(harness.announcement.textContent).toContain("Commands copied.");
  });

  it("offers the visible text as recovery when clipboard permission is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const harness = copyHarness(writeText);
    await harness.click();

    expect(harness.button.disabled).toBe(false);
    expect(harness.button.textContent).toBe("Try copy again");
    expect(harness.announcement.textContent).toBe(
      "Clipboard access was blocked. Select and copy the commands above.",
    );
  });
});
