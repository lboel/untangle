/**
 * Local checkpoint mirror (architecture.md §12, §13.3; spec.md §11.2:
 * "Nach jedem konfigurierten Dateibatch MUSS ein Checkpoint gespeichert
 * werden" / "Bei Neustart MUSS der Job ab dem letzten bestätigten
 * Checkpoint fortsetzbar sein").
 *
 * Every write is temp-file-then-rename: the checkpoint at `jobs/<jobId>.json`
 * is only ever created or replaced by a single atomic `rename` onto that
 * exact path, so a process crash mid-write leaves, at worst, an orphaned
 * `*.tmp` file next to it — the real path itself is always either the
 * previous good checkpoint or the new one, never a half-written mix of both
 * (see README "Entscheidungen" for the crash-simulation test).
 *
 * `jobs/latest/<hash>.json` is a small secondary index — "which job is the
 * latest checkpoint for this repo+ref" — so `loadLatest` does not have to
 * list and parse every checkpoint file. It is written the same atomic way,
 * AFTER the checkpoint itself, so a crash between the two writes leaves the
 * pointer stale (pointing at the previous job) rather than pointing at a
 * checkpoint that does not exist — `loadLatest` degrades to `null` if the
 * pointer cannot be trusted at all (spec.md §25.2: reads degrade optional
 * data in a controlled way), while `load(jobId)` on an actually corrupted
 * checkpoint body throws instead, because THAT is the resume-critical record
 * itself, not an accelerator index over it.
 */
import * as nodePath from "node:path";

import type {
  CheckpointStorePort,
  FileSystemPort,
  IndexCheckpointV1,
  PortCallOptions,
  Random,
} from "@untangle-code/domain";
import { ID_COMPONENT_SEPARATOR, sha256Hex, UntangleError } from "@untangle-code/domain";

import { assertNotAborted } from "./abort.js";
import { isNotFoundError } from "./fs-errors.js";

const POINTER_DIR_NAME = "latest";

interface LatestPointerV1 {
  jobId: string;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function signalOptions(options: PortCallOptions | undefined): PortCallOptions | undefined {
  return options?.signal ? { signal: options.signal } : undefined;
}

/** Local, atomically-mirrored `CheckpointStorePort` under `jobs/`. */
export class LocalCheckpointStore implements CheckpointStorePort {
  public constructor(
    private readonly fs: FileSystemPort,
    private readonly jobsDir: string,
    private readonly random: Random,
  ) {}

  private pathForJob(jobId: string): string {
    return nodePath.join(this.jobsDir, `${jobId}.json`);
  }

  /**
   * Both components are variable-length, so a plain concatenation would be
   * ambiguous (e.g. `repoId="ab"` + `refId="c"` vs. `repoId="a"` +
   * `refId="bc"`) — joined with the same separator domain's own identity
   * model uses for exactly this reason (`identity.ts`'s doc comment).
   */
  private pointerPathFor(repoId: string, refId: string): string {
    const hash = sha256Hex(`${repoId}${ID_COMPONENT_SEPARATOR}${refId}`);
    return nodePath.join(this.jobsDir, POINTER_DIR_NAME, `${hash}.json`);
  }

  private async writeAtomic(
    finalPath: string,
    content: string,
    options: PortCallOptions | undefined,
  ): Promise<void> {
    const dir = nodePath.dirname(finalPath);
    await this.fs.mkdir(dir, { recursive: true, ...signalOptions(options) });
    const tempPath = `${finalPath}.${this.random.uuid()}.tmp`;
    await this.fs.writeFile(tempPath, encode(content), options);
    await this.fs.rename(tempPath, finalPath, options);
  }

  public async save(checkpoint: IndexCheckpointV1, options?: PortCallOptions): Promise<void> {
    assertNotAborted(options, "checkpoint_save");
    await this.writeAtomic(this.pathForJob(checkpoint.jobId), JSON.stringify(checkpoint), options);
    const pointer: LatestPointerV1 = { jobId: checkpoint.jobId };
    await this.writeAtomic(
      this.pointerPathFor(checkpoint.repoId, checkpoint.refId),
      JSON.stringify(pointer),
      options,
    );
  }

  public async load(jobId: string, options?: PortCallOptions): Promise<IndexCheckpointV1 | null> {
    assertNotAborted(options, "checkpoint_load");
    let text: string;
    try {
      text = await this.fs.readTextFile(this.pathForJob(jobId), options);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    try {
      return JSON.parse(text) as IndexCheckpointV1;
    } catch (parseError) {
      // Should never happen given atomic temp+rename writes — this is a
      // defensive, loud failure (fail-closed, spec.md §25.2) for the one
      // record a resume actually depends on, not a "missing optional data"
      // case that could silently degrade to "start over".
      throw new UntangleError(
        "INDEX_INCOMPLETE",
        `checkpoint "${jobId}" is corrupted and cannot be safely resumed from`,
        { operation: "checkpoint_load", context: { jobId }, cause: parseError },
      );
    }
  }

  public async loadLatest(
    repoId: string,
    refId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null> {
    assertNotAborted(options, "checkpoint_load_latest");
    let text: string;
    try {
      text = await this.fs.readTextFile(this.pointerPathFor(repoId, refId), options);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    let pointer: LatestPointerV1;
    try {
      pointer = JSON.parse(text) as LatestPointerV1;
    } catch {
      // The pointer is an accelerator index, not the resume record itself —
      // degrade to "no known latest" rather than throwing (spec.md §25.2).
      return null;
    }
    return this.load(pointer.jobId, options);
  }

  public async delete(jobId: string, options?: PortCallOptions): Promise<void> {
    assertNotAborted(options, "checkpoint_delete");
    await this.fs.remove(this.pathForJob(jobId), options);
  }
}
