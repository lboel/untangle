/**
 * Self-test: runs the `VectorStore` port contract against
 * `InMemoryVectorStore` itself. This is the package's own required proof
 * that the contract suite is meaningful — see README "Entscheidungen".
 */
import { InMemoryVectorStore } from "../in-memory/vector-store.js";

import { runVectorStoreContract } from "./vector-store.contract.js";

runVectorStoreContract(() => new InMemoryVectorStore());
