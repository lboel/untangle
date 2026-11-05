import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { FixtureBuilder } from "../fixture-builder.js";

import { generateDependencyCycle } from "./dependency-cycle.js";
import { generateLargeFunction } from "./large-function.js";
import { generateMinifiedFile } from "./minified-file.js";
import { generateMonorepoMultiService } from "./monorepo-multi-service.js";
import { generateParseError } from "./parse-error.js";
import { generatePythonMultiPackage } from "./python-multi-package.js";
import { generateRenameAcrossFiles } from "./rename-across-files.js";
import { generateTypescriptMonorepo } from "./typescript-monorepo.js";

const execFileAsync = promisify(execFile);

/** Real syntax check via the TypeScript compiler's own per-file transpiler. */
function tsDiagnosticCount(content: string): number {
  const result = ts.transpileModule(content, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  return result.diagnostics?.length ?? 0;
}

function tsFiles(files: { path: string; content: string }[]): { path: string; content: string }[] {
  return files.filter((f) => f.path.endsWith(".ts"));
}

describe("generateTypescriptMonorepo", () => {
  it("every .ts file is real, syntactically valid TypeScript (zero parse diagnostics)", () => {
    const { files } = generateTypescriptMonorepo();
    for (const file of tsFiles(files)) {
      expect(tsDiagnosticCount(file.content), file.path).toBe(0);
    }
  });

  it("cli package.json declares a workspace:* dependency on the core package", () => {
    const { files } = generateTypescriptMonorepo();
    const pkg = files.find((f) => f.path === "packages/cli/package.json");
    const parsed = JSON.parse(pkg?.content ?? "{}") as { dependencies?: Record<string, string> };
    expect(parsed.dependencies?.["@fixture/core"]).toBe("workspace:*");
  });
});

describe("generateDependencyCycle", () => {
  it("every file is syntactically valid TypeScript", () => {
    const { files } = generateDependencyCycle();
    for (const file of tsFiles(files)) {
      expect(tsDiagnosticCount(file.content), file.path).toBe(0);
    }
  });

  it("ground truth names exactly the three cycle participants, excluding the standalone control", () => {
    const { groundTruth } = generateDependencyCycle();
    expect(groundTruth.cycleParticipants?.sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("the import chain genuinely closes: a imports b, b imports c, c imports a", () => {
    const { files } = generateDependencyCycle();
    const byPath = new Map(files.map((f) => [f.path, f.content]));
    expect(byPath.get("src/a.ts")).toContain('from "./b.js"');
    expect(byPath.get("src/b.ts")).toContain('from "./c.js"');
    expect(byPath.get("src/c.ts")).toContain('from "./a.js"');
  });
});

describe("generateMinifiedFile", () => {
  it("the minified file is genuinely a single physical line", () => {
    const { files } = generateMinifiedFile();
    const minified = files.find((f) => f.path.endsWith(".min.js"));
    expect(minified?.content.split("\n")).toHaveLength(1);
  });

  it("the minified line is itself syntactically valid JavaScript", () => {
    const { files } = generateMinifiedFile();
    const minified = files.find((f) => f.path.endsWith(".min.js"));
    expect(tsDiagnosticCount(minified?.content ?? "")).toBe(0);
  });

  it("the readable source is syntactically valid too", () => {
    const { files } = generateMinifiedFile();
    const source = files.find((f) => f.path === "src/bundle.js");
    expect(tsDiagnosticCount(source?.content ?? "")).toBe(0);
  });
});

describe("generateParseError", () => {
  it("broken.ts genuinely fails to parse (real, non-zero diagnostics)", () => {
    const { files } = generateParseError();
    const broken = files.find((f) => f.path === "src/broken.ts");
    expect(tsDiagnosticCount(broken?.content ?? "")).toBeGreaterThan(0);
  });

  it("partial.ts contains real valid symbols before its syntax error", () => {
    const { files } = generateParseError();
    const partial = files.find((f) => f.path === "src/partial.ts");
    expect(tsDiagnosticCount(partial?.content ?? "")).toBeGreaterThan(0);
    expect(partial?.content).toContain("export function valid(");
    expect(partial?.content).toContain("export function alsoValid(");
  });

  it("clean.ts is genuinely valid (zero diagnostics), as a negative control", () => {
    const { files } = generateParseError();
    const clean = files.find((f) => f.path === "src/clean.ts");
    expect(tsDiagnosticCount(clean?.content ?? "")).toBe(0);
  });
});

describe("generateLargeFunction", () => {
  it("is syntactically valid and substantial (spanning many lines, several branch keywords)", () => {
    const { files } = generateLargeFunction();
    const file = files[0];
    expect(file).toBeDefined();
    expect(tsDiagnosticCount(file?.content ?? "")).toBe(0);
    const lineCount = (file?.content ?? "").split("\n").length;
    expect(lineCount).toBeGreaterThan(40);
    const body = file?.content ?? "";
    for (const keyword of ["if (", "else", "switch (", "for (", "try {", "catch"]) {
      expect(body, keyword).toContain(keyword);
    }
  });
});

describe("generateMonorepoMultiService (WP-44)", () => {
  it("every .ts file is syntactically valid", () => {
    const { files } = generateMonorepoMultiService();
    for (const file of tsFiles(files)) {
      expect(tsDiagnosticCount(file.content), file.path).toBe(0);
    }
  });

  it("frontend, backend and worker each depend on shared via workspace:*", () => {
    const { files } = generateMonorepoMultiService();
    for (const name of ["frontend", "backend", "worker"]) {
      const pkg = files.find((f) => f.path === `packages/${name}/package.json`);
      const parsed = JSON.parse(pkg?.content ?? "{}") as { dependencies?: Record<string, string> };
      expect(parsed.dependencies?.["@fixture/shared"], name).toBe("workspace:*");
    }
  });

  it("docker-compose.yml wires exactly three services with the expected depends_on edges", () => {
    const { files } = generateMonorepoMultiService();
    const compose = files.find((f) => f.path === "docker-compose.yml")?.content ?? "";
    expect(compose).toContain("frontend:");
    expect(compose).toContain("backend:");
    expect(compose).toContain("worker:");
    expect(compose.match(/depends_on:/g)).toHaveLength(2);
  });
});

describe("generateRenameAcrossFiles", () => {
  it("before and after are both syntactically valid TypeScript", () => {
    const { before, after } = generateRenameAcrossFiles();
    for (const file of [...before, ...after]) {
      expect(tsDiagnosticCount(file.content), file.path).toBe(0);
    }
  });

  it("the old path is present only in 'before', the new path only in 'after'", () => {
    const { before, after, groundTruth } = generateRenameAcrossFiles();
    expect(before.some((f) => f.path === groundTruth.oldPath)).toBe(true);
    expect(after.some((f) => f.path === groundTruth.oldPath)).toBe(false);
    expect(before.some((f) => f.path === groundTruth.newPath)).toBe(false);
    expect(after.some((f) => f.path === groundTruth.newPath)).toBe(true);
  });

  it("report.ts's import is updated to the new path in 'after'", () => {
    const { after } = generateRenameAcrossFiles();
    const report = after.find((f) => f.path === "src/report.ts");
    expect(report?.content).toContain("./formatting/date-format.js");
  });
});

describe("generatePythonMultiPackage", () => {
  it("every .py file is real, syntactically valid Python 3 (verified by python3 -m py_compile on real disk)", async () => {
    const { files } = generatePythonMultiPackage();
    const workspace = await new FixtureBuilder().repo("py", files).build();
    try {
      const pyFiles = files.filter((f) => f.path.endsWith(".py"));
      expect(pyFiles.length).toBeGreaterThan(0);
      for (const file of pyFiles) {
        await expect(
          execFileAsync("python3", [
            "-m",
            "py_compile",
            `${workspace.repoPaths["py"]}/${file.path}`,
          ]),
        ).resolves.toBeDefined();
      }
    } finally {
      await workspace.cleanup();
    }
  }, 20_000);

  it("cli.main imports the geometry package", () => {
    const { files } = generatePythonMultiPackage();
    const main = files.find((f) => f.path === "packages/cli/cli/main.py");
    expect(main?.content).toContain("from geometry.shapes import");
  });
});
