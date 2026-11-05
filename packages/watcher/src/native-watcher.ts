/**
 * Production `NativeWatcherPort` (spec.md §12.3: "Ein nativer rekursiver
 * Watcher SOLL verwendet werden") backed by `node:fs/promises`
 * `watch(rootPath, {recursive:true})` — no third-party watch library.
 *
 * This is the only file in the package allowed to import `node:fs/promises`
 * for watching; `RepoWatcher` only ever sees the `NativeWatcherPort`
 * interface, so its tests run against `FakeNativeWatcher`
 * (`src/testing/fake-native-watcher.ts`) instead.
 */
import { watch as fsWatch } from "node:fs/promises";

import { normalizeRelativePath } from "./paths.js";
import type { NativeChangeEventV1, NativeWatcherPort } from "./types.js";

/**
 * `node:fs/promises` `watch()`'s recursive option is only supported on
 * macOS and Windows as of Node 22 — Linux throws
 * `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` synchronously on the first
 * iteration. That throw surfaces as a normal rejected `next()` call here,
 * which `RepoWatcher`'s watch loop already treats as an isolated,
 * degrade-and-retry failure (spec.md §12.3) — retrying is futile on an
 * unsupported platform, but it is still never a crash, which is the actual
 * requirement. The co-located `native-watcher.integration.test.ts` skips
 * itself on such platforms rather than asserting a false failure.
 */
export class NodeNativeWatcher implements NativeWatcherPort {
  public watch(
    rootPath: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<NativeChangeEventV1> {
    const raw = fsWatch(rootPath, {
      recursive: true,
      persistent: true,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return mapEvents(raw);
  }
}

async function* mapEvents(
  raw: AsyncIterable<{ eventType: string; filename: string | Buffer | null }>,
): AsyncGenerator<NativeChangeEventV1> {
  for await (const event of raw) {
    const filename =
      event.filename === null ? null : normalizeRelativePath(event.filename.toString());
    yield {
      eventType: event.eventType === "change" ? "change" : "rename",
      relativePath: filename,
    };
  }
}
