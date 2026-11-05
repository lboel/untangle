/**
 * Minimal block-style YAML subset parser.
 *
 * No YAML/JSON library is added here deliberately (see README
 * "Entscheidungen"): this package's assigned paths cannot touch the
 * workspace root lockfile, so pulling in an external dependency mid-wave
 * would require an edit no other agent could safely race against. Instead
 * this module implements exactly the YAML subset OpenAPI/AsyncAPI/
 * Kubernetes/Compose documents actually use in practice: block mappings
 * and sequences via indentation, single-line flow collections (`{a: 1}`,
 * `[a, b]`), plain/single/double-quoted scalars, `|`/`>` block scalars,
 * `#` comments, and `---`/`...` document separators. NOT supported:
 * anchors/aliases, tags, multi-line flow collections, complex mapping
 * keys. A document using one of those fails to parse — `parseYamlNode`
 * throws `YamlParseError`, which every adapter using this module catches
 * and turns into a visible degrade (architecture.md §22.2: "Parserfehler
 * degradieren auf Textanalyse"), never a crash.
 */

export type YamlScalarValue = string | number | boolean | null;

export interface YamlScalarNode {
  kind: "scalar";
  startLine: number;
  endLine: number;
  value: YamlScalarValue;
}

export interface YamlMapEntry {
  key: string;
  keyLine: number;
  value: YamlNode;
}

export interface YamlMapNode {
  kind: "map";
  startLine: number;
  endLine: number;
  entries: YamlMapEntry[];
}

export interface YamlSeqNode {
  kind: "seq";
  startLine: number;
  endLine: number;
  items: YamlNode[];
}

export type YamlNode = YamlScalarNode | YamlMapNode | YamlSeqNode;

export class YamlParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "YamlParseError";
  }
}

/** One `---`-separated document within a (possibly multi-document) YAML file. */
export interface YamlDocumentSpan {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Splits raw content into `---`-separated document spans (Kubernetes
 * manifests, spec.md §19 "je Dokument eine Ressource"). A leading `---` is
 * just the start of the first document, not an empty document before it. A
 * trailing `...` end-marker line is treated the same as `---` for the
 * purpose of ending a document.
 */
export function splitYamlDocuments(content: string): YamlDocumentSpan[] {
  const lines = content.split("\n");
  const spans: YamlDocumentSpan[] = [];
  let start = 0; // 0-based index into `lines`
  const flush = (endExclusive: number): void => {
    const body = lines.slice(start, endExclusive).join("\n");
    if (body.trim().length > 0) {
      spans.push({ startLine: start + 1, endLine: endExclusive, text: body });
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i] ?? "") || /^\.\.\.\s*$/.test(lines[i] ?? "")) {
      flush(i);
      start = i + 1;
    }
  }
  flush(lines.length);
  return spans;
}

interface PreparedLine {
  /** 1-based line number in the ORIGINAL document text passed to `parseYamlNode`. */
  number: number;
  indent: number;
  /** Content after leading indentation, trailing comment stripped, trailing whitespace trimmed. */
  text: string;
}

function stripTrailingComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && text[i - 1] !== "\\") inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) {
      return text.slice(0, i).replace(/\s+$/, "");
    }
  }
  return text;
}

function prepareLines(text: string, lineOffset: number): PreparedLine[] {
  const rawLines = text.split("\n");
  const prepared: PreparedLine[] = [];
  for (const [index, rawLine] of rawLines.entries()) {
    const lineNumber = lineOffset + index + 1;
    if (rawLine.trim().length === 0) continue;
    const leadingMatch = /^[ ]*/.exec(rawLine);
    const indent = leadingMatch ? leadingMatch[0].length : 0;
    if (/^[ ]*\t/.test(rawLine)) {
      throw new YamlParseError("tab characters are not allowed in indentation", lineNumber);
    }
    const withoutIndent = rawLine.slice(indent);
    if (withoutIndent.startsWith("#")) continue; // full-line comment
    const stripped = stripTrailingComment(withoutIndent).replace(/[ \t]+$/, "");
    if (stripped.length === 0) continue; // comment-only line
    prepared.push({ number: lineNumber, indent, text: stripped });
  }
  return prepared;
}

