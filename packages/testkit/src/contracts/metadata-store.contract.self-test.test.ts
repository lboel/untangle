/**
 * Self-test: runs the `MetadataStore` port contract against
 * `InMemoryMetadataStore` itself.
 */
import { InMemoryMetadataStore } from "../in-memory/metadata-store.js";

import { runMetadataStoreContract } from "./metadata-store.contract.js";

runMetadataStoreContract(() => new InMemoryMetadataStore());
