/**
 * E4-Ehrlichkeitspruefung der Artefakt-Adapter (WP-165).
 *
 * Der Pruefling ist der volle Weg `read()` -> `chunk()` ueber die
 * Registry-Dispatch-Reihenfolge, auf EINER geteilten Registry-Instanz, damit
 * die Nebenlaeufigkeitsbeschaedigung geteilten Zustand treffen kann. Weil
 * `read()` `PortCallOptions` nimmt, ist hier -- anders als beim Chunker und
 * bei den Sprachadaptern -- auch die Abbruchbeschaedigung wirklich anwendbar.
 *
 * Die Projektion prueft zwei Dinge, beide relativ zum Eingang:
 *
 *   1. VOLLSTAENDIGKEIT: welcher Anteil des Dokuments liegt in einem Chunk,
 *      und was bleibt mit welcher Begruendung uebrig (aus dem eigenen
 *      Skip-Ledger des Pakets);
 *   2. WAHRHAFTIGKEIT der Chunks selbst: `content` byte-genau der eigene
 *      `range` (spec.md §19.2 "Inhalt MUSS erhalten bleiben"), `contentHash`
 *      passend, kein leerer/invertierter Bereich, keine zwei Chunks mit
 *      identischem Bereich und widerspruechlicher Identitaet.
 *
 * Punkt 2 ist der Grund, warum diese Pruefung ueber die bestehende
 * Byte-Abdeckung hinausgeht: ein Chunk kann jedes Byte abdecken und trotzdem
 * etwas anderes behaupten, als er traegt.
 */
import type {
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  PortCallOptions,
} from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import {
  assertHonestUnderDamage,
  claimCompleteness,
  completenessClaimProjection,
  concurrencyDamage,
  makeFinding,
  removeRequiredFieldDamage,
  standardTextDamages,
  type DamageCase,
  type TextLens,
  type VisibleFinding,
} from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { buildArtifactSkipLedger, type ArtifactSkipLedgerEntry } from "./coverage.js";
import { createArtifactAdapterRegistry } from "./registry.js";

const MARKDOWN = `# Service guide

Intro paragraph explaining the service.

## Deployment

Run the deployment script.

## Rollback

Restore the previous revision.
`;

const SQL = `CREATE TABLE customer (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE invoice (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customer(id),
  note TEXT DEFAULT 'a; semicolon inside a string'
);
`;

const KUBERNETES = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  ports:
    - port: 80
`;

const OPENAPI = `openapi: 3.0.3
info:
  title: Billing API
  version: 1.0.0
paths:
  /invoices:
    get:
      operationId: listInvoices
      responses:
        "200":
          description: ok
  /invoices/{id}:
    delete:
      operationId: deleteInvoice
      responses:
        "204":
          description: gone
