/**
 * Point-id mapping. Qdrant point ids must be UUIDs or unsigned integers,
 * while the `VectorStore` port allows ARBITRARY string ids (chunk ids,
 * metadata keys, graph part keys). The adapter therefore:
 *
 * - derives the wire-level point id deterministically as
 *   `UUIDv5("qdrant_point" + US + <id>)` (same id → same UUID → idempotent
 *   upserts, spec.md §10.5);
 * - stores the ORIGINAL id in the payload under
 *   {@link STORED_POINT_ID_PAYLOAD_KEY} and strips that key again on every
 *   read, so payloads round-trip byte-identically for callers.
 */
import { ID_COMPONENT_SEPARATOR, uuidv5 } from "@untangle-code/domain";

/** Reserved payload key carrying the caller's original point id. */
export const STORED_POINT_ID_PAYLOAD_KEY = "untangle_stored_point_id";

/** Deterministic Qdrant UUID for an arbitrary port-level point id. */
export function toQdrantPointId(id: string): string {
  return uuidv5(`qdrant_point${ID_COMPONENT_SEPARATOR}${id}`);
}

/**
 * Splits a payload read back from Qdrant into the original point id and the
 * caller-visible payload (reserved key removed).
 */
export function splitStoredPayload(payload: Record<string, unknown> | undefined): {
  originalId: string | undefined;
  payload: Record<string, unknown>;
} {
  if (payload === undefined) {
    return { originalId: undefined, payload: {} };
  }
  const { [STORED_POINT_ID_PAYLOAD_KEY]: stored, ...rest } = payload;
  return { originalId: typeof stored === "string" ? stored : undefined, payload: rest };
}
