import type { Connection } from "@lancedb/lancedb";
import { UntangleError } from "@untangle-code/domain";

import type { StorageCall } from "./operation.js";

const IDLE_CLOSE_MS = 100;
interface Lease {
  connection: Promise<Connection>;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Native sessions/cache only; tables and snapshots remain operation-local. */
export class ConnectionPool {
  private readonly leases = new Map<string, Lease>();

  public constructor(
    private readonly connector: (root: string, call: StorageCall) => Promise<Connection> = (
      root,
      call,
    ) => this.open(root, call),
  ) {}

  public async withConnection<T>(
    root: string,
    call: StorageCall,
    work: (db: Connection) => Promise<T>,
  ): Promise<T> {
    call.check();
    let lease = this.leases.get(root);
    if (!lease) {
      lease = { connection: this.connector(root, call), users: 0 };
      this.leases.set(root, lease);
    }
    if (lease.timer) {
      clearTimeout(lease.timer);
      delete lease.timer;
    }
    lease.users += 1;
    try {
      let db: Connection;
      try {
        db = await lease.connection;
      } catch (error) {
        // A failed native connection is not a reusable session. Evict it now;
        // frequent retries must not keep one transient rejection alive.
        if (this.leases.get(root) === lease) this.leases.delete(root);
        throw error;
      }
      call.check();
      return await work(db);
    } finally {
      lease.users -= 1;
      if (!lease.users && this.leases.get(root) === lease) {
        const idle = lease;
        idle.timer = setTimeout(() => {
          if (this.leases.get(root) !== idle || idle.users) return;
          this.leases.delete(root);
          void idle.connection.then(
            (db) => db.close(),
            () => undefined,
          );
        }, IDLE_CLOSE_MS);
        idle.timer.unref();
      }
    }
  }

  private async open(root: string, call: StorageCall): Promise<Connection> {
    let sdk;
    try {
      sdk = await import("@lancedb/lancedb");
    } catch (cause) {
      throw new UntangleError(
        "LANCEDB_UNAVAILABLE",
        "The local LanceDB native binding could not load. Install a supported native platform package or configure storage.backend as qdrant.",
        {
          operation: call.operation,
          retryable: false,
          context: {
            platform: process.platform,
            architecture: process.arch,
            alternativeBackend: "qdrant",
            mayHaveCommitted: call.mayHaveCommitted,
          },
          cause,
        },
      );
    }
    return sdk.connect(root, { readConsistencyInterval: 0 });
  }

  public async close(): Promise<void> {
    const leases = [...this.leases.values()];
    this.leases.clear();
    for (const lease of leases) if (lease.timer) clearTimeout(lease.timer);
    await Promise.all(
      leases.map((lease) =>
        lease.connection.then(
          (db) => db.close(),
          () => undefined,
        ),
      ),
    );
  }
}
