/**
 * `untangle init` — behaviour, not implementation.
 *
 * Every case here is one of WP-125's promises: recognise languages by line
 * weight, recognise BOTH levels of a monorepo, survive missing
 * infrastructure, honour `.gitignore`, write comments, and be idempotent.
 */

import { describe, expect, it } from "vitest";

import { FOREIGN_DEFAULT_QDRANT_URLS, MANAGED_QDRANT_URL } from "../../cli/vector-store-policy.js";

import { buildConfigDraft, deriveProjectId, nextStepFor } from "./config-draft.js";
import { diffLines, toLines } from "./diff.js";
import { parseGitignore, selectAdditionalExcludes } from "./ignore-rules.js";
import { countLines, roundShare } from "./languages.js";
import { formatTextReport } from "./report.js";
import { runInit } from "./run.js";
import { chooseEmbeddingModel, readEmbeddingModels } from "./services.js";
import {
  HANGING_EMBED_PROBE,
  ROOT,
  demoDeps,
  scriptedProbe,
  seedDemoProject,
  silentProbe,
  tagsPayload,
} from "./test-support.js";
import { TomlWriter, escapeTomlString, formatTomlNumber } from "./toml.js";
import type { EmbedProbeResult } from "./types.js";

const OFFLINE = { root: ROOT, force: false, dryRun: false, offline: true } as const;

describe("Sprachzaehlung", () => {
  it("gewichtet nach Zeilen und nicht nach Dateien", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    const census = result.findings.languages;

    const python = census.entries.find((entry) => entry.languageId === "python");
    const typescript = census.entries.find((entry) => entry.languageId === "typescript");
    expect(python).toBeDefined();
    expect(typescript).toBeDefined();
    // 2 Python-Dateien (150 Zeilen) gegen 2 TypeScript-Dateien (100 Zeilen):
    // nach Dateien gleichauf, nach Zeilen nicht — und Zeilen entscheiden.
    expect(python?.fileCount).toBe(2);
    expect(typescript?.fileCount).toBe(2);
    expect((python?.lineCount ?? 0) > (typescript?.lineCount ?? 0)).toBe(true);
    expect(census.entries[0]?.languageId).toBe("python");
  });

  it("nennt fuer jede Sprache, ob sie einen Parser hat", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    const byId = new Map(
      result.findings.languages.entries.map((entry) => [entry.languageId, entry]),
    );
    expect(byId.get("python")?.hasParserAdapter).toBe(true);
    expect(byId.get("typescript")?.hasParserAdapter).toBe(true);
    expect(byId.get("python")?.supportLevel).toBe("deep");
    // WP-240: hier stand frueher `false`. Das war falsch, seit es den
    // `structured-text`-Adapter gibt: der Scanner meldet die Sprach-ID
    // "yaml", die Registry fuehrt YAML aber unter "structured-text" — und
    // `getAdapterByLanguage("yaml")` fand deshalb nichts. `init` behauptete
    // "kein Parser — nur Textsuche" ueber ein Format mit Adapter. Die
    // Aufloesung geht jetzt zusaetzlich ueber die Dateiendung.
    expect(byId.get("yaml")?.hasParserAdapter).toBe(true);
    expect(byId.get("yaml")?.supportLevel).toBe("text");
    expect(result.findings.languages.parsedLineShare).toBeGreaterThan(0);
  });

  it("zaehlt ausgeschlossene Verzeichnisse nicht mit", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    // artifacts/report.ts hat 500 Zeilen und wuerde jede Verteilung kippen.
    expect(result.findings.languages.totalLines).toBeLessThan(500);
    expect(result.findings.languages.excluded.length).toBeGreaterThan(0);
  });

  it("countLines zaehlt die letzte Zeile ohne Zeilenumbruch mit", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("\n")).toBe(1);
  });

  it("roundShare ist auf vier Stellen stabil", () => {
    expect(roundShare(1 / 3)).toBe(0.3333);
    expect(roundShare(Number.NaN)).toBe(0);
  });
});

describe("Topologie", () => {
  it("erkennt Workspace-Pakete UND Container-Dienste", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    const topology = result.findings.topology;

    // Auch die Wurzel ist ein Paket: package.json am Repositorywurzel ist ein
    // Manifest wie jedes andere, und der Graph muss es kennen.
    expect(topology.packages.map((pkg) => pkg.name)).toEqual([
      "@demo/api",
      "@demo/core",
      "@demo/web",
      "demo",
    ]);
    expect(topology.services.map((service) => service.name)).toEqual([
      "backend",
      "frontend",
      "worker",
    ]);
    expect(topology.isMonorepo).toBe(true);
    expect(topology.workspaceGlobs).toContain("packages/*");
    // frontend depends_on backend, plus das gemeinsame Netz `edge`.
    expect(topology.serviceEdgeCount).toBeGreaterThan(0);
  });
});

