/**
 * Self-test: runs the `FileSystemPort` port contract against
 * `MemoryFileSystem` itself. Every test gets a brand-new instance (via
 * `factory`), so "/" is always an empty root.
 */
import { FakeClock } from "../in-memory/clock.js";
import { MemoryFileSystem } from "../in-memory/file-system.js";

import { runFileSystemContract } from "./file-system.contract.js";

runFileSystemContract(() => ({ fs: new MemoryFileSystem(new FakeClock(0)), root: "/" }));
