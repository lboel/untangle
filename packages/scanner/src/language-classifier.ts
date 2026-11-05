/**
 * Coarse language classification (spec.md §6.1, §7.2): an extension map for
 * the normal case, plus a shebang/marker content sniff for extensionless
 * files. This is a fast pre-classification for the scanner's own output —
 * the authoritative language/adapter dispatch belongs to parser-registry
 * (architecture.md §6.5), which is free to disagree.
 */
import type { LanguageDetectionSource } from "./types.js";

// MVP + Public Beta languages (spec.md §7.2) plus common structural/text
// formats the scanner needs to tell apart from opaque binaries.
const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  pyi: "python",
  pyw: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  rs: "rust",
  php: "php",
  phtml: "php",
  rb: "ruby",
  // WP-86: die Parser-Registry fuehrt diese Endungen als Ruby beziehungsweise
  // PHP und Swift. Fehlten sie hier, meldete der Scanner "unknown" fuer eine
  // Datei, die der Adapter danach doch tief analysiert — zwei Aussagen ueber
  // dieselbe Datei, von denen eine falsch ist.
  rake: "ruby",
  gemspec: "ruby",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  xml: "xml",
};

/** Extension-based language guess; `undefined` for extensionless or unknown extensions. */
export function detectLanguageByExtension(relativePath: string): string | undefined {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // dot <= 0 covers "no extension" and dotfiles like ".gitignore".
  if (dot <= 0) {
    return undefined;
  }
  const ext = base.slice(dot + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext];
}

interface ContentMarker {
  pattern: RegExp;
  languageId: string;
}

const SHEBANG_MARKERS: readonly ContentMarker[] = [
  { pattern: /^#!.*\bnode\b/, languageId: "javascript" },
  { pattern: /^#!.*\bdeno\b/, languageId: "typescript" },
  { pattern: /^#!.*\bpython[0-9.]*\b/, languageId: "python" },
  { pattern: /^#!.*\b(?:bash|sh|zsh|dash|ksh)\b/, languageId: "shell" },
  { pattern: /^#!.*\bruby\b/, languageId: "ruby" },
  { pattern: /^#!.*\bperl\b/, languageId: "perl" },
];

const CONTENT_MARKERS: readonly ContentMarker[] = [
  { pattern: /^<\?php/, languageId: "php" },
  { pattern: /^<\?xml/, languageId: "xml" },
  { pattern: /^\s*<!DOCTYPE html/i, languageId: "html" },
];

/** Content-based language guess for extensionless files (shebang or leading markers). */
export function detectLanguageFromContent(text: string): string | undefined {
  const head = text.slice(0, 256);
  for (const marker of SHEBANG_MARKERS) {
    if (marker.pattern.test(head)) {
      return marker.languageId;
    }
  }
  for (const marker of CONTENT_MARKERS) {
    if (marker.pattern.test(head)) {
      return marker.languageId;
    }
  }
  return undefined;
}

export interface LanguageDetectionResult {
  languageId: string;
  detectedBy: LanguageDetectionSource;
}

/** Combines extension and content sniffing; `languageId` is "unknown" if neither matches. */
export function detectLanguage(relativePath: string, sampleText: string): LanguageDetectionResult {
  const byExtension = detectLanguageByExtension(relativePath);
  if (byExtension !== undefined) {
    return { languageId: byExtension, detectedBy: "extension" };
  }
  const byContent = detectLanguageFromContent(sampleText);
  if (byContent !== undefined) {
    return { languageId: byContent, detectedBy: "content" };
  }
  return { languageId: "unknown", detectedBy: "unknown" };
}