describe("Infrastruktur", () => {
  it("ist ohne Ollama und ohne Qdrant KEIN Fehler", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("created");
    expect(result.findings.ollama.outcome).toBe("unreachable");
    expect(result.findings.qdrant.outcome).toBe("unreachable");
    expect(result.nextStep).toMatch(/ollama serve/u);
    expect(await fs.readTextFile(result.configPath)).toContain("[embeddings]");
  });

  it("nennt genau EINEN naechsten Schritt", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    expect(result.nextStep.split("Next step").length - 1).toBe(1);
  });

  it("uebernimmt Modell, Breite und Kontext aus dem, was der Anbieter meldet", async () => {
    const fs = seedDemoProject();
    const http = scriptedProbe({
      "http://127.0.0.1:11434/api/version": { version: "0.33.2" },
      "http://127.0.0.1:11434/api/tags": tagsPayload(),
    });
    const result = await runInit({ ...OFFLINE, offline: false }, demoDeps(fs, http));
    expect(result.findings.ollama.chosenModel?.name).toBe("wide-embed:0.6b");
    expect(result.findings.ollama.chosenModel?.dimensions).toBe(1024);

    const written = await fs.readTextFile(result.configPath);
    expect(written).toContain('model = "wide-embed:0.6b"');
    expect(written).toContain("dimensions = 1024");
    expect(written).toContain("contextLength = 32768");
    expect(result.nextStep).toMatch(/untangle-qdrant/u);
  });

  it("prueft den Standardport einer fremden Instanz bewusst NICHT", async () => {
    const fs = seedDemoProject();
    const probed: string[] = [];
    const http = {
      getJson: (url: string): Promise<unknown | null> => {
        probed.push(url);
        return Promise.resolve(null);
      },
      probeEmbedding: (): Promise<EmbedProbeResult> =>
        Promise.resolve({ ok: false, timedOut: false, detail: "no provider" }),
    };
    const result = await runInit({ ...OFFLINE, offline: false }, demoDeps(fs, http));
    expect(probed.some((url) => url.includes(":6333"))).toBe(false);
    expect(result.findings.qdrant.skippedUrls.map((entry) => entry.url)).toEqual(
      FOREIGN_DEFAULT_QDRANT_URLS.map((entry) => entry.url),
    );
    // und der Grund steht in der Datei, nicht nur im Kopf des Autors
    expect(await fs.readTextFile(result.configPath)).toContain("DELIBERATELY NOT CHECKED");
  });

  it("nennt einen Anbieter NICHT benutzbar, wenn /api/embed nicht antwortet (WP-228)", async () => {
    // Der gemessene Zustand: /api/version und /api/tags antworten sofort,
    // /api/embed haengt. Vorher meldete init hier „erreichbar" und riet zu
    // `untangle index` — einem Befehl, der dann stumm haengen blieb.
    const fs = seedDemoProject();
    const http = scriptedProbe(
      {
        "http://127.0.0.1:11434/api/version": { version: "0.33.2" },
        "http://127.0.0.1:11434/api/tags": tagsPayload(),
        // Der Vektorspeicher ist da: sonst waere ER der erste Blocker, und
        // der eine naechste Schritt spraeche von Qdrant statt vom Einbetten.
        [`${MANAGED_QDRANT_URL}/`]: { version: "1.12.0" },
      },
      HANGING_EMBED_PROBE,
    );
    const result = await runInit({ ...OFFLINE, offline: false }, demoDeps(fs, http));

    expect(result.findings.ollama.outcome).toBe("reachable");
    expect(result.findings.ollama.embedProbe.outcome).toBe("timeout");
    // Der eine naechste Schritt fuehrt jetzt am haengenden Dienst vorbei.
    expect(result.nextStep).toContain("--embedder=offline");
    expect(result.nextStep).toContain("/api/embed");
    // Und der Befund steht in der Datei, nicht nur im Terminal.
    const written = await fs.readTextFile(result.configPath);
    expect(written).toContain("/api/embed");
  });

  it("prueft /api/embed und sagt das auch, wenn es gut ausging (WP-228)", async () => {
    const fs = seedDemoProject();
    const http = scriptedProbe({
      "http://127.0.0.1:11434/api/version": { version: "0.33.2" },
      "http://127.0.0.1:11434/api/tags": tagsPayload(),
    });
    const result = await runInit({ ...OFFLINE, offline: false }, demoDeps(fs, http));

    expect(result.findings.ollama.embedProbe.outcome).toBe("ok");
    expect(result.findings.ollama.embedProbe.dimensions).toBe(1024);
    // Eine Zeile, die nur bei Problemen erscheint, liest sich in ihrer
    // Abwesenheit wie „geprueft und in Ordnung".
    expect(formatTextReport(result).join("\n")).toContain("/api/embed checked");
  });

  it("prueft /api/embed gar nicht erst, wenn kein Modell gemeldet wird", async () => {
    const fs = seedDemoProject();
    const http = scriptedProbe({
      "http://127.0.0.1:11434/api/version": { version: "0.33.2" },
      "http://127.0.0.1:11434/api/tags": { models: [] },
    });
    const result = await runInit({ ...OFFLINE, offline: false }, demoDeps(fs, http));
    expect(result.findings.ollama.embedProbe.outcome).toBe("not-probed");
  });

  it("waehlt das Modell mit dem groessten Kontextfenster, deterministisch", () => {
    const models = readEmbeddingModels(tagsPayload());
    expect(models.map((model) => model.name)).toEqual(["small-embed:300m", "wide-embed:0.6b"]);
    expect(chooseEmbeddingModel(models)?.model.name).toBe("wide-embed:0.6b");
    expect(chooseEmbeddingModel(models, "small-embed:300m")?.model.name).toBe("small-embed:300m");
    expect(chooseEmbeddingModel([])).toBeUndefined();
  });
});

