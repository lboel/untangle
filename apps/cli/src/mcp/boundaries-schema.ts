import * as z from "zod/v4";

import { httpServiceBindingSchema } from "../commands/graph/boundaries-input.js";

const text = z.string();
const nonempty = text.min(1);
const count = z.number().int().nonnegative();
const hash = text.regex(/^[0-9a-f]{64}$/u);
const range = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    startByte: count,
    endByte: count,
  })
  .strict();
const issue = z.object({ path: text, reason: text }).strict();
const evidence = z
  .object({
    path: text,
    contentHash: hash,
    range,
    kind: z.enum(["request", "transport", "route", "router", "include"]),
    name: text.optional(),
  })
  .strict();
const endpoint = z
  .object({
    serviceId: text.nullable(),
    method: nonempty,
    path: text,
    handler: text,
    provenance: z.array(evidence),
  })
  .strict();
const request = z
  .object({
    source: evidence,
    method: text.nullable(),
    path: text.nullable(),
    origin: text.nullable(),
    status: z.enum(["resolved", "ambiguous", "unresolved"]),
    reason: text.optional(),
    serviceIds: z.array(text),
    targets: z.array(endpoint),
    provenance: z.array(evidence),
  })
  .strict();
const importEdge = z
  .object({
    fromPath: text,
    toPath: text,
    rawSpecifier: text,
    range,
    sourceHash: hash,
    targetHash: hash,
  })
  .strict();

/** Every relationship is typed separately from synchronous import/call graph contracts. */
export const frontendBoundaryReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("frontend-boundaries"),
    root: nonempty,
    status: z.enum(["complete", "incomplete", "stale"]),
    sourceTreeDigest: hash,
    freshness: z
      .object({
        status: z.enum(["fresh", "stale"]),
        sourceTreeBefore: hash,
        sourceTreeAfter: hash,
        changedPaths: z.array(text),
      })
      .strict(),
    inventory: z
      .object({
        files: count,
        excluded: count,
        truncated: z.boolean(),
        analyzed: count,
        unsupported: count,
        failed: count,
      })
      .strict(),
    selection: z
      .object({ path: text, inInventory: z.boolean(), matchingRequests: count })
      .strict()
      .optional(),
    http: z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal("http-boundaries"),
        services: z.array(httpServiceBindingSchema),
        endpoints: z.array(endpoint),
        requests: z.array(request),
        limitations: z.array(issue),
        summary: z
          .object({
            files: count,
            endpoints: count,
            requests: count,
            resolved: count,
            ambiguous: count,
            unresolved: count,
          })
          .strict(),
      })
      .strict(),
    importContext: z
      .object({
        kind: z.literal("file-imports-not-function-calls"),
        edges: z.array(importEdge),
        requestImporters: z.array(
          z
            .object({
              requestPath: text,
              path: text,
              contentHash: hash,
              distance: count,
              via: z.array(importEdge),
            })
            .strict(),
        ),
        unresolved: z.array(issue),
        summary: z.object({ edges: count, unresolved: count, requestImporters: count }).strict(),
        truncated: z.boolean(),
      })
      .strict(),
    features: z
      .object({
        manifest: z
          .object({
            path: text,
            status: z.enum([
              "loaded",
              "missing",
              "invalid",
              "changed",
              "unreadable",
              "not_in_scan",
            ]),
            contentHash: hash.optional(),
          })
          .strict(),
        associations: z.array(
          z
            .object({
              path: text,
              matches: z.array(
                z
                  .object({
                    featureId: text,
                    title: text,
                    role: z.enum(["code", "test"]),
                    review: z.enum(["proposed", "confirmed"]),
                    ownership: z.array(
                      z
                        .object({
                          id: text,
                          label: text.optional(),
                          status: z.enum(["declared", "confirmed", "missing"]),
                        })
                        .strict(),
                    ),
                    declaredDependsOn: z.array(text),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
        associationCount: count,
        dependencySemantics: z.literal("declared_dependencies_unchanged"),
      })
      .strict(),
    truncation: z
      .object({
        truncated: z.boolean(),
        limit: count,
        omittedRequests: count,
        omittedEndpoints: count,
        omittedIssues: count,
        omittedFeatureAssociations: count,
      })
      .strict(),
    issues: z.array(issue),
    limitations: z.array(text),
    servicesManifest: z
      .object({ path: text, status: z.enum(["loaded", "missing"]), contentHash: hash.optional() })
      .strict(),
  })
  .strict();
