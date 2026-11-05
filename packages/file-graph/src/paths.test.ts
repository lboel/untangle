import { describe, expect, it } from "vitest";

import {
  basenameOf,
  dirnameOf,
  extensionOf,
  isRelativeSpecifier,
  isWithin,
  joinRelative,
  normalizePath,
  relativeWithin,
} from "./paths.js";

describe("normalizePath", () => {
  it("turns backslashes into forward slashes so two operating systems agree", () => {
    expect(normalizePath("src\\a\\b.ts")).toBe("src/a/b.ts");
  });

  it("collapses repeated slashes and strips a leading ./ or /", () => {
    expect(normalizePath(".//src///a.ts")).toBe("src/a.ts");
    expect(normalizePath("/src/a.ts")).toBe("src/a.ts");
  });

  it("drops a trailing slash but keeps a single-slash root", () => {
    expect(normalizePath("src/a/")).toBe("src/a");
    expect(normalizePath("/")).toBe("");
  });
});

describe("dirnameOf / basenameOf / extensionOf", () => {
  it("splits a repo-relative path", () => {
    expect(dirnameOf("packages/a/src/index.ts")).toBe("packages/a/src");
    expect(basenameOf("packages/a/src/index.ts")).toBe("index.ts");
    expect(extensionOf("packages/a/src/index.ts")).toBe(".ts");
  });

  it("reports no directory and no extension for a bare dotfile", () => {
    expect(dirnameOf(".gitignore")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("joinRelative", () => {
  it("resolves . and .. segments", () => {
    expect(joinRelative("src/a", "./b.ts")).toBe("src/a/b.ts");
    expect(joinRelative("src/a", "../b.ts")).toBe("src/b.ts");
    expect(joinRelative("src/a/b", "../../c.ts")).toBe("src/c.ts");
  });

  it("returns null instead of silently clamping at the repository root", () => {
    // Ein still auf "etc/passwd" gekuerzter Treffer waere schlimmer als ein
    // benannter Fehlschlag — genau deshalb null.
    expect(joinRelative("src", "../../etc/passwd")).toBeNull();
  });
});

describe("isWithin / relativeWithin", () => {
  it("treats the empty directory as the repository root", () => {
    expect(isWithin("", "a/b.ts")).toBe(true);
    expect(relativeWithin("", "a/b.ts")).toBe("a/b.ts");
  });

  it("does not treat a name prefix as containment", () => {
    expect(isWithin("packages/a", "packages/ab/x.ts")).toBe(false);
    expect(relativeWithin("packages/a", "packages/ab/x.ts")).toBeNull();
  });
});

describe("isRelativeSpecifier", () => {
  it("accepts ./ and ../ forms but not package names or python dotted modules", () => {
    expect(isRelativeSpecifier("./a")).toBe(true);
    expect(isRelativeSpecifier("../a")).toBe(true);
    expect(isRelativeSpecifier("react")).toBe(false);
    expect(isRelativeSpecifier(".pkg.mod")).toBe(false);
  });
});
