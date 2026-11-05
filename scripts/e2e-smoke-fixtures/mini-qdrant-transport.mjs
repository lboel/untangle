/**
 * Minimal in-memory Qdrant REST transport double — just enough surface for
 * `QdrantGraphStore.writeShard`/`readShard` (collection GET/PUT, points
 * PUT/scroll/delete/count) to exercise the WP-77 concurrent-write race
 * end to end in `e2e-smoke.mjs`.
 *
 * Deliberately independent from the project's own `FakeQdrantServer`
 * (`packages/testkit`) so this smoke fixture cannot inherit any blind spot
 * that test double might share with the adapter under test — a second,
 * differently-built pair of eyes on the same contract.
 */
export class MiniQdrantTransport {
  constructor() {
    this.collections = new Map(); // name -> { params, points: Map<id, {payload, vector}> }
  }

  ok(result) {
    return { status: 200, body: { status: "ok", result, time: 0 } };
  }

  err(status, error) {
    return { status, body: { status: { error }, time: 0 } };
  }

  matchCond(payload, cond) {
    if (cond.match) {
      if (cond.match.any) return cond.match.any.includes(payload[cond.key]);
      return payload[cond.key] === cond.match.value;
    }
    if (cond.range) {
      const actual = payload[cond.key];
      if (typeof actual !== "number") return false;
      const { gt, gte, lt, lte } = cond.range;
      if (gt !== undefined && !(actual > gt)) return false;
      if (gte !== undefined && !(actual >= gte)) return false;
      if (lt !== undefined && !(actual < lt)) return false;
      if (lte !== undefined && !(actual <= lte)) return false;
      return true;
    }
    return false;
  }

  matches(payload, filter) {
    if (!filter) return true;
    if (filter.must && !filter.must.every((cond) => this.matchCond(payload, cond))) return false;
    if (filter.must_not && filter.must_not.some((cond) => this.matchCond(payload, cond)))
      return false;
    return true;
  }

  async request(request) {
    const path = request.path.split("?")[0];
    const segs = path.split("/").filter(Boolean);
    if (segs[0] !== "collections") return this.err(400, "bad path");
    const name = segs[1];
    const rest = segs.slice(2);
    const body = request.body;

    if (rest.length === 0) {
      if (request.method === "GET") {
        const c = this.collections.get(name);
        if (!c) return this.err(404, `Not found: Collection \`${name}\` doesn't exist!`);
        return this.ok({
          config: { params: c.params },
          payload_schema: {},
          points_count: c.points.size,
        });
      }
      if (request.method === "PUT") {
        if (this.collections.has(name)) return this.err(409, "already exists");
        this.collections.set(name, { params: body ?? {}, points: new Map() });
        return this.ok(true);
      }
      return this.err(400, "unsupported");
    }

    const c = this.collections.get(name);
    if (!c) return this.err(404, `Not found: Collection \`${name}\` doesn't exist!`);

    if (rest[0] === "points" && rest.length === 1 && request.method === "PUT") {
      for (const p of body.points) {
        c.points.set(p.id, { payload: p.payload ?? {}, vector: p.vector ?? {} });
      }
      return this.ok({ operation_id: 0, status: "completed" });
    }
    if (rest[0] === "points" && rest[1] === "scroll" && request.method === "POST") {
      const limit = typeof body.limit === "number" ? body.limit : 10;
      const offset = body.offset;
      const sorted = [...c.points.entries()]
        .filter(([, pt]) => this.matches(pt.payload, body.filter))
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const startIdx = offset === undefined ? 0 : sorted.findIndex(([id]) => id >= String(offset));
      const effStart = startIdx === -1 ? sorted.length : startIdx;
      const page = sorted.slice(effStart, effStart + limit);
      const next = sorted[effStart + limit];
      return this.ok({
        points: page.map(([id, pt]) => ({ id, payload: pt.payload })),
        next_page_offset: next ? next[0] : null,
      });
    }
    if (rest[0] === "points" && rest[1] === "delete" && request.method === "POST") {
      for (const [id, pt] of [...c.points.entries()]) {
        if (this.matches(pt.payload, body.filter)) c.points.delete(id);
      }
      return this.ok({ operation_id: 0, status: "completed" });
    }
    if (rest[0] === "points" && rest.length === 1 && request.method === "POST") {
      const ids = body.ids ?? [];
      const result = ids
        .map((id) => c.points.get(String(id)))
        .filter(Boolean)
        .map((pt, i) => ({ id: ids[i], payload: pt.payload }));
      return this.ok(result);
    }
    if (rest[0] === "points" && rest[1] === "count" && request.method === "POST") {
      let count = 0;
      for (const [, pt] of c.points) if (this.matches(pt.payload, body?.filter)) count += 1;
      return this.ok({ count });
    }
    return this.err(400, "unsupported points action");
  }
}

/**
 * Wraps an inner transport and, for `/points/delete` and `/points/count`
 * requests issued by `writer`, parks the request until the smoke script
 * explicitly releases it (pushed onto `holds`) — deterministically forcing
 * the exact two-writer interleaving the WP-77 defect needed, instead of
 * hoping real microtask timing happens to line up.
 */
export class GatedQdrantTransport {
  constructor(inner, writer, holds) {
    this.inner = inner;
    this.writer = writer;
    this.holds = holds;
  }

  async request(request, options) {
    const kind = request.path.includes("/points/delete")
      ? "delete"
      : request.path.includes("/points/count")
        ? "count"
        : undefined;
    if (kind !== undefined) {
      await new Promise((release) => this.holds.push({ writer: this.writer, kind, release }));
    }
    return this.inner.request(request, options);
  }
}