function parseScalarText(raw: string, line: number): YamlScalarValue {
  const text = raw.trim();
  if (text.length === 0 || text === "~" || text === "null" || text === "Null" || text === "NULL") {
    return null;
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return unescapeDoubleQuoted(text.slice(1, -1), line);
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

function unescapeDoubleQuoted(text: string, line: number): string {
  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        throw new YamlParseError("dangling escape at end of double-quoted scalar", line);
      }
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
      result += map[next] ?? next;
      i += 1;
    } else {
      result += c;
    }
  }
  return result;
}

/** Finds the top-level (unquoted, unbracketed) `:` that separates a mapping key from its value. */
function findKeyColon(text: string, line: number): number {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && text[i - 1] !== "\\") inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "{" || c === "[") {
      depth += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      depth -= 1;
      continue;
    }
    if (c === ":" && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1] ?? ""))) {
      return i;
    }
  }
  throw new YamlParseError(`expected a mapping "key:" or a sequence "- item", got "${text}"`, line);
}

function parseKeyText(rawKey: string): string {
  const key = rawKey.trim();
  if (key.startsWith('"') && key.endsWith('"') && key.length >= 2) return key.slice(1, -1);
  if (key.startsWith("'") && key.endsWith("'") && key.length >= 2) return key.slice(1, -1);
  return key;
}

// --- Flow collections (`{...}` / `[...]`), single physical line only. ---

interface FlowCursor {
  text: string;
  pos: number;
  line: number;
}

function skipFlowSpace(cursor: FlowCursor): void {
  while (cursor.pos < cursor.text.length && /\s/.test(cursor.text[cursor.pos] ?? "")) {
    cursor.pos += 1;
  }
}

function parseFlowValue(cursor: FlowCursor): YamlNode {
  skipFlowSpace(cursor);
  const c = cursor.text[cursor.pos];
  if (c === "{") return parseFlowMap(cursor);
  if (c === "[") return parseFlowSeq(cursor);
  return parseFlowScalar(cursor);
}

function parseFlowScalar(cursor: FlowCursor): YamlScalarNode {
  const start = cursor.pos;
  if (cursor.text[cursor.pos] === '"' || cursor.text[cursor.pos] === "'") {
    const quote: string = cursor.text[cursor.pos]!;
    cursor.pos += 1;
    let raw = quote;
    while (cursor.pos < cursor.text.length && cursor.text[cursor.pos] !== quote) {
      if (cursor.text[cursor.pos] === "\\" && quote === '"') {
        raw += cursor.text.slice(cursor.pos, cursor.pos + 2);
        cursor.pos += 2;
        continue;
      }
      raw += cursor.text[cursor.pos] ?? "";
      cursor.pos += 1;
    }
    raw += quote;
    cursor.pos += 1;
    return {
      kind: "scalar",
      startLine: cursor.line,
      endLine: cursor.line,
      value: parseScalarText(raw, cursor.line),
    };
  }
  while (cursor.pos < cursor.text.length && !",]}".includes(cursor.text[cursor.pos] ?? "")) {
    cursor.pos += 1;
  }
  const raw = cursor.text.slice(start, cursor.pos).trim();
  return {
    kind: "scalar",
    startLine: cursor.line,
    endLine: cursor.line,
    value: parseScalarText(raw, cursor.line),
  };
}

function parseFlowSeq(cursor: FlowCursor): YamlSeqNode {
  const startLine = cursor.line;
  cursor.pos += 1; // consume '['
  const items: YamlNode[] = [];
  skipFlowSpace(cursor);
  while (cursor.pos < cursor.text.length && cursor.text[cursor.pos] !== "]") {
    items.push(parseFlowValue(cursor));
    skipFlowSpace(cursor);
    if (cursor.text[cursor.pos] === ",") {
      cursor.pos += 1;
      skipFlowSpace(cursor);
    }
  }
  if (cursor.text[cursor.pos] !== "]") {
    throw new YamlParseError("unterminated flow sequence (missing ']')", cursor.line);
  }
  cursor.pos += 1;
  return { kind: "seq", startLine, endLine: cursor.line, items };
}

