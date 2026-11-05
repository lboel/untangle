import { describe, expect, it } from "vitest";

import type { DelimiterScanOptions } from "./delimiter-balance.js";
import { describeDelimiterImbalances, findDelimiterImbalances } from "./delimiter-balance.js";

const SQL_LIKE: DelimiterScanOptions = {
  quotes: [
    { open: "'", close: "'", backslashEscapes: true, doubledEscapes: true, spansLines: true },
    { open: '"', close: '"', backslashEscapes: true, doubledEscapes: true, spansLines: true },
    { open: "`", close: "`", backslashEscapes: false, doubledEscapes: true, spansLines: true },
  ],
  brackets: [{ open: "(", close: ")" }],
  lineComments: ["--", "#"],
  blockComment: { open: "/*", close: "*/" },
  dollarQuotedStrings: true,
};

const HCL_LIKE: DelimiterScanOptions = {
  quotes: [
    { open: '"', close: '"', backslashEscapes: true, doubledEscapes: false, spansLines: false },
  ],
  brackets: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: "[", close: "]" },
  ],
  lineComments: ["#", "//"],
  blockComment: { open: "/*", close: "*/" },
  heredocs: "hcl",
};

describe("findDelimiterImbalances", () => {
  it("accepts a well-formed fragment", () => {
    expect(
      findDelimiterImbalances("INSERT INTO t VALUES ('it''s ok; really', 2);", SQL_LIKE),
    ).toEqual([]);
  });

  it("reports an unterminated string literal with its opener and fragment line", () => {
    const found = findDelimiterImbalances("SELECT 1;\nSELECT 'abc", SQL_LIKE);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("unterminated_string");
    expect(found[0]!.delimiter).toBe("'");
    expect(found[0]!.line).toBe(2);
  });

  it("reports an unclosed bracket at the position of its opener", () => {
    const found = findDelimiterImbalances("CREATE TABLE t (id int", SQL_LIKE);
    expect(found.map((entry) => entry.kind)).toEqual(["unclosed_bracket"]);
    expect(found[0]!.offset).toBe("CREATE TABLE t ".length);
  });

  it("reports a closing bracket whose opener is not part of the fragment", () => {
    const found = findDelimiterImbalances(" nested clause, 2);", SQL_LIKE);
    expect(found.map((entry) => entry.kind)).toEqual(["unmatched_closing_bracket"]);
  });

  it("ignores delimiters inside strings, line comments and block comments", () => {
    const text = "SELECT '((( unbalanced' , \"a''b\" -- ) ' (\n/* ) ' ( */ FROM t;";
    expect(findDelimiterImbalances(text, SQL_LIKE)).toEqual([]);
  });

  it("reports an unterminated block comment", () => {
    const found = findDelimiterImbalances("SELECT 1 /* still open", SQL_LIKE);
    expect(found.map((entry) => entry.kind)).toEqual(["unterminated_block_comment"]);
  });

  it("treats a doubled quote as an escape, not as a close-then-reopen", () => {
    expect(findDelimiterImbalances("SELECT 'it''s';", SQL_LIKE)).toEqual([]);
    // Ohne die Verdopplungsregel bliebe hier ein Literal offen.
    expect(findDelimiterImbalances("SELECT 'it''s;", SQL_LIKE).map((e) => e.kind)).toEqual([
      "unterminated_string",
    ]);
  });

  it("treats a backslash as an escape only where the rule says so", () => {
    const withoutBackslash: DelimiterScanOptions = {
      ...SQL_LIKE,
      quotes: [
        { open: "'", close: "'", backslashEscapes: false, doubledEscapes: true, spansLines: true },
      ],
    };
    expect(findDelimiterImbalances("VALUES ('it\\'s a test;", SQL_LIKE).map((e) => e.kind)).toEqual(
      ["unclosed_bracket", "unterminated_string"],
    );
    // Ohne Backslash-Escape schließt `\'` das Literal, die Klammer bleibt trotzdem offen.
    expect(
      findDelimiterImbalances("VALUES ('it\\'s a test;", withoutBackslash).map((e) => e.kind),
    ).toEqual(["unclosed_bracket"]);
  });

  it("handles dollar-quoted literals, including a tagged one", () => {
    expect(findDelimiterImbalances("AS $body$ BEGIN x); END; $body$;", SQL_LIKE)).toEqual([]);
    expect(findDelimiterImbalances("AS $body$ BEGIN x; END;", SQL_LIKE).map((e) => e.kind)).toEqual(
      ["unterminated_string"],
    );
  });

  it("does not mistake an identifier containing two dollar signs for a dollar-quote opener", () => {
    expect(findDelimiterImbalances("SELECT my$col$x FROM t;", SQL_LIKE)).toEqual([]);
  });

  it("treats a heredoc body as raw text, so an embedded script raises no finding", () => {
    const text =
      'resource "a" "b" {\n  user_data = <<-EOT\n    if x; then { echo "unbalanced \'\n  EOT\n}\n';
    expect(findDelimiterImbalances(text, HCL_LIKE)).toEqual([]);
  });

  it("reports a heredoc whose terminator is not part of the fragment", () => {
    const text = 'resource "a" "b" {\n  user_data = <<-EOT\n    echo hi\n';
    expect(findDelimiterImbalances(text, HCL_LIKE).map((entry) => entry.kind)).toEqual([
      "unclosed_bracket",
      "unterminated_heredoc",
    ]);
  });

  it("reports an HCL string that runs past its own line, because HCL strings cannot span lines", () => {
    const found = findDelimiterImbalances('bucket = "unterminated\nother = 1\n', HCL_LIKE);
    expect(found.map((entry) => entry.kind)).toEqual(["unterminated_string"]);
  });

  it("orders findings by offset and caps them, so a wholly broken fragment cannot flood the ledger", () => {
    const found = findDelimiterImbalances("(".repeat(20), SQL_LIKE);
    expect(found).toHaveLength(8);
    expect(found.map((entry) => entry.offset)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("describeDelimiterImbalances", () => {
  it("names the construct, the delimiter and the fragment line", () => {
    const found = findDelimiterImbalances("VALUES ('abc", SQL_LIKE);
    const description = describeDelimiterImbalances(found);
    expect(description).toContain("implausible fragment boundary");
    expect(description).toContain("unclosed bracket");
    expect(description).toContain("unterminated string literal");
    expect(description).toContain("fragment line 1");
  });
});
