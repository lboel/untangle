/**
 * Self-test: runs the `GraphStore` port contract against
 * `InMemoryGraphStore` itself.
 */
import { InMemoryGraphStore } from "../in-memory/graph-store.js";

import { runGraphStoreContract } from "./graph-store.contract.js";

runGraphStoreContract(() => new InMemoryGraphStore());
