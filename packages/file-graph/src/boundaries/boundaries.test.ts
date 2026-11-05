import type {
  HttpBoundaryFileFactsV1,
  HttpServiceBindingV1,
  SourceFile,
} from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import { createPythonAdapter, createTypeScriptAdapter } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { extractHttpBoundaryFacts } from "../../../parser-registry/src/boundaries/extract.js";

import { analyzeHttpBoundaries } from "./index.js";

function facts(path: string, content: string): HttpBoundaryFileFactsV1 {
  const adapter = path.endsWith(".py") ? createPythonAdapter() : createTypeScriptAdapter();
  const source: SourceFile = {
    path,
    content,
    contentHash: sha256Hex(content),
    languageId: adapter.languageId,
    fileId: path,
    repoId: "repo",
    refId: "ref",
    sizeBytes: Buffer.byteLength(content),
  };
  const result = adapter.parse(source);
  expect(result.parseQuality).toBe("complete");
  expect(result.ast).not.toBeNull();
  return extractHttpBoundaryFacts(source, result.ast!, adapter);
}

const services: HttpServiceBindingV1[] = [
  {
    id: "local-api",
    frontendRoots: ["apps/web/src"],
    backendRoots: ["backend/app"],
    sameOrigin: true,
    origins: ["https://api.example.test"],
  },
];
const app = `from fastapi import FastAPI
from app.routes import workflows as flow, health

def create_app():
    app = FastAPI()
    for router in (flow.router, health.router):
        app.include_router(router, prefix="/api/v1")
    return app
app = create_app()
`;
const routes = `from fastapi import APIRouter as Router
router = Router(prefix="/workflows")
@router.get("")
def list_workflows():
    return []
@router.put("/{item_id}")
def update_workflow(item_id):
    return item_id
`;
const health = `from fastapi import APIRouter
router = APIRouter()
@router.get("/health/live")
def health_live():
    return {}
`;

function analyze(client: string, extra: HttpBoundaryFileFactsV1[] = [], binding = services) {
  return analyzeHttpBoundaries({
    files: [
      facts("apps/web/src/api/workflows.ts", client),
      facts("backend/app/main.py", app),
      facts("backend/app/routes/workflows.py", routes),
      facts("backend/app/routes/health.py", health),
      ...extra,
    ],
    services: binding,
  });
}

