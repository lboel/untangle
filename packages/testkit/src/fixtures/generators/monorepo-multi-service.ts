/**
 * WP-44 fixture (docs/BUILD_PLAN.md): `monorepo-multi-service` — a pnpm
 * monorepo of `frontend` + `backend` + `worker` + a `shared` library,
 * linked via `workspace:*`, plus a `docker-compose.yml` wiring three
 * services together with real `depends_on` edges. Consumed by
 * `packages/project-graph` (WP-41) and `packages/deploy-topology` (WP-42)
 * once those packages exist; this generator only produces the fixture
 * itself (out of this package's assigned scope).
 */
import type { GeneratedFixture } from "../types.js";

export function generateMonorepoMultiService(): GeneratedFixture {
  const files = [
    {
      path: "pnpm-workspace.yaml",
      content: "packages:\n  - 'packages/*'\n",
    },
    {
      path: "package.json",
      content: JSON.stringify(
        { name: "monorepo-multi-service-fixture", private: true, workspaces: ["packages/*"] },
        null,
        2,
      ),
    },
    {
      path: "packages/shared/package.json",
      content: JSON.stringify(
        { name: "@fixture/shared", version: "1.0.0", main: "src/index.ts" },
        null,
        2,
      ),
    },
    {
      path: "packages/shared/src/index.ts",
      content: [
        "export interface Task {",
        "  id: string;",
        "  payload: Record<string, unknown>;",
        "}",
        "",
        "export function serializeTask(task: Task): string {",
        "  return JSON.stringify(task);",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "packages/frontend/package.json",
      content: JSON.stringify(
        {
          name: "@fixture/frontend",
          version: "1.0.0",
          main: "src/index.ts",
          dependencies: { "@fixture/shared": "workspace:*" },
        },
        null,
        2,
      ),
    },
    {
      path: "packages/frontend/src/index.ts",
      content: [
        'import { serializeTask, type Task } from "@fixture/shared";',
        "",
        "export function submitTask(task: Task): string {",
        "  return `POST /api/tasks ${serializeTask(task)}`;",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "packages/backend/package.json",
      content: JSON.stringify(
        {
          name: "@fixture/backend",
          version: "1.0.0",
          main: "src/index.ts",
          dependencies: { "@fixture/shared": "workspace:*" },
        },
        null,
        2,
      ),
    },
    {
      path: "packages/backend/src/index.ts",
      content: [
        'import { serializeTask, type Task } from "@fixture/shared";',
        "",
        "export function enqueueTask(task: Task): string {",
        "  return `queue:tasks <- ${serializeTask(task)}`;",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "packages/worker/package.json",
      content: JSON.stringify(
        {
          name: "@fixture/worker",
          version: "1.0.0",
          main: "src/index.ts",
          dependencies: { "@fixture/shared": "workspace:*" },
        },
        null,
        2,
      ),
    },
    {
      path: "packages/worker/src/index.ts",
      content: [
        'import type { Task } from "@fixture/shared";',
        "",
        "export function processTask(task: Task): void {",
        "  // Real work would happen here; the fixture only needs a real,",
        "  // parseable symbol depending on the shared package's type.",
        "  void task;",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "docker-compose.yml",
      content: [
        "services:",
        "  frontend:",
        "    build:",
        "      context: ./packages/frontend",
        "    ports:",
        '      - "3000:3000"',
        "    depends_on:",
        "      - backend",
        "  backend:",
        "    build:",
        "      context: ./packages/backend",
        "    ports:",
        '      - "4000:4000"',
        "    depends_on:",
        "      - worker",
        "  worker:",
        "    build:",
        "      context: ./packages/worker",
        "",
      ].join("\n"),
    },
  ];

  return {
    files,
    groundTruth: {
      description:
        "4-project pnpm monorepo (frontend, backend, worker, shared) linked via workspace:*, plus docker-compose.yml with frontend -> backend -> worker depends_on edges",
      expectedParseQuality: {
        "packages/shared/src/index.ts": "complete",
        "packages/frontend/src/index.ts": "complete",
        "packages/backend/src/index.ts": "complete",
        "packages/worker/src/index.ts": "complete",
      },
      expectedSymbols: ["Task", "serializeTask", "submitTask", "enqueueTask", "processTask"],
    },
  };
}