`;

/**
 * Die Befunde, die die Adapter selbst melden, laufen ueber diesen Rueckruf.
 * EINE Registry fuer alle Laeufe -- `chunk()` ist synchron, also kann sich
 * innerhalb eines Laufs nichts dazwischenschieben, und ein falsch
 * geschluesselter Zustand faellt der Nebenlaeufigkeitsbeschaedigung auf.
 */
const reported: ArtifactSkipLedgerEntry[] = [];
const registry = createArtifactAdapterRegistry([], {
  onSkipLedgerGap: (entries) => {
    reported.push(...entries);
  },
});

interface ArtifactProbeInput {
  readonly artifactName: string;
  readonly path: string;
  readonly declaredType: ArtifactInput["config"]["type"];
  readonly content: string;
  readonly options?: PortCallOptions;
}

interface ArtifactProbeOutput {
  readonly documents: readonly ArtifactDocument[];
  readonly chunks: readonly ArtifactChunk[];
  readonly reported: readonly ArtifactSkipLedgerEntry[];
}

async function runArtifacts(input: ArtifactProbeInput): Promise<ArtifactProbeOutput> {
  reported.length = 0;
  const artifactInput: ArtifactInput = {
    config: {
      name: input.artifactName,
      path: input.path,
      description: "honesty probe artifact",
      ...(input.declaredType === undefined ? {} : { type: input.declaredType }),
    },
    files: [
      {
        path: input.path,
        content: input.content,
        contentHash: sha256Hex(input.content),
      },
    ],
  };
  const documents = await registry.read(artifactInput, input.options);
  const chunks = documents.flatMap((document) => registry.chunk(document));
  return { documents, chunks, reported: [...reported] };
}

/** Bytes eines Dokuments, die von mindestens einem Chunk abgedeckt sind. */
function coveredBytes(chunks: readonly ArtifactChunk[], totalBytes: number): number {
  const spans = chunks
    .map((chunk): [number, number] => [
      Math.max(0, chunk.range.startByte),
      Math.min(totalBytes, chunk.range.endByte),
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = 0;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) {
      covered += end - from;
      cursor = end;
    }
  }
  return covered;
}

/**
 * Zaehlt Chunks, deren eigene Angaben nicht zu ihrem Bereich passen. Alle drei
 * Zahlen MUESSEN in jedem ehrlichen Lauf 0 sein -- ein Chunk, der etwas
 * anderes traegt als er behauptet, ist genau die Fehlerklasse dieses Auftrags.
 */
function untruthfulChunkCounts(
  document: ArtifactDocument,
  chunks: readonly ArtifactChunk[],
): { contentNotByteExact: number; hashMismatch: number; degenerateRange: number } {
  const buffer = Buffer.from(document.content, "utf8");
  let contentNotByteExact = 0;
  let hashMismatch = 0;
  let degenerateRange = 0;
  for (const chunk of chunks) {
    if (chunk.range.endByte <= chunk.range.startByte) {
      degenerateRange += 1;
      continue;
    }
    const slice = buffer.toString("utf8", chunk.range.startByte, chunk.range.endByte);
    if (slice !== chunk.content) {
      contentNotByteExact += 1;
    }
    if (sha256Hex(chunk.content) !== chunk.contentHash) {
      hashMismatch += 1;
    }
  }
  return { contentNotByteExact, hashMismatch, degenerateRange };
}

/**
 * Bytes ausserhalb aller Chunks, die trotzdem E4-konform sind: entweder in
 * einem tatsaechlich ueber `onSkipLedgerGap` gemeldeten Eintrag benannt, oder
 * als reiner Leerraum/Kommentar klassifiziert (der Ledger meldet diese Klasse
 * bewusst nicht -- siehe `coverage.ts`).
 */
function reportedOrBenignBytes(
  document: ArtifactDocument,
  result: ArtifactProbeOutput,
  totalBytes: number,
): number {
  const reportedKeys = new Set(
    result.reported.map(
      (entry) => `${String(entry.range.startByte)}:${String(entry.range.endByte)}:${entry.reason}`,
    ),
  );
  let excused = 0;
  for (const entry of buildArtifactSkipLedger(document, result.chunks)) {
    if (entry.reason === "semantic_loss" || entry.reason === "implausible_fragment") {
      // Diese beiden beziehen sich auf einen EXISTIERENDEN Chunk, nicht auf
      // eine Luecke -- sie duerfen keine Bytes entschuldigen.
      continue;
    }
    const key = `${String(entry.range.startByte)}:${String(entry.range.endByte)}:${entry.reason}`;
    if (entry.reason === "whitespace_or_comment" || reportedKeys.has(key)) {
      excused += Math.max(
        0,
        Math.min(totalBytes, entry.range.endByte) - Math.max(0, entry.range.startByte),
      );
    }
  }
  return excused;
}

function artifactFindings(result: ArtifactProbeOutput): readonly VisibleFinding[] {
  return result.reported.map((entry) =>
    makeFinding(
      "skip_ledger",
      `artifact/${entry.reason} ${entry.path} bytes ${String(entry.range.startByte)}..${String(
        entry.range.endByte,
      )}: ${entry.contentPreview.slice(0, 80)}`,
    ),
  );
}

const lens: TextLens<ArtifactProbeInput> = {
  read: (input) => input.content,
  write: (input, content) => ({ ...input, content }),
};

function artifactDamages(
  decoy: ArtifactProbeInput,
): readonly DamageCase<ArtifactProbeInput, ArtifactProbeOutput>[] {
  return [
    ...standardTextDamages(lens, { repeat: 30 }),
    removeRequiredFieldDamage<ArtifactProbeInput>({
      id: "drop_header_line",
      detail:
        "delete the document's first line, which every one of these formats uses as its identifying header",
      remove: (input) => ({
        ...input,
        content: input.content.slice(input.content.indexOf("\n") + 1),
      }),
    }),
    {
      mode: "input",
      id: "abort_before_read",
      kind: "abort_signal",
      detail: "pass an already-aborted AbortSignal into ArtifactAdapter.read()",
      damage: (input) => {
        const controller = new AbortController();
        controller.abort();
        return { ...input, options: { signal: controller.signal } };
      },
    },
    concurrencyDamage<ArtifactProbeInput, ArtifactProbeOutput>({ decoy, copies: 6 }),
  ];
}

const CASES = [
  { label: "markdown", path: "docs/guide.md", content: MARKDOWN },
  { label: "sql", path: "db/schema.sql", content: SQL },
  { label: "kubernetes", path: "deploy/api.yaml", content: KUBERNETES },
  { label: "openapi", path: "api/openapi.yaml", content: OPENAPI },
] as const;

describe.each(CASES)("artifact adapter honesty under damage (E4) -- $label", (probeCase) => {
  it("either reports what it lost or provably loses nothing", async () => {
    const decoyCase = CASES.find((candidate) => candidate.label !== probeCase.label);
    if (decoyCase === undefined) throw new Error("fixture error: no decoy case");

    const report = await assertHonestUnderDamage<ArtifactProbeInput, ArtifactProbeOutput>({
      name: `artifact registry read+chunk (${probeCase.label})`,
      input: {
        artifactName: `probe-${probeCase.label}`,
        path: probeCase.path,
        declaredType: "auto",
        content: probeCase.content,
      },
      run: runArtifacts,
      claim: (result, input) => {
        const totalBytes = Buffer.byteLength(input.content, "utf8");
        const document = result.documents[0];
        if (document === undefined) {
          return { readProducedNoDocument: true };
        }
        const covered = Math.min(totalBytes, coveredBytes(result.chunks, totalBytes));
        // E4 ist erfuellt, wenn jedes Byte ENTWEDER in einem Chunk steckt,
        // ODER in einem tatsaechlich gemeldeten Ledger-Eintrag benannt ist,
        // ODER als Leerraum/Kommentar dokumentiert benigne ist. Nur der Rest
        // ist ein Verlust ohne Grund -- und genau darauf projiziert diese
        // Pruefung. Absichtlich NICHT auf "gibt es eine Luecke": ein
        // gemeldeter Lueckenanteil schrumpft voellig zu Recht mit einem
        // kuerzeren Dokument, und ihn zu vergleichen erzeugt nur Fehlalarme
        // bei jeder Groessenbeschaedigung.
        const accountedFor = Math.min(
          totalBytes,
          covered + reportedOrBenignBytes(document, result, totalBytes),
        );
        const unexplained = Math.max(0, totalBytes - accountedFor);
        return {
          completeness: completenessClaimProjection(
            claimCompleteness({
              subject: input.path,
              evidence: {
                unit: "bytes",
                expected: totalBytes,
                accountedFor,
                omissions:
                  unexplained > 0
                    ? [
                        {
                          amount: unexplained,
                          reason: "in no chunk, in no reported ledger entry, and not whitespace",
                        },
                      ]
                    : [],
              },
            }),
            input.path,
          ),
          ...untruthfulChunkCounts(document, result.chunks),
        };
      },
      findings: artifactFindings,
      damages: artifactDamages({
        artifactName: `probe-${decoyCase.label}`,
        path: decoyCase.path,
        declaredType: "auto",
        content: decoyCase.content,
      }),
    });
    expect(report.violations).toEqual([]);
    expect(report.uncoveredKinds).toEqual([]);
  });
});