function parseFlowMap(cursor: FlowCursor): YamlMapNode {
  const startLine = cursor.line;
  cursor.pos += 1; // consume '{'
  const entries: YamlMapEntry[] = [];
  skipFlowSpace(cursor);
  while (cursor.pos < cursor.text.length && cursor.text[cursor.pos] !== "}") {
    const keyStart = cursor.pos;
    while (cursor.pos < cursor.text.length && cursor.text[cursor.pos] !== ":") {
      cursor.pos += 1;
    }
    const key = parseKeyText(cursor.text.slice(keyStart, cursor.pos));
    if (cursor.text[cursor.pos] !== ":") {
      throw new YamlParseError("expected ':' in flow mapping entry", cursor.line);
    }
    cursor.pos += 1;
    const value = parseFlowValue(cursor);
    entries.push({ key, keyLine: cursor.line, value });
    skipFlowSpace(cursor);
    if (cursor.text[cursor.pos] === ",") {
      cursor.pos += 1;
      skipFlowSpace(cursor);
    }
  }
  if (cursor.text[cursor.pos] !== "}") {
    throw new YamlParseError("unterminated flow mapping (missing '}')", cursor.line);
  }
  cursor.pos += 1;
  return { kind: "map", startLine, endLine: cursor.line, entries };
}

function parseFlow(text: string, line: number): YamlNode {
  const cursor: FlowCursor = { text, pos: 0, line };
  const node = parseFlowValue(cursor);
  skipFlowSpace(cursor);
  if (cursor.pos !== text.length) {
    throw new YamlParseError(
      "trailing content after flow collection (multi-line flow is not supported)",
      line,
    );
  }
  return node;
}

// --- Block parsing. ---

interface BlockResult {
  node: YamlNode;
  nextIndex: number;
}

function parseBlock(lines: PreparedLine[], startIndex: number, indent: number): BlockResult {
  const first = lines[startIndex];
  if (first === undefined) {
    throw new YamlParseError("unexpected end of document", lines[startIndex - 1]?.number ?? 0);
  }
  if (first.text === "-" || first.text.startsWith("- ")) {
    return parseSequence(lines, startIndex, indent);
  }
  return parseMapping(lines, startIndex, indent);
}

function parseSequence(lines: PreparedLine[], startIndex: number, indent: number): BlockResult {
  const items: YamlNode[] = [];
  let i = startIndex;
  const startLine = lines[startIndex]!.number;
  let endLine = startLine;
  while (i < lines.length) {
    const line = lines[i];
    if (
      line === undefined ||
      line.indent !== indent ||
      !(line.text === "-" || line.text.startsWith("- "))
    ) {
      break;
    }
    const rest = line.text === "-" ? "" : line.text.slice(2);
    if (rest.trim().length === 0) {
      i += 1;
      const next = lines[i];
      if (next !== undefined && next.indent > indent) {
        const nested = parseBlock(lines, i, next.indent);
        items.push(nested.node);
        endLine = nested.node.endLine;
        i = nested.nextIndex;
      } else {
        items.push({ kind: "scalar", startLine: line.number, endLine: line.number, value: null });
        endLine = line.number;
      }
      continue;
    }
    if (rest.trimStart().startsWith("{") || rest.trimStart().startsWith("[")) {
      const node = parseFlow(rest.trim(), line.number);
      items.push(node);
      endLine = node.endLine;
      i += 1;
      continue;
    }
    // "- key: value" (mapping shorthand) — rewrite as a mapping continued by
    // any following lines indented to align with where "key" started.
    const virtualIndent = indent + (line.text.length - rest.length);
    const isMapEntry = looksLikeMapKey(rest);
    if (isMapEntry) {
      const rewritten: PreparedLine[] = [
        { number: line.number, indent: virtualIndent, text: rest },
        ...lines.slice(i + 1),
      ];
      const nested = parseMapping(rewritten, 0, virtualIndent);
      items.push(nested.node);
      endLine = nested.node.endLine;
      i = i + nested.nextIndex; // rewritten[0] === original index i
      continue;
    }
    const scalar = parseScalarNode(rest, line.number);
    items.push(scalar);
    endLine = scalar.endLine;
    i += 1;
  }
  return { node: { kind: "seq", startLine, endLine, items }, nextIndex: i };
}

function looksLikeMapKey(text: string): boolean {
  try {
    findKeyColon(text, 0);
    return true;
  } catch {
    return false;
  }
}

