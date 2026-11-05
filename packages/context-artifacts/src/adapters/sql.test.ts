import type { ArtifactChunk, ArtifactDocument } from "@untangle-code/domain";
import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import type { ArtifactSkipLedgerEntry } from "../coverage.js";
import { buildArtifactSkipLedger } from "../coverage.js";
import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import type { SqlAdapterOptions } from "./sql.js";
import { createSqlAdapter, DEFAULT_SQL_DIALECT } from "./sql.js";

const SCHEMA_FIXTURE = `-- schema for the orders service
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' -- semicolons in comments; must not split statements
);

CREATE TABLE order_items (
  order_id UUID NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_orders_customer ON orders (customer_id);

CREATE VIEW open_orders AS
  SELECT * FROM orders WHERE status <> 'closed';

ALTER TABLE order_items ADD CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id);

INSERT INTO orders (id, customer_id, total_cents, status) VALUES ('seed', 'seed', 0, 'pending');
`;

describe("createSqlAdapter", () => {
  const adapter = createSqlAdapter();

  it("supports() matches by extension and explicit type", () => {
    expect(adapter.supports("sql", "anything")).toBe(true);
    expect(adapter.supports("auto", "db/schema.sql")).toBe(true);
    expect(adapter.supports("auto", "db/schema.txt")).toBe(false);
  });

  it("golden: tables, views, indexes and constraints as separate sections, semicolons-in-comments/strings don't split", async () => {
    const config = artifactConfig({ name: "orders-schema", path: "db/schema.sql", type: "sql" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("db/schema.sql", SCHEMA_FIXTURE)],
    });
    expect(document!.type).toBe("sql");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual([
      "sql_table",
      "sql_table",
      "sql_index",
      "sql_view",
      "sql_constraint",
      "sql_statement",
    ]);

    assertGoldenJson("orders-schema-statements", chunks.map(projectChunk), {
      metaUrl: import.meta.url,
    });
  });

  // --- WP-81 review regressions (reproduced verbatim against the built dist/ code) ---

  it("WP-81 case 1: a final statement missing its terminating semicolon still becomes its own chunk", async () => {
    const content = "CREATE TABLE foo (id int);\nCREATE TABLE bar (id int, name text)\n";
    const config = artifactConfig({
      name: "no-final-semicolon",
      path: "db/schema.sql",
      type: "sql",
    });
    const [document] = await adapter.read({ config, files: [inputFile("db/schema.sql", content)] });

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual(["sql_table", "sql_table"]);
    expect(chunks.map((c) => c.title)).toEqual(["foo", "bar"]);
    expect(chunks[1]!.content).toContain("CREATE TABLE bar");

    // E4: no gap, no phantom/degenerate chunk — the missing terminator does
    // not even show up as something to explain, because nothing was lost.
    expect(buildArtifactSkipLedger(document!, chunks)).toEqual([]);
  });

  it("WP-81 case 2: two statements sharing one physical line both become their own, correctly classified chunk", async () => {
    const content = "CREATE TABLE foo (id int); CREATE TABLE bar (id int);\n";
    const config = artifactConfig({ name: "two-per-line", path: "db/schema.sql", type: "sql" });
    const [document] = await adapter.read({ config, files: [inputFile("db/schema.sql", content)] });

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual(["sql_table", "sql_table"]);
    expect(chunks.map((c) => c.title)).toEqual(["foo", "bar"]);
    // Byte ranges are non-empty, non-overlapping and cover the line exactly.
    expect(chunks[0]!.range.startByte).toBeLessThan(chunks[0]!.range.endByte);
    expect(chunks[1]!.range.startByte).toEqual(chunks[0]!.range.endByte);
    expect(chunks[1]!.range.startByte).toBeLessThan(chunks[1]!.range.endByte);

    // The exact review finding: the skip ledger must not be blind here —
    // there is no byte gap AND no degenerate/conflicting chunk, because the
    // fix is in the adapter itself; see coverage.test.ts for the ledger's
    // own, adapter-independent guard against this defect class.
    expect(buildArtifactSkipLedger(document!, chunks)).toEqual([]);
  });

  // --- WP-118: Backslash-Escapes und Plausibilitaet der Schnittkanten ---

  /** Chunkt `content` und sammelt dabei ALLE gemeldeten Ledger-Befunde ein (der Weg, den ein echter Aufrufer nimmt). */
  async function chunkWithFindings(
    content: string,
    options: Omit<SqlAdapterOptions, "onSkipLedgerGap"> = {},
  ): Promise<{
    chunks: ArtifactChunk[];
    findings: ArtifactSkipLedgerEntry[];
    document: ArtifactDocument;
  }> {
    const findings: ArtifactSkipLedgerEntry[] = [];
    const sqlAdapter = createSqlAdapter({
      ...options,
      onSkipLedgerGap: (entries) => findings.push(...entries),
    });
    const config = artifactConfig({ name: "wp118", path: "db/schema.sql", type: "sql" });
    const [document] = await sqlAdapter.read({
      config,
      files: [inputFile("db/schema.sql", content)],
    });
    return { chunks: sqlAdapter.chunk(document!), findings, document: document! };
  }

  it("WP-118 Pruefer-Eingabe 1: ein Backslash-maskiertes Anfuehrungszeichen zerreisst das Statement nicht mehr", async () => {
    const content = "INSERT INTO t VALUES ('it\\'s a test; nested clause', 2);\n";
    const { chunks, findings, document } = await chunkWithFindings(content);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe("sql_statement");
    expect(chunks[0]!.title).toBe("INSERT");
    expect(chunks[0]!.content).toBe(content);
    // Ein korrekt geschnittenes Statement erzeugt weder Luecke noch Befund.
    expect(findings).toEqual([]);
    expect(buildArtifactSkipLedger(document, chunks)).toEqual([]);
  });

  it("WP-118 Pruefer-Eingabe 2: die verdoppelte Anfuehrungszeichen-Konvention bleibt in beiden Dialekten ein Statement", async () => {
    const content = "INSERT INTO t VALUES ('it''s a test; nested clause', 2);\n";
    for (const dialect of ["backslash-escapes", "doubled-quotes-only"] as const) {
      const { chunks, findings } = await chunkWithFindings(content, { dialect });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe(content);
      expect(findings).toEqual([]);
    }
  });

  it("WP-118 Kern: ein falsch geschnittenes Fragment ist ein SICHTBARER Befund, obwohl die Byte-Abdeckung lueckenlos ist", async () => {
    // Derselbe Eingabetext unter dem Standard-SQL-Dialekt, in dem `\'` KEIN
    // Escape ist: die Zerlegung schneidet hier zwangslaeufig zweimal — und
    // genau das darf nicht mehr still passieren.
    const content = "INSERT INTO t VALUES ('it\\'s a test; nested clause', 2);\n";
    const { chunks, findings, document } = await chunkWithFindings(content, {
      dialect: "doubled-quotes-only",
    });

    expect(chunks).toHaveLength(2);
    // Die alte E4-Mechanik ist hier weiterhin blind: keine Luecke, kein
    // leerer/ueberlappender Chunk. Das ist der Beweis, dass die
    // Plausibilitaetspruefung eine EIGENE Luecke schliesst.
    expect(buildArtifactSkipLedger(document, chunks)).toEqual([]);

    expect(findings).toHaveLength(2);
    expect(findings.map((entry) => entry.reason)).toEqual([
      "implausible_fragment",
      "implausible_fragment",
    ]);
    expect(findings[0]!.contentPreview).toContain("unclosed bracket");
    expect(findings[1]!.contentPreview).toContain("unterminated string literal");
    expect(findings.map((entry) => entry.range)).toEqual(chunks.map((c) => c.range));
  });

  it("WP-118: der Dialekt ist konfigurierbar und hat einen benannten Standardwert", async () => {
    expect(DEFAULT_SQL_DIALECT).toBe("backslash-escapes");
    const content = "INSERT INTO t VALUES ('it\\'s a test; nested clause', 2);\n";
    const withDefault = await chunkWithFindings(content);
    const withExplicitDefault = await chunkWithFindings(content, { dialect: DEFAULT_SQL_DIALECT });
    expect(withExplicitDefault.chunks.map((c) => c.content)).toEqual(
      withDefault.chunks.map((c) => c.content),
    );
  });

  it("WP-118: ein abgeschnittenes Statement mit offener Zeichenkette wird gemeldet, statt als ganzer Chunk durchzugehen", async () => {
    const { chunks, findings } = await chunkWithFindings(
      "CREATE TABLE t (id int);\nINSERT INTO t VALUES ('abc\n",
    );
    expect(chunks).toHaveLength(2);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe("implausible_fragment");
    expect(findings[0]!.contentPreview).toContain("unterminated string literal");
    expect(findings[0]!.range).toEqual(chunks[1]!.range);
  });

  it("WP-118: ein Semikolon in einem Dollar-Literal beendet das Statement nicht", async () => {
    const content =
      "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN INSERT INTO t VALUES (1); RETURN 1; END; $body$;\n";
    for (const dialect of ["backslash-escapes", "doubled-quotes-only"] as const) {
      const { chunks, findings } = await chunkWithFindings(content, { dialect });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe(content);
      expect(findings).toEqual([]);
    }
  });

  it("WP-118: ein Bezeichner mit zwei Dollarzeichen oeffnet kein Dollar-Literal", async () => {
    const { chunks, findings } = await chunkWithFindings("SELECT my$col$x FROM t;\nSELECT 2;\n");
    expect(chunks).toHaveLength(2);
    expect(findings).toEqual([]);
  });

  it("WP-118: Backtick-Bezeichner und `#`-Zeilenkommentare gelten nur im Backslash-Dialekt — die falsche Wahl wird sichtbar", async () => {
    const content = "CREATE TABLE `we;ird` (id int);\n";
    const good = await chunkWithFindings(content);
    expect(good.chunks).toHaveLength(1);
    expect(good.findings).toEqual([]);

    const bad = await chunkWithFindings(content, { dialect: "doubled-quotes-only" });
    expect(bad.chunks).toHaveLength(2);
    // Der Pruefer kennt Backticks IMMER, auch wo der Zerleger sie ignoriert:
    // deshalb bleibt der Fehlschnitt nicht still.
    expect(bad.findings).toHaveLength(2);
    expect(
      bad.findings.every((entry) => entry.contentPreview.includes("unterminated string literal")),
    ).toBe(true);

    const hashComment = await chunkWithFindings("SELECT 1 # kein; Trenner\n;\n");
    expect(hashComment.chunks).toHaveLength(1);
    expect(hashComment.findings).toEqual([]);
  });

  it("WP-118: Semikolons in Zeichenketten, Zeilen- und Blockkommentaren trennen weiterhin nicht", async () => {
    const content = [
      "CREATE TABLE a (id int); -- trailing; comment",
      "/* block; comment",
      "   still; a comment */",
      "INSERT INTO a VALUES ('semi;colon', \"quo;ted\");",
      "",
    ].join("\n");
    const { chunks, findings } = await chunkWithFindings(content);
    expect(chunks.map((c) => c.title)).toEqual(["a", "INSERT"]);
    expect(findings).toEqual([]);
  });

  it("links(): table names produce a heuristic, low-confidence repository-symbol guess", async () => {
    const config = artifactConfig({ name: "orders-schema", path: "db/schema.sql", type: "sql" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("db/schema.sql", SCHEMA_FIXTURE)],
    });
    const links = adapter.links!(document!);
    const orderLink = links.find((l) => l.targetName === "OrdersRepository");
    expect(orderLink).toBeDefined();
    expect(orderLink!.heuristic).toBe(true);
    expect(orderLink!.confidence).toBeGreaterThan(0);
    expect(orderLink!.confidence).toBeLessThan(1);
    expect(orderLink!.targetKind).toBe("symbol");
    expect(orderLink!.note).toContain("naming-convention guess");
  });
});