describe("Ignorierregeln", () => {
  it("hebt projekteigene Ausgabeverzeichnisse aus .gitignore, aber keine Ausnahmen", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    const ignore = result.findings.ignore;
    expect(ignore.gitignorePresent).toBe(true);
    expect(ignore.additionalExcludes).toEqual(["artifacts"]);
    expect(ignore.gitignoreNegationCount).toBe(1);
    // node_modules/ und dist/ stehen schon in den Vorgaben und werden nicht doppelt gefuehrt
    expect(ignore.additionalExcludes).not.toContain("dist");
  });

  it("parseGitignore ignoriert Kommentare und leere Zeilen", () => {
    const rules = parseGitignore("# c\n\n  build/  \n!keep\n");
    expect(rules).toEqual([
      { pattern: "build/", negated: false, directoryOnly: true },
      { pattern: "keep", negated: true, directoryOnly: false },
    ]);
  });

  it("selectAdditionalExcludes laesst Dateimuster und Pfade liegen", () => {
    const picked = selectAdditionalExcludes(
      parseGitignore(
        "*.log\nbackend/.env\nout/\nmy-cache/\nfoo.txt\n.untangle.local.json\n.turbo/\n",
      ),
    );
    // out/ steht schon in den Vorgaben; foo.txt und .untangle.local.json sind
    // Dateien; backend/.env ist ein Pfad; *.log ist ein Muster.
    expect(picked).toEqual([".turbo", "my-cache"]);
  });
});

