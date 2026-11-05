import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import type { ArtifactSkipLedgerEntry } from "../coverage.js";
import { buildArtifactSkipLedger } from "../coverage.js";
import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import { createTerraformAdapter } from "./terraform.js";

const TERRAFORM_FIXTURE = `# top-level comment between blocks, not itself a chunk
variable "region" {
  type    = string
  default = "eu-central-1"
}

resource "aws_s3_bucket" "data" {
  bucket = "my-data-bucket"
  tags = {
    Owner = "platform"
  }
}

module "network" {
  source = "./modules/network"
  cidr   = "10.0.0.0/16"
}

output "bucket_arn" {
  value = aws_s3_bucket.data.arn
}
`;

describe("createTerraformAdapter", () => {
  const adapter = createTerraformAdapter();

  it("supports() matches by extension and explicit type", () => {
    expect(adapter.supports("terraform", "anything")).toBe(true);
    expect(adapter.supports("auto", "infra/main.tf")).toBe(true);
    expect(adapter.supports("auto", "infra/main.txt")).toBe(false);
  });

  it("golden: resources, modules, variables and outputs as separate sections", async () => {
    const config = artifactConfig({ name: "infra", path: "infra/main.tf", type: "terraform" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("infra/main.tf", TERRAFORM_FIXTURE)],
    });
    expect(document!.type).toBe("terraform");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual([
      "terraform_variable",
      "terraform_resource",
      "terraform_module",
      "terraform_output",
    ]);
    expect(chunks.map((c) => c.title)).toEqual([
      "region",
      "aws_s3_bucket.data",
      "network",
      "bucket_arn",
    ]);

    assertGoldenJson("infra-main-sections", chunks.map(projectChunk), { metaUrl: import.meta.url });
  });

  it("the comment/whitespace gaps between blocks show up in the skip ledger as benign, never silently dropped", async () => {
    const config = artifactConfig({ name: "infra", path: "infra/main.tf", type: "terraform" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("infra/main.tf", TERRAFORM_FIXTURE)],
    });
    const chunks = adapter.chunk(document!);
    const ledger = buildArtifactSkipLedger(document!, chunks);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((entry) => entry.reason === "whitespace_or_comment")).toBe(true);
  });

  // --- FEHLERKLASSE finding (same defect class as WP-81's Protobuf case 3):
  // a `{`/`}` inside a multi-line `/* ... */` comment must not desync the
  // depth counter, or every block after the comment is silently swallowed
  // into the one that precedes it. ---
  it("a brace inside a multi-line block comment does not swallow the following resource", async () => {
    const content = `variable "region" {
  default = "eu-central-1"
}

/* legacy config, kept for reference: resource "aws_instance" "old" { */

resource "aws_s3_bucket" "data" {
  bucket = "my-data-bucket"
}
`;
    const config = artifactConfig({
      name: "infra-comment",
      path: "infra/main.tf",
      type: "terraform",
    });
    const [document] = await adapter.read({ config, files: [inputFile("infra/main.tf", content)] });
    const chunks = adapter.chunk(document!);
    // Before the fix: the `{` inside the comment (on the commented-out
    // "resource" line) pushed depth to 2, so the comment's closing `*/`
    // line's own `}`-less content never brought depth back to 0 — the
    // adapter degraded to "runs to EOF", and the real `aws_s3_bucket`
    // resource after the comment never got its own chunk at all.
    expect(chunks.map((c) => c.kind)).toEqual(["terraform_variable", "terraform_resource"]);
    expect(chunks.map((c) => c.title)).toEqual(["region", "aws_s3_bucket.data"]);
    const resource = chunks.find((c) => c.kind === "terraform_resource")!;
    expect(resource.content).toContain("my-data-bucket");
    expect(resource.content).not.toContain("legacy config");

    // The gap left by the (now correctly un-chunked) block comment is real
    // content, but it IS just a comment — the ledger must still call it
    // benign, not raise it as if it were lost data.
    const ledger = buildArtifactSkipLedger(document!, chunks);
    expect(ledger.every((entry) => entry.reason === "whitespace_or_comment")).toBe(true);
  });
  // --- WP-118: dieselbe Blindstelle wie im SQL-Adapter ---

  it("WP-118: ein `{` in einem Heredoc verschiebt den Klammerzaehler nicht mehr", async () => {
    const content = [
      'resource "aws_instance" "web" {',
      "  user_data = <<-EOT",
      "    if true; then { echo hi",
      "    fi",
      "  EOT",
      "}",
      "",
      'variable "region" {',
      '  default = "eu-central-1"',
      "}",
      "",
    ].join("\n");
    const findings: ArtifactSkipLedgerEntry[] = [];
    const scoped = createTerraformAdapter({
      onSkipLedgerGap: (entries) => findings.push(...entries),
    });
    const config = artifactConfig({ name: "infra", path: "infra/main.tf", type: "terraform" });
    const [document] = await scoped.read({ config, files: [inputFile("infra/main.tf", content)] });

    const chunks = scoped.chunk(document!);
    // Vorher lief der Resource-Block bis Dateiende und verschluckte die
    // Variable — bei lueckenloser Byte-Abdeckung, also ohne jeden Befund.
    expect(chunks.map((c) => c.title)).toEqual(["aws_instance.web", "region"]);
    expect(findings).toEqual([]);
  });

  it("WP-118: ein unabgeschlossener Block wird als unplausibles Fragment gemeldet, nicht still bis EOF gedehnt", async () => {
    const content = 'resource "aws_s3_bucket" "data" {\n  bucket = "b"\n';
    const findings: ArtifactSkipLedgerEntry[] = [];
    const scoped = createTerraformAdapter({
      onSkipLedgerGap: (entries) => findings.push(...entries),
    });
    const config = artifactConfig({ name: "infra", path: "infra/main.tf", type: "terraform" });
    const [document] = await scoped.read({ config, files: [inputFile("infra/main.tf", content)] });

    const chunks = scoped.chunk(document!);
    expect(chunks).toHaveLength(1);
    // Byte-Abdeckung lueckenlos, Chunk weder leer noch ueberlappend: die
    // alte Mechanik sieht nichts.
    expect(buildArtifactSkipLedger(document!, chunks)).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe("implausible_fragment");
    expect(findings[0]!.contentPreview).toContain('unclosed bracket "{"');
  });
});
