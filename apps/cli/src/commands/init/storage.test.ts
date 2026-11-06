import { describe, expect, it, vi } from "vitest";

import { parseArgs } from "../../cli/args.js";

import { createInitCommand, initOptionsFrom } from "./command.js";
import { formatTextReport } from "./report.js";
import { runInit } from "./run.js";
import { initStorageBackend, inspectInitStorage } from "./storage.js";
import { ROOT, demoDeps, seedDemoProject, silentProbe, tagsPayload } from "./test-support.js";
import type { HttpProbePort } from "./types.js";

const OPTIONS = { root: ROOT, force: false, dryRun: false, offline: false };

describe("embedded storage setup", () => {
  it("uses the shared configuration environment mapping instead of treating unknown Qdrant variables as selection", () => {
    expect(initStorageBackend(undefined, { UNTANGLE_QDRANT_UNRELATED: "value" })).toBe("lancedb");
    expect(initStorageBackend(undefined, { UNTANGLE_QDRANT_URL: "http://127.0.0.1:16333" })).toBe(
      "qdrant",
    );
    expect(initStorageBackend("lancedb", { UNTANGLE_QDRANT_URL: "http://127.0.0.1:16333" })).toBe(
      "lancedb",
    );
  });
  it("defaults to an embedded project index without probing Qdrant or creating its directory", async () => {
    const fs = seedDemoProject();
    const requested: string[] = [];
    const http: HttpProbePort = {
      getJson: async (url) => {
        requested.push(url);
        return null;
      },
      probeEmbedding: vi.fn(),
    };
    const result = await runInit(OPTIONS, demoDeps(fs, http));
    expect(result.exitCode).toBe(0);
    expect(result.findings.storage).toMatchObject({
      backend: "lancedb",
      path: ".untangle/index/lancedb",
      directoryStatus: "missing",
    });
    expect(result.findings.qdrant).toEqual({
      outcome: "not-probed",
      probedUrls: [],
      skippedUrls: [],
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => url.startsWith("http://127.0.0.1:11434/"))).toBe(true);
    expect(result.rendered).toContain('[storage]\nbackend = "lancedb"');
    expect(result.rendered).toContain('path = ".untangle/index/lancedb"');
    expect(result.rendered).not.toContain("[qdrant]");
    expect(result.nextStep).toContain("untangle index --embedder=offline");
    expect(result.nextStep).not.toContain("docker");
    expect(formatTextReport(result).join("\n")).toContain("LanceDB");
    expect(await fs.stat(`${ROOT}/.untangle`)).toBeNull();
  });

  it("does not probe an explicit Qdrant endpoint when LanceDB is selected", async () => {
    const fs = seedDemoProject();
    const http = silentProbe();
    const get = vi.spyOn(http, "getJson");
    const deps = {
      ...demoDeps(fs, http),
      env: { UNTANGLE_QDRANT_URL: "http://qdrant.invalid:6333" },
    };
    const result = await runInit({ ...OPTIONS, storageBackend: "lancedb", dryRun: true }, deps);
    expect(result.findings.storage?.backend).toBe("lancedb");
    expect(get.mock.calls.some(([url]) => url.includes("qdrant.invalid"))).toBe(false);
    expect(await fs.stat(`${ROOT}/untangle.toml`)).toBeNull();
    expect(await fs.stat(`${ROOT}/.untangle`)).toBeNull();
  });

  it("allows explicit Qdrant selection and retains an external endpoint even while it is unavailable", async () => {
    const fs = seedDemoProject();
    const http = silentProbe();
    const get = vi.spyOn(http, "getJson");
    const result = await runInit(
      { ...OPTIONS, storageBackend: "qdrant" },
      {
        ...demoDeps(fs, http),
        env: {
          UNTANGLE_QDRANT_MODE: "external",
          UNTANGLE_QDRANT_URL: "https://vectors.example.invalid",
        },
      },
    );
    expect(result.findings.storage?.backend).toBe("qdrant");
    expect(get.mock.calls.some(([url]) => url.startsWith("https://vectors.example.invalid"))).toBe(
      true,
    );
    expect(result.rendered).toContain('[storage]\nbackend = "qdrant"');
    expect(result.rendered).toContain(
      '[qdrant]\nmode = "external"\nurl = "https://vectors.example.invalid"',
    );
    expect(result.rendered).not.toContain('path = ".untangle/index/lancedb"');
  });

  it("preserves a legacy explicit Qdrant backend through the shared TOML parser", async () => {
    const fs = seedDemoProject();
    fs.seedFile(
      `${ROOT}/untangle.toml`,
      '[qdrant]\nmode = "external"\nurl = "http://127.0.0.1:23456"\n',
    );
    const result = await runInit({ ...OPTIONS, dryRun: true }, demoDeps(fs, silentProbe()));
    expect(result.findings.storage).toMatchObject({
      backend: "qdrant",
      qdrantMode: "external",
      qdrantUrl: "http://127.0.0.1:23456",
    });
    expect(result.rendered).toContain('backend = "qdrant"');
    expect(await fs.readTextFile(`${ROOT}/untangle.toml`)).toBe(
      '[qdrant]\nmode = "external"\nurl = "http://127.0.0.1:23456"\n',
    );
  });

  it("preserves explicit LanceDB selection over stale Qdrant fields and reuses the configured local path", async () => {
    const fs = seedDemoProject();
    fs.seedFile(
      `${ROOT}/.untangle.json`,
      JSON.stringify({
        storage: { backend: "lancedb", path: ".untangle/custom-index" },
        qdrant: { mode: "external", url: "http://qdrant.invalid:6333" },
      }),
    );
    const result = await runInit({ ...OPTIONS, dryRun: true }, demoDeps(fs, silentProbe()));
    expect(result.findings.storage).toMatchObject({
      backend: "lancedb",
      path: ".untangle/custom-index",
    });
    expect(result.findings.qdrant.outcome).toBe("not-probed");
    expect(result.rendered).toContain('path = ".untangle/custom-index"');
  });

  it("reports an existing local directory without opening it and a conflicting file without replacing it", async () => {
    const fs = seedDemoProject();
    fs.seedDirectory(`${ROOT}/.untangle/index/lancedb`);
    expect(await inspectInitStorage(fs, ROOT, undefined, {})).toMatchObject({
      backend: "lancedb",
      directoryStatus: "present",
    });
    fs.seedFile(`${ROOT}/bad-index`, "preserve this file");
    const result = await runInit(
      { ...OPTIONS, dryRun: true },
      { ...demoDeps(fs, silentProbe()), env: { UNTANGLE_LANCEDB_PATH: "bad-index" } },
    );
    expect(result.findings.storage?.directoryStatus).toBe("not-directory");
    expect(result.configWarnings.join(" ")).toContain("Indexing cannot use this path");
    expect(await fs.readTextFile(`${ROOT}/bad-index`)).toBe("preserve this file");
  });

  it("can index locally with a responding embedding provider without a Qdrant setup step", async () => {
    const fs = seedDemoProject();
    const http: HttpProbePort = {
      getJson: async (url) =>
        url.endsWith("/api/tags")
          ? tagsPayload()
          : url.endsWith("/api/version")
            ? { version: "1" }
            : null,
      probeEmbedding: async () => ({ ok: true, dimensions: 1024 }),
    };
    const result = await runInit(OPTIONS, demoDeps(fs, http));
    expect(result.nextStep).toBe("Everything is available. Next step: `untangle index`.");
    expect(result.findings.qdrant.outcome).toBe("not-probed");
  });

  it("validates the scriptable backend flag before setup actions", () => {
    const command = createInitCommand();
    expect(
      initOptionsFrom(parseArgs(["--storage=lancedb"], command.spec.flags), ROOT).storageBackend,
    ).toBe("lancedb");
    expect(
      initOptionsFrom(parseArgs(["--storage=qdrant"], command.spec.flags), ROOT).storageBackend,
    ).toBe("qdrant");
    expect(() =>
      initOptionsFrom(parseArgs(["--storage=unknown"], command.spec.flags), ROOT),
    ).toThrow();
  });

  it("propagates cancellation before storage inspection and writes", async () => {
    const fs = seedDemoProject();
    const controller = new AbortController();
    controller.abort(new Error("cancel local setup"));
    const write = vi.spyOn(fs, "writeFile");
    await expect(
      runInit(OPTIONS, { ...demoDeps(fs, silentProbe()), signal: controller.signal }),
    ).rejects.toThrow("cancel local setup");
    expect(write).not.toHaveBeenCalled();
  });
});
