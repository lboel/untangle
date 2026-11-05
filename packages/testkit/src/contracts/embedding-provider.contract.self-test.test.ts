/**
 * Self-test: runs the `EmbeddingProvider` port contract against
 * `DeterministicEmbedder` itself.
 */
import { DeterministicEmbedder } from "../embedder.js";
import { FakeClock } from "../in-memory/clock.js";

import { runEmbeddingProviderContract } from "./embedding-provider.contract.js";

runEmbeddingProviderContract(() => new DeterministicEmbedder(new FakeClock(0)));