function parseScalarNode(rest: string, line: number): YamlScalarNode {
  const trimmed = rest.trim();
  if (trimmed.startsWith("|") || trimmed.startsWith(">")) {
    // A block scalar indicator with no following indented lines here just
    // degrades to an empty string — the multi-line case is handled in
    // parseMapping, which owns the following-lines lookahead.
    return { kind: "scalar", startLine: line, endLine: line, value: "" };
  }
  return { kind: "scalar", startLine: line, endLine: line, value: parseScalarText(trimmed, line) };
}

function parseMapping(lines: PreparedLine[], startIndex: number, indent: number): BlockResult {
  const entries: YamlMapEntry[] = [];
  let i = startIndex;
  const startLine = lines[startIndex]!.number;
  let endLine = startLine;
  while (i < lines.length) {
    const line = lines[i];
    if (
      line === undefined ||
      line.indent !== indent ||
      line.text === "-" ||
      line.text.startsWith("- ")
    ) {
      break;
    }
    const colonIndex = findKeyColon(line.text, line.number);
    const key = parseKeyText(line.text.slice(0, colonIndex));
    const rawValue = line.text.slice(colonIndex + 1).trim();

    if (rawValue.length === 0) {
      i += 1;
      const next = lines[i];
      if (next !== undefined && next.indent > indent) {
        const nested = parseBlock(lines, i, next.indent);
        entries.push({ key, keyLine: line.number, value: nested.node });
        endLine = nested.node.endLine;
        i = nested.nextIndex;
      } else {
        entries.push({
          key,
          keyLine: line.number,
          value: { kind: "scalar", startLine: line.number, endLine: line.number, value: null },
        });
        endLine = line.number;
      }
      continue;
    }

    if (rawValue.startsWith("|") || rawValue.startsWith(">")) {
      const folded = rawValue.startsWith(">");
      i += 1;
      const blockIndent = lines[i]?.indent;
      const collected: string[] = [];
      let lastLine = line.number;
      while (
        i < lines.length &&
        blockIndent !== undefined &&
        (lines[i]?.indent ?? -1) >= blockIndent
      ) {
        const current = lines[i]!;
        collected.push(current.text);
        lastLine = current.number;
        i += 1;
      }
      const value = folded ? collected.join(" ") : collected.join("\n");
      entries.push({
        key,
        keyLine: line.number,
        value: { kind: "scalar", startLine: line.number, endLine: lastLine, value },
      });
      endLine = lastLine;
      continue;
    }

    if (rawValue.startsWith("{") || rawValue.startsWith("[")) {
      const node = parseFlow(rawValue, line.number);
      entries.push({ key, keyLine: line.number, value: node });
      endLine = node.endLine;
      i += 1;
      continue;
    }

    const scalar = parseScalarNode(rawValue, line.number);
    entries.push({ key, keyLine: line.number, value: scalar });
    endLine = scalar.endLine;
    i += 1;
  }
  return { node: { kind: "map", startLine, endLine, entries }, nextIndex: i };
}

/**
 * Parses one YAML document's full text (e.g. one `splitYamlDocuments()`
 * span) into a `YamlNode` tree. Line numbers on every node are 1-based
 * WITHIN `text` — add `lineOffset` (a span's `startLine - 1`) yourself when
 * mapping back to the original multi-document file. Returns `null` for a
 * document that is empty or comments-only. Throws `YamlParseError` (never
 * any other error type) on anything outside the supported subset.
 */
export function parseYamlNode(text: string, lineOffset = 0): YamlNode | null {
  const lines = prepareLines(text, lineOffset);
  if (lines.length === 0) return null;
  const result = parseBlock(lines, 0, lines[0]!.indent);
  if (result.nextIndex !== lines.length) {
    const trailing = lines[result.nextIndex];
    throw new YamlParseError(
      "unexpected indentation / trailing content at document top level",
      trailing?.number ?? lines.at(-1)!.number,
    );
  }
  return result.node;
}

// --- Small walk helpers used by adapters. ---

export function mapGet(node: YamlNode | null | undefined, key: string): YamlNode | undefined {
  if (node === undefined || node === null || node.kind !== "map") return undefined;
  return node.entries.find((entry) => entry.key === key)?.value;
}

export function scalarString(node: YamlNode | null | undefined): string | undefined {
  if (node === undefined || node === null || node.kind !== "scalar" || node.value === null) {
    return undefined;
  }
  return String(node.value);
}
