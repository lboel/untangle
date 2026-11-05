/**
 * Self-test: runs the `LockProvider` port contract against
 * `InMemoryLockProvider`, with exact injected-clock lease boundaries and
 * real elapsed-time polling, wait budgets and cancellation.
 */
import { FakeClock } from "../in-memory/clock.js";
import { InMemoryLockProvider } from "../in-memory/lock-provider.js";
import { DeterministicRandom } from "../in-memory/random.js";

import { runLockProviderContract } from "./lock-provider.contract.js";

runLockProviderContract(() => {
  const clock = new FakeClock();
  return {
    provider: new InMemoryLockProvider(clock, new DeterministicRandom(1)),
    clock,
  };
});
