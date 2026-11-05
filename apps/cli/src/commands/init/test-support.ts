/**
 * Test scaffolding for `untangle init`: a small project on an in-memory file
 * system plus a scripted probe.
 *
 * Nothing here touches the network or the real disk, and the clock is a fake,
 * so the suite proves the same thing on every machine — which is the point,
 * because what `init` writes is supposed to be reproducible.
 */

import { createParserRegistry } from "@untangle-code/parser-registry";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";

import type { EmbedProbeResult, HttpProbePort } from "./types.js";

export const ROOT = "/workspace/demo";

/**
 * A probe with a scripted answer per URL; everything else is unreachable.
 *
 * `embedding` scripts the WP-228 probe of `/api/embed` separately from the
 * GETs, because that is exactly the case the finding is about: `/api/tags`
 * answering while `/api/embed` does not. Its default is a working endpoint,
 * so existing expectations describe a healthy provider unless a test says
 * otherwise.
 */
export function scriptedProbe(
  responses: Readonly<Record<string, unknown>>,
  embedding: EmbedProbeResult = { ok: true, dimensions: 1024 },
): HttpProbePort {
  return {
    getJson(url: string): Promise<unknown | null> {
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(responses, url) ? responses[url] : null,
      );
    },
    probeEmbedding(): Promise<EmbedProbeResult> {
      return Promise.resolve(embedding);
    },
  };
}

/** The probe of the machine this whole work package is about: tags answer, embed hangs. */
export const HANGING_EMBED_PROBE: EmbedProbeResult = {
  ok: false,
  timedOut: true,
  detail: "/api/embed did not respond within the deadline",
};

/** A probe that answers nothing — the "no infrastructure" case. */
export function silentProbe(): HttpProbePort {
  return {
    getJson: () => Promise.resolve(null),
    probeEmbedding: () =>
      Promise.resolve({ ok: false, timedOut: false, detail: "no provider" } as EmbedProbeResult),
  };
}

/**
 * A pnpm monorepo with two packages, a Python service, a JavaScript service
 * and a composition file that ties two containers together — deliberately
 * polyglot, because a census over one language proves nothing about weighting.
 */
export function seedDemoProject(): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock(1_700_000_000_000));
  fs.seedDirectory(ROOT);
  fs.seedFile(
    `${ROOT}/pnpm-workspace.yaml`,
    ["packages:", '  - "packages/*"', '  - "services/*"', ""].join("\n"),
  );
  fs.seedFile(
    `${ROOT}/package.json`,
    JSON.stringify({ name: "demo", private: true, workspaces: ["packages/*"] }, null, 2),
  );
  fs.seedFile(
    `${ROOT}/.gitignore`,
    ["node_modules/", "dist/", "# a comment", "artifacts/", "*.log", "!keep.log", ""].join("\n"),
  );
  fs.seedFile(
    `${ROOT}/docker-compose.yml`,
    [
      "services:",
      "  frontend:",
      "    build:",
      "      context: ./packages/web",
      "    depends_on:",
      "      - backend",
      "    networks: [edge]",
      "  backend:",
      "    build:",
      "      context: ./services/api",
      "    networks: [edge]",
      "  worker:",
      "    image: demo/worker:1",
      "    networks: [edge]",
      "networks:",
      "  edge: {}",
      "",
    ].join("\n"),
  );

  fs.seedFile(
    `${ROOT}/packages/web/package.json`,
    JSON.stringify(
      { name: "@demo/web", version: "1.0.0", dependencies: { "@demo/core": "workspace:*" } },
      null,
      2,
    ),
  );
  fs.seedFile(`${ROOT}/packages/web/src/app.ts`, tsSource(60));
  fs.seedFile(`${ROOT}/packages/web/src/view.tsx`, tsSource(20));

  fs.seedFile(
    `${ROOT}/packages/core/package.json`,
    JSON.stringify({ name: "@demo/core", version: "1.0.0" }, null, 2),
  );
  fs.seedFile(`${ROOT}/packages/core/src/index.ts`, tsSource(40));

  fs.seedFile(
    `${ROOT}/services/api/package.json`,
    JSON.stringify({ name: "@demo/api", version: "1.0.0" }, null, 2),
  );
  fs.seedFile(`${ROOT}/services/api/main.py`, pySource(100));
  fs.seedFile(`${ROOT}/services/api/util.py`, pySource(50));

  // Excluded by the defaults, and therefore must NOT show up in the census.
  fs.seedFile(`${ROOT}/node_modules/left-pad/index.js`, "module.exports = 1;\n");
  fs.seedFile(`${ROOT}/dist/bundle.js`, "console.log(1);\n");
  // Excluded because `.gitignore` names it and the defaults could not know it.
  fs.seedFile(`${ROOT}/artifacts/report.ts`, tsSource(500));
  return fs;
}

export function demoDeps(fs: MemoryFileSystem, http: HttpProbePort) {
  return {
    fs,
    http,
    parserRegistry: createParserRegistry(),
    env: {} as Readonly<Record<string, string | undefined>>,
  };
}

function tsSource(lines: number): string {
  const body: string[] = ["export function generated(): number {"];
  for (let index = 1; index < lines - 1; index += 1) {
    body.push(`  const value${String(index)} = ${String(index)};`);
  }
  body.push("  return 0;", "}");
  return `${body.join("\n")}\n`;
}

function pySource(lines: number): string {
  const body: string[] = ["def generated() -> int:"];
  for (let index = 1; index < lines; index += 1) {
    body.push(`    value_${String(index)} = ${String(index)}`);
  }
  body.push("    return 0");
  return `${body.join("\n")}\n`;
}

/** An `/api/tags` payload shaped exactly like a real provider's. */
export function tagsPayload(): unknown {
  return {
    models: [
      {
        name: "small-embed:300m",
        capabilities: ["embedding"],
        details: { context_length: 2048, embedding_length: 768 },
      },
      {
        name: "wide-embed:0.6b",
        capabilities: ["embedding"],
        details: { context_length: 32768, embedding_length: 1024 },
      },
      { name: "chat-model:8b", capabilities: ["completion", "tools"], details: {} },
    ],
  };
}
