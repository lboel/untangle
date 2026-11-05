import { describe, expect, it } from "vitest";

import { createParserRegistry } from "./index.js";

describe("createParserRegistry", () => {
  // WP-86 hat diese Liste um NEUN Sprachen verlaengert (Java, C#, Ruby, PHP,
  // Kotlin, C, C++, Swift, Bash). Sie steht hier vollstaendig und sortiert,
  // damit eine hinzugefuegte oder verschwundene Sprache auffaellt, statt sich
  // in einer `toContain`-Pruefung zu verstecken.
  it("registers all 19 languages, including Vue script analysis", () => {
    const registry = createParserRegistry();
    expect(
      registry
        .listAdapters()
        .map((a) => a.languageId)
        .sort(),
    ).toEqual([
      "c",
      "cpp",
      "csharp",
      "go",
      "java",
      "javascript",
      "jsx",
      "kotlin",
      "markdown",
      "php",
      "python",
      "ruby",
      "rust",
      "shell",
      "structured-text",
      "swift",
      "tsx",
      "typescript",
      "vue",
    ]);
  });

  // WP-220: Go und Rust laufen ueber das ast-grep-Backend. Ihre Anmeldung
  // darf so wenig kosten wie jede andere — insbesondere darf sie WEDER
  // `@ast-grep/napi` NOCH eine Grammatik laden. Die Zusage prueft dieser Test
  // ueber `require.cache`: nach `createParserRegistry()` darf kein
  // ast-grep-Modul geladen sein.
  it("laedt beim Anmelden der ast-grep-Sprachen keine native Grammatik", () => {
    createParserRegistry();
    const loaded = Object.keys(
      (globalThis as { require?: { cache?: Record<string, unknown> } }).require?.cache ?? {},
    );
    expect(loaded.some((path) => path.includes("@ast-grep"))).toBe(false);
  });

  // WP-110/WP-217: Prosa und strukturierte Daten sind Stufe `text` — nicht
  // `unsupported_language` (vision.md §1c, spec.md §7.2).
  it("resolves text formats to a text-level adapter instead of null", () => {
    const registry = createParserRegistry();
    for (const path of ["README.md", "a.markdown", "a.mdx", "notes.txt", "a.rst"]) {
      const adapter = registry.getAdapterForPath(path);
      expect(adapter?.languageId, path).toBe("markdown");
      expect(adapter?.supportLevel, path).toBe("text");
    }
    for (const path of ["package.json", "untangle.toml", "ci.yml", "a.yaml", "a.xml"]) {
      const adapter = registry.getAdapterForPath(path);
      expect(adapter?.languageId, path).toBe("structured-text");
      expect(adapter?.supportLevel, path).toBe("text");
    }
  });

  it("resolves every MVP extension to the right adapter", () => {
    const registry = createParserRegistry();
    expect(registry.getAdapterForPath("a.ts")?.languageId).toBe("typescript");
    expect(registry.getAdapterForPath("a.mts")?.languageId).toBe("typescript");
    expect(registry.getAdapterForPath("a.cts")?.languageId).toBe("typescript");
    expect(registry.getAdapterForPath("a.tsx")?.languageId).toBe("tsx");
    expect(registry.getAdapterForPath("a.js")?.languageId).toBe("javascript");
    expect(registry.getAdapterForPath("a.mjs")?.languageId).toBe("javascript");
    expect(registry.getAdapterForPath("a.cjs")?.languageId).toBe("javascript");
    expect(registry.getAdapterForPath("a.jsx")?.languageId).toBe("jsx");
    expect(registry.getAdapterForPath("a.py")?.languageId).toBe("python");
  });

  it("resolves the ast-grep-backed extensions", () => {
    const registry = createParserRegistry();
    // WP-220
    expect(registry.getAdapterForPath("main.go")?.languageId).toBe("go");
    expect(registry.getAdapterForPath("lib.rs")?.languageId).toBe("rust");
    // WP-86 — eine Zeile je Sprache, damit eine verlorene Endung auffaellt.
    expect(registry.getAdapterForPath("Ledger.java")?.languageId).toBe("java");
    expect(registry.getAdapterForPath("Cache.cs")?.languageId).toBe("csharp");
    expect(registry.getAdapterForPath("report.rb")?.languageId).toBe("ruby");
    expect(registry.getAdapterForPath("Invoice.php")?.languageId).toBe("php");
    expect(registry.getAdapterForPath("Cache.kt")?.languageId).toBe("kotlin");
    expect(registry.getAdapterForPath("ring.c")?.languageId).toBe("c");
    expect(registry.getAdapterForPath("ring.h")?.languageId).toBe("c");
    expect(registry.getAdapterForPath("matrix.cpp")?.languageId).toBe("cpp");
    expect(registry.getAdapterForPath("matrix.hpp")?.languageId).toBe("cpp");
    expect(registry.getAdapterForPath("Store.swift")?.languageId).toBe("swift");
    expect(registry.getAdapterForPath("deploy.sh")?.languageId).toBe("shell");
    expect(registry.getAdapterForPath("deploy.bash")?.languageId).toBe("shell");
    for (const languageId of [
      "go",
      "rust",
      "java",
      "csharp",
      "ruby",
      "php",
      "kotlin",
      "c",
      "cpp",
      "swift",
      "shell",
    ]) {
      expect(registry.supportLevelOf(languageId), languageId).toBe("deep");
    }
  });

  it("returns null for a genuinely unsupported extension", () => {
    const registry = createParserRegistry();
    // Frueher stand hier `a.rb` — Ruby ist seit WP-86 unterstuetzt. Als
    // Gegenprobe dient jetzt eine Sprache, fuer die wir WEDER eine Tabelle
    // noch eine Grammatik haben.
    expect(registry.getAdapterForPath("a.erl")).toBeNull();
    expect(registry.getAdapterByLanguage("erlang")).toBeNull();
  });
});
