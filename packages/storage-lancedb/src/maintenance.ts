import type { Table } from "@lancedb/lancedb";

import { schemaError, type StorageCall } from "./operation.js";

/** Physical indexes are adapter-owned acceleration, never authoritative data. */
export const MANAGED_INDEXES = [
  { name: "untangle_id_v1", column: "id", type: "BTree" },
  { name: "untangle_order_v1", column: "id_order", type: "BTree" },
  { name: "untangle_filter_tokens_v1", column: "filter_tokens", type: "LabelList" },
] as const;

export const COMPACTION_FRAGMENT_LIMIT = 32;

/** Called only while holding the cross-process writer guard. */
export async function ensureManagedIndexes(table: Table, call: StorageCall): Promise<void> {
  const existing = await table.listIndices();
  const { Index } = await import("@lancedb/lancedb");
  for (const wanted of MANAGED_INDEXES) {
    call.check();
    const found = existing.find((index) => index.name === wanted.name);
    if (found) {
      if (
        found.indexType !== wanted.type ||
        found.columns.length !== 1 ||
        found.columns[0] !== wanted.column
      )
        throw schemaError("A managed Lance index has an incompatible definition.", {
          index: wanted.name,
        });
      continue;
    }
    call.mayHaveCommitted = true;
    await table.createIndex(wanted.column, {
      name: wanted.name,
      config: wanted.type === "BTree" ? Index.btree() : Index.labelList(),
      replace: false,
      waitTimeoutSeconds: Math.max(1, Math.ceil(call.remaining() / 1000)),
    });
    call.check();
  }
}

/**
 * Compact and backfill indexes before tiny fragments accumulate quadratically.
 * Epoch cutoff disables pruning of all Lance versions (Lance did not exist
 * before 1970); never use optimize's default seven-day cleanup or vacuum here.
 */
export async function maintainTable(table: Table, call: StorageCall): Promise<void> {
  call.check();
  if ((await table.stats()).fragmentStats.numSmallFragments < COMPACTION_FRAGMENT_LIMIT) return;
  call.check();
  call.mayHaveCommitted = true;
  await table.optimize({ cleanupOlderThan: new Date(0), deleteUnverified: false });
  call.check();
}