describe("untangle.toml", () => {
  it("erklaert jede Entscheidung mit einem Kommentar", async () => {
    const fs = seedDemoProject();
    const result = await runInit({ ...OFFLINE }, demoDeps(fs, silentProbe()));
    const text = result.rendered;
    for (const heading of [
      "FINDING 1 — LANGUAGES",
      "FINDING 2 — TOPOLOGY",
      "FINDING 3 — INFRASTRUCTURE",
      "FINDING 4 — IGNORE RULES",
      "NEXT STEP",
    ]) {
      expect(text).toContain(heading);
    }
    // Die Teilprojekte stehen namentlich drin, nicht nur als Zahl.
    expect(text).toContain("@demo/core");
    expect(text).toContain("frontend");
    // Kommentaranteil: die Datei ist erklaerend, nicht eine nackte Wertetabelle.
    const lines = toLines(text);
    const comments = lines.filter((entry) => entry.startsWith("#")).length;
    expect(comments).toBeGreaterThan(lines.length / 2);
  });

  it("enthaelt keine Zeitstempel und ist damit reproduzierbar", async () => {
    const first = await runInit({ ...OFFLINE }, demoDeps(seedDemoProject(), silentProbe()));
    const second = await runInit({ ...OFFLINE }, demoDeps(seedDemoProject(), silentProbe()));
    expect(second.rendered).toBe(first.rendered);
    expect(first.rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it("ist gueltig gegen das Schema von @untangle-code/config", async () => {
    const result = await runInit({ ...OFFLINE }, demoDeps(seedDemoProject(), silentProbe()));
    expect(result.configErrors).toEqual([]);
    const draft = buildConfigDraft(result.findings);
    expect(draft.errors).toEqual([]);
    expect(draft.layer.repositories?.[0]?.path).toBe(".");
  });
});

describe("Idempotenz", () => {
  it("aendert beim zweiten Lauf nichts", async () => {
    const fs = seedDemoProject();
    const deps = demoDeps(fs, silentProbe());
    const first = await runInit({ ...OFFLINE }, deps);
    expect(first.outcome).toBe("created");

    const second = await runInit({ ...OFFLINE }, deps);
    expect(second.outcome).toBe("unchanged");
    expect(second.changes).toEqual([]);
    expect(second.exitCode).toBe(0);
    expect(await fs.readTextFile(first.configPath)).toBe(first.rendered);
  });

  it("meldet Abweichungen und fasst die Datei ohne --force nicht an", async () => {
    const fs = seedDemoProject();
    const deps = demoDeps(fs, silentProbe());
    const first = await runInit({ ...OFFLINE }, deps);
    await fs.writeFile(
      first.configPath,
      new TextEncoder().encode(
        first.rendered.replace('projectId = "demo"', 'projectId = "haende-weg"'),
      ),
    );

    const second = await runInit({ ...OFFLINE }, deps);
    expect(second.outcome).toBe("differs");
    expect(second.exitCode).toBe(1);
    expect(second.changes).toContainEqual({ kind: "removed", line: 'projectId = "haende-weg"' });
    expect(second.changes).toContainEqual({ kind: "added", line: 'projectId = "demo"' });
    expect(await fs.readTextFile(first.configPath)).toContain("haende-weg");
  });

  it("--force ueberschreibt", async () => {
    const fs = seedDemoProject();
    const deps = demoDeps(fs, silentProbe());
    const first = await runInit({ ...OFFLINE }, deps);
    await fs.writeFile(first.configPath, new TextEncoder().encode("kaputt\n"));

    const forced = await runInit({ ...OFFLINE, force: true }, deps);
    expect(forced.outcome).toBe("overwritten");
    expect(await fs.readTextFile(first.configPath)).toBe(forced.rendered);
  });

  it("--dry-run schreibt nichts", async () => {
    const fs = seedDemoProject();
    const deps = demoDeps(fs, silentProbe());
    const dry = await runInit({ ...OFFLINE, dryRun: true }, deps);
    expect(dry.outcome).toBe("would-create");
    expect(dry.exitCode).toBe(0);
    expect(await fs.stat(dry.configPath)).toBeNull();

    await runInit({ ...OFFLINE }, deps);
    const dryAgain = await runInit({ ...OFFLINE, dryRun: true }, deps);
    expect(dryAgain.outcome).toBe("would-be-unchanged");
  });
});

describe("Bausteine", () => {
  it("diffLines nennt Zugaenge und Abgaenge", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([
      { kind: "removed", line: "b" },
      { kind: "added", line: "x" },
    ]);
    expect(diffLines(["a"], ["a"])).toEqual([]);
  });

  it("deriveProjectId erzeugt einen brauchbaren Namen", () => {
    expect(deriveProjectId("Mein Projekt")).toBe("mein-projekt");
    expect(deriveProjectId("untangle")).toBe("untangle");
    expect(deriveProjectId("...")).toBe("project");
  });

  it("TOML wird korrekt maskiert", () => {
    expect(escapeTomlString('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(formatTomlNumber(5)).toBe("5");
    expect(formatTomlNumber(0.5)).toBe("0.5");
    expect(() => formatTomlNumber(Number.POSITIVE_INFINITY)).toThrow();
    expect(new TomlWriter().table(["a", "b c"]).scalar("k", true).render()).toBe(
      '[a."b c"]\nk = true\n',
    );
  });

  it("nextStepFor bevorzugt die erste Bremse", async () => {
    const result = await runInit({ ...OFFLINE }, demoDeps(seedDemoProject(), silentProbe()));
    const findings = result.findings;
    expect(nextStepFor(findings)).toMatch(/ollama serve/u);
    expect(
      nextStepFor({
        ...findings,
        ollama: { ...findings.ollama, outcome: "reachable" },
      }),
    ).toMatch(/ollama pull/u);
  });
});
