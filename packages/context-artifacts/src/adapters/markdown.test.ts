import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import { createMarkdownAdapter } from "./markdown.js";

const ADR_FIXTURE = `# ADR 0001: Use SQLite

## Status

Accepted

## Context

We need a small embedded database for local-first storage.

### Alternatives Considered

- Postgres — too heavy for a single-user desktop app.
- MySQL — same concern, plus an extra service to run.

## Decision

We will use SQLite via better-sqlite3.

\`\`\`ts
// a fenced code block containing a fake "## heading" that must NOT be sectioned
const notAHeading = "## not a real heading";
\`\`\`

## Consequences

Simpler ops, less horizontal scale.
`;

describe("createMarkdownAdapter", () => {
  const adapter = createMarkdownAdapter();

  it("supports() matches by extension and explicit type", () => {
    expect(adapter.supports("markdown", "anything")).toBe(true);
    expect(adapter.supports("auto", "docs/adr/0001-use-sqlite.md")).toBe(true);
    expect(adapter.supports("auto", "docs/notes.txt")).toBe(false);
  });

  it("golden: sections by heading with breadcrumbs, ignoring headings inside fenced code", async () => {
    const config = artifactConfig({
      name: "adr-0001",
      path: "docs/adr/0001-use-sqlite.md",
      type: "markdown",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("docs/adr/0001-use-sqlite.md", ADR_FIXTURE)],
    });
    expect(document).toBeDefined();
    expect(document!.type).toBe("markdown");

    const chunks = adapter.chunk(document!);
    // A fake heading inside the fenced code block must not have produced an extra section.
    expect(chunks.filter((c) => c.title === "not a real heading")).toHaveLength(0);

    assertGoldenJson("adr-0001-sections", chunks.map(projectChunk), { metaUrl: import.meta.url });
  });

  it("breadcrumbs walk back through strictly decreasing heading levels", async () => {
    const config = artifactConfig({ name: "adr-0001", path: "a.md" });
    const [document] = await adapter.read({ config, files: [inputFile("a.md", ADR_FIXTURE)] });
    const chunks = adapter.chunk(document!);
    const alternatives = chunks.find((c) => c.title?.includes("Alternatives Considered"));
    expect(alternatives?.title).toBe("ADR 0001: Use SQLite › Context › Alternatives Considered");
  });
});