describe("AST-backed HTTP boundaries", () => {
  it("joins actual fetch method/path with aliased imports, constructor and literal tuple router prefixes", () => {
    const report = analyze(
      `fetch('/api/v1/workflows'); fetch('/api/v1/workflows/123', {method:'PUT'});`,
    );
    expect(
      report.endpoints.map((endpoint) => [endpoint.method, endpoint.path, endpoint.handler]),
    ).toEqual([
      ["GET", "/api/v1/workflows", "list_workflows"],
      ["PUT", "/api/v1/workflows/{item_id}", "update_workflow"],
      ["GET", "/api/v1/health/live", "health_live"],
    ]);
    expect(report.summary).toMatchObject({ resolved: 2, unresolved: 0, ambiguous: 0 });
    expect(report.requests[0]?.targets[0]?.provenance.map((item) => item.kind)).toEqual([
      "router",
      "include",
      "router",
      "route",
    ]);
    expect(report.requests[0]?.source.contentHash).toBe(
      sha256Hex(`fetch('/api/v1/workflows'); fetch('/api/v1/workflows/123', {method:'PUT'});`),
    );
  });

  it("substitutes two local request wrappers and options spreads, retaining caller and transport evidence", () => {
    const report = analyze(`
export function createClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  async function request(path: string, options: RequestInit = {}) {
    return fetcher(\`/api/v1\${path}\`, {...options, credentials: 'same-origin'});
  }
  async function authenticatedRequest(path: string, options: RequestInit = {}) {
    return request(path, options);
  }
  return {
    list() { return authenticatedRequest('/workflows?limit=100#results'); },
    update(id: string) { return authenticatedRequest(\`/workflows/\${encodeURIComponent(id)}\`, {method:'PUT'}); }
  };
}`);
    expect(
      report.requests
        .filter((request) => request.status === "resolved")
        .map((request) => [request.method, request.path]),
    ).toEqual([
      ["GET", "/api/v1/workflows"],
      ["PUT", "/api/v1/workflows/{*}"],
    ]);
    const update = report.requests.find((request) => request.method === "PUT");
    expect(update?.source.name).toBe("authenticatedRequest");
    expect(update?.provenance).toHaveLength(2);
  });

  it("never treats comments, strings or unrelated decorators as HTTP requests/routes", () => {
    const report = analyze(
      `// fetch('/api/v1/workflows')\nconst doc = "fetch('/api/v1/workflows')";\nfunction fetch(path:string) { return path; }\nfetch('/api/v1/workflows');`,
      [
        facts(
          "backend/app/routes/fake.py",
          `class Other:\n    pass\nrouter = Other()\n@router.get('/fake')\ndef fake():\n    return 1\n`,
        ),
      ],
    );
    expect(report.requests).toEqual([]);
    expect(report.endpoints).toHaveLength(3);
    expect(report.limitations.some((entry) => entry.reason.includes("no proven FastAPI"))).toBe(
      true,
    );
  });

  it("requires explicit service/origin binding even when a matching route exists", () => {
    const report = analyze(
      `fetch('/api/v1/workflows'); fetch('https://foreign.example/api/v1/workflows');`,
      [],
      [],
    );
    expect(report.endpoints).toHaveLength(3);
    expect(report.endpoints.every((endpoint) => endpoint.serviceId === null)).toBe(true);
    expect(report.requests.every((request) => request.status === "unresolved")).toBe(true);
    expect(
      report.requests.every((request) => request.reason?.includes("No declared service binding")),
    ).toBe(true);
  });

  it("does not conflate multiple services with identical routes", () => {
    const duplicate = { ...services[0]!, id: "other-api" };
    const report = analyze(`fetch('/api/v1/workflows');`, [], [...services, duplicate]);
    expect(report.requests[0]?.status).toBe("ambiguous");
    expect(report.requests[0]?.targets.map((target) => target.serviceId)).toEqual([
      "local-api",
      "other-api",
    ]);
  });

  it("keeps dynamic origin/method, relative paths and nonmatching methods unresolved", () => {
    const report = analyze(
      `fetch(\`\${origin}/api/v1/workflows\`); fetch('/api/v1/workflows', {method: mode ? 'GET':'POST'}); fetch('api/v1/workflows'); fetch('/api/v1/workflows',{method:'DELETE'});`,
    );
    expect(report.summary.unresolved).toBe(4);
    expect(report.summary.resolved).toBe(0);
    expect(report.requests[0]?.reason).toContain("dynamic");
    expect(report.requests[1]?.reason).toContain("method");
    expect(report.requests[2]?.reason).toContain("root-relative");
    expect(report.requests[3]?.reason).toContain("No mounted route");
  });

  it("keeps plain interpolated path components unresolved and accepts only encoded complete segments", () => {
    const report = analyze(
      `fetch(\`/api/v1/workflows/\${id}\`,{method:'PUT'}); fetch(\`/api/v1/workflows/prefix-\${encodeURIComponent(id)}\`,{method:'PUT'});`,
    );
    expect(report.requests.every((request) => request.status === "unresolved")).toBe(true);
  });

  it("honors absolute origin allowlists and strips only query and fragment", () => {
    const report = analyze(
      `fetch('https://api.example.test/api/v1/workflows?q=1#results'); fetch('https://other.example.test/api/v1/workflows'); fetch('/api/v1/workflows/?q=1');`,
    );
    expect(report.requests.map((request) => request.status)).toEqual([
      "resolved",
      "unresolved",
      "unresolved",
    ]);
    expect(report.requests[0]?.origin).toBe("https://api.example.test");
  });

  it("does not mount an orphan router or invent a dynamic include prefix", () => {
    const orphan = facts(
      "backend/app/orphan.py",
      `from fastapi import APIRouter\nrouter=APIRouter()\n@router.get('/api/v1/orphan')\ndef orphan():\n    return 1\n`,
    );
    const report = analyze(`fetch('/api/v1/orphan');`, [orphan]);
    expect(report.requests[0]?.status).toBe("unresolved");
    expect(report.limitations.some((entry) => entry.reason.includes("not proven mounted"))).toBe(
      true,
    );
    const dynamic = facts(
      "backend/app/main.py",
      app.replace('prefix="/api/v1"', "prefix=settings.prefix"),
    );
    const dynamicReport = analyzeHttpBoundaries({
      files: [
        dynamic,
        facts("backend/app/routes/workflows.py", routes),
        facts("backend/app/routes/health.py", health),
      ],
      services,
    });
    expect(dynamicReport.endpoints).toEqual([]);
    expect(
      dynamicReport.limitations.some((entry) => entry.reason.includes("Dynamic or invalid")),
    ).toBe(true);
  });

  it("reports complete parse gaps and cancels rather than returning an empty success", () => {
    const partial = {
      ...facts("apps/web/src/a.ts", "fetch('/api/v1/workflows')"),
      parseQuality: "partial" as const,
      calls: [],
      limitations: ["HTTP boundary extraction requires a complete parse"],
    };
    expect(analyzeHttpBoundaries({ files: [partial], services }).limitations).toContainEqual({
      path: partial.path,
      reason: "HTTP boundary extraction requires a complete parse",
    });
    expect(() =>
      analyzeHttpBoundaries({ files: [], services, signal: AbortSignal.abort() }),
    ).toThrowError(expect.objectContaining({ code: "JOB_CANCELLED" }));
  });
  it("does not prove a shadowed encoder or mutable transport options", () => {
    const report = analyze(`
function encodeURIComponent(value:string) { return value; }
fetch(\`/api/v1/workflows/\${encodeURIComponent(id)}\`,{method:'PUT'});
const options = { method: 'PUT' };
options.method = 'DELETE';
fetch('/api/v1/workflows/123', options);
let path = '/api/v1/workflows';
fetch(path);
`);
    expect(report.requests).toHaveLength(3);
    expect(report.requests.every((request) => request.status === "unresolved")).toBe(true);
  });

  it("uses exact method and static path segments even around encoded dynamic segments", () => {
    const report = analyze(
      `fetch(\`https://api.example.test/api/v1/workflows/\${encodeURIComponent(id)}\`,{method:'PUT'});fetch('/api/v1/workflows/123/extra',{method:'PUT'});fetch('/api/v1/workflows/%2e%2e',{method:'PUT'});`,
    );
    expect(report.requests.map((request) => request.status)).toEqual([
      "resolved",
      "unresolved",
      "unresolved",
    ]);
    expect(report.requests[0]?.path).toBe("/api/v1/workflows/{*}");
  });

  it("does not resolve a router reassigned after its FastAPI constructor", () => {
    const changed = facts("backend/app/routes/workflows.py", routes + "\nrouter = Other()\n");
    const report = analyzeHttpBoundaries({
      files: [
        facts("backend/app/main.py", app),
        changed,
        facts("backend/app/routes/health.py", health),
        facts("apps/web/src/client.ts", "fetch('/api/v1/workflows')"),
      ],
      services,
    });
    expect(report.requests[0]?.status).toBe("unresolved");
    expect(
      report.limitations.some((entry) =>
        entry.reason.includes("Unresolved router include flow.router"),
      ),
    ).toBe(true);
  });

  it("keeps duplicate route registrations ambiguous, including same-service mounts", () => {
    const duplicated = facts(
      "backend/app/main.py",
      app.replace(
        "    return app",
        '    app.include_router(flow.router, prefix="/api/v1")\n    return app',
      ),
    );
    const report = analyzeHttpBoundaries({
      files: [
        duplicated,
        facts("backend/app/routes/workflows.py", routes),
        facts("backend/app/routes/health.py", health),
        facts("apps/web/src/client.ts", "fetch('/api/v1/workflows')"),
      ],
      services,
    });
    expect(report.requests[0]?.status).toBe("ambiguous");
    expect(report.requests[0]?.targets).toHaveLength(2);
  });

  it("resolves explicit relative Python router import aliases and records include cycles", () => {
    const direct = facts(
      "backend/app/main.py",
      `from fastapi import FastAPI\nfrom .routes.workflows import router as workflow_routes\napp=FastAPI()\napp.include_router(workflow_routes,prefix="/api/v1")\n`,
    );
    const report = analyzeHttpBoundaries({
      files: [
        direct,
        facts("backend/app/routes/workflows.py", routes),
        facts("apps/web/src/client.ts", "fetch('/api/v1/workflows')"),
      ],
      services,
    });
    expect(report.requests[0]?.status).toBe("resolved");
    const cyclic = facts(
      "backend/app/main.py",
      `from fastapi import FastAPI,APIRouter\napp=FastAPI()\nrouter=APIRouter()\nrouter.include_router(router)\napp.include_router(router)\n`,
    );
    expect(
      analyzeHttpBoundaries({ files: [cyclic], services }).limitations.some((entry) =>
        entry.reason.includes("cycle"),
      ),
    ).toBe(true);
  });

  it("does not prove URL reassignment, computed method writes or a rebound fetch", () => {
    const report = analyze(`
let url = '/api/v1/workflows'; url='/elsewhere'; fetch(url);
const options = {method:'PUT'}; options['method']='DELETE';fetch('/api/v1/workflows/123',options);
`);
    expect(report.requests.every((request) => request.status === "unresolved")).toBe(true);
    expect(analyze(`fetch=other;fetch('/api/v1/workflows')`).requests).toEqual([]);
  });
  it("does not use imported router names hidden by registration function parameters", () => {
    const main = facts(
      "backend/app/main.py",
      `from fastapi import FastAPI\nfrom app.routes.workflows import router\napp=FastAPI()\ndef register(router):\n    app.include_router(router,prefix="/api/v1")\n`,
    );
    const report = analyzeHttpBoundaries({
      files: [
        main,
        facts("backend/app/routes/workflows.py", routes),
        facts("apps/web/src/client.ts", "fetch('/api/v1/workflows')"),
      ],
      services,
    });
    expect(report.requests[0]?.status).toBe("unresolved");
    expect(report.endpoints).toEqual([]);
    expect(
      report.limitations.some((entry) => entry.reason.includes("Unresolved router include router")),
    ).toBe(true);
  });
  it("keeps typed and catch-all converters outside the supported matching contract", () => {
    const main = facts(
      "backend/app/main.py",
      `from fastapi import FastAPI\napp=FastAPI()\n@app.get('/api/items/{id:int}')\ndef integer(id): return id\n@app.get('/api/float/{id:float}')\ndef floating(id): return id\n@app.get('/api/uuid/{id:uuid}')\ndef uuid(id): return id\n`,
    );
    const report = analyzeHttpBoundaries({
      files: [
        main,
        facts(
          "apps/web/src/client.ts",
          "fetch('/api/items/not-an-integer');fetch('/api/float/no');fetch('/api/uuid/no')",
        ),
      ],
      services,
    });
    expect(report.requests).toHaveLength(3);
    expect(report.requests.every((request) => request.status === "unresolved")).toBe(true);
    expect(
      report.limitations.filter((entry) => entry.reason.includes("route converters")),
    ).toHaveLength(3);
  });

  it("invalidates options objects escaped by aliases, unknown calls and destructured writes", () => {
    const report = analyze(`
const options1={method:'GET'};Object.assign(options1,{method:'DELETE'});fetch('/api/v1/workflows',options1);
const options2={method:'GET'};const alias=options2;alias.method='DELETE';fetch('/api/v1/workflows',options2);
const options3={method:'GET'};({method:options3.method}={method:'DELETE'});fetch('/api/v1/workflows',options3);
const options4={method:'GET'};mutate(options4);fetch('/api/v1/workflows',options4);
`);
    expect(report.requests).toHaveLength(4);
    expect(report.requests.every((request) => request.status === "unresolved")).toBe(true);
    expect(report.requests.every((request) => request.method === null)).toBe(true);
  });

  it("does not promote mounted subapp declarations to root service endpoints", () => {
    const main = facts(
      "backend/app/main.py",
      `from fastapi import FastAPI\napp=FastAPI()\nsub=FastAPI()\n@sub.get('/tasks')\ndef tasks(): return []\napp.mount('/api',sub)\n`,
    );
    const report = analyzeHttpBoundaries({
      files: [main, facts("apps/web/src/client.ts", "fetch('/tasks');fetch('/api/tasks')")],
      services,
    });
    expect(report.endpoints).toEqual([]);
    expect(report.requests.every((request) => request.status === "unresolved")).toBe(true);
    expect(
      report.limitations.some((entry) => entry.reason.includes("mount routing is unsupported")),
    ).toBe(true);
  });

  it("does not confuse destructured, rest or catch-bound clients with global fetch", () => {
    const cases = [
      "const {fetch}=client;fetch('/api/v1/workflows')",
      "function run({fetch}:{fetch:any}){fetch('/api/v1/workflows')}",
      "function run(...fetch:any[]){fetch('/api/v1/workflows')}",
      "try{work()}catch(fetch){fetch('/api/v1/workflows')}",
    ];
    for (const client of cases) expect(analyze(client).requests, client).toEqual([]);
  });
});
