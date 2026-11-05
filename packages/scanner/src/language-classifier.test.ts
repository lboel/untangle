import { describe, expect, it } from "vitest";

import {
  detectLanguage,
  detectLanguageByExtension,
  detectLanguageFromContent,
} from "./language-classifier.js";

describe("detectLanguageByExtension", () => {
  it("maps common extensions to language ids", () => {
    expect(detectLanguageByExtension("src/index.ts")).toBe("typescript");
    expect(detectLanguageByExtension("src/App.tsx")).toBe("tsx");
    expect(detectLanguageByExtension("script.py")).toBe("python");
    expect(detectLanguageByExtension("main.go")).toBe("go");
    expect(detectLanguageByExtension("README.md")).toBe("markdown");
    expect(detectLanguageByExtension("package.json")).toBe("json");
  });

  it("is case-insensitive on the extension", () => {
    expect(detectLanguageByExtension("Main.PY")).toBe("python");
  });

  it("returns undefined for an unknown extension", () => {
    expect(detectLanguageByExtension("data.xyz123")).toBeUndefined();
  });

  it("returns undefined for a file with no extension", () => {
    expect(detectLanguageByExtension("Makefile")).toBeUndefined();
  });

  it("treats a leading-dot dotfile as extensionless, not as its own extension", () => {
    expect(detectLanguageByExtension(".gitignore")).toBeUndefined();
  });
});

describe("detectLanguageFromContent", () => {
  it("detects a node shebang as javascript", () => {
    expect(detectLanguageFromContent("#!/usr/bin/env node\nconsole.log(1);\n")).toBe("javascript");
  });

  it("detects a python shebang", () => {
    expect(detectLanguageFromContent("#!/usr/bin/env python3\nprint('hi')\n")).toBe("python");
  });

  it("detects a bash shebang", () => {
    expect(detectLanguageFromContent("#!/bin/bash\necho hi\n")).toBe("shell");
  });

  it("detects a php open tag with no shebang", () => {
    expect(detectLanguageFromContent("<?php\necho 'hi';\n")).toBe("php");
  });

  it("returns undefined when nothing matches", () => {
    expect(detectLanguageFromContent("just some plain text\n")).toBeUndefined();
  });
});

describe("detectLanguage", () => {
  it("prefers the extension over content sniffing", () => {
    const result = detectLanguage("run.sh", "#!/usr/bin/env node\n");
    expect(result).toEqual({ languageId: "shell", detectedBy: "extension" });
  });

  it("falls back to content sniffing for extensionless files", () => {
    const result = detectLanguage("bin/run", "#!/usr/bin/env python3\n");
    expect(result).toEqual({ languageId: "python", detectedBy: "content" });
  });

  it("reports unknown when neither extension nor content match", () => {
    const result = detectLanguage("bin/opaque", "\x01\x02\x03");
    expect(result).toEqual({ languageId: "unknown", detectedBy: "unknown" });
  });
});
