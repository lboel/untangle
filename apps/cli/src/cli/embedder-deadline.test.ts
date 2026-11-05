/**
 * WP-227: Die Frist um den Einbettungsdienst.
 *
 * Der Fall, um den es geht, ist der gemessene: ein Dienst, der die Verbindung
 * annimmt und dann nie antwortet. Er wird hier durch einen Einbetter
 * nachgestellt, dessen Zusage sich nur ueber das gereichte Signal aufloest —
 * genau wie ein haengendes `/api/embed`.
 */

import { UntangleError, type EmbeddingProvider } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { withEmbeddingDeadline } from "./embedder-deadline.js";

const PROFILE = {
  provider: "ollama",
  model: "test-embed",
  dimensions: 4,
  contextLength: 512,
  normalize: true,
  documentPrefix: "",
  queryPrefix: "",
} as unknown as EmbeddingProvider["profile"];

/** Ein Einbetter, der NIE von selbst antwortet. */
function hangingEmbedder(): EmbeddingProvider {
  const hang = (signal: AbortSignal | undefined): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  return {
    profile: PROFILE,
    profileId: "test-profile",
    ensureReady: (options) => hang(options?.signal),
    embedDocuments: (_texts, options) => hang(options?.signal),
    embedQuery: (_text, options) => hang(options?.signal),
  };
}

describe("withEmbeddingDeadline", () => {
  it("beendet eine haengende Bereitschaftspruefung mit EMBEDDING_UNAVAILABLE", async () => {
    const guarded = withEmbeddingDeadline(hangingEmbedder(), {
      timeoutMs: 25,
      outerSignal: new AbortController().signal,
    });

    const error = await guarded.ensureReady().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UntangleError);
    expect((error as UntangleError).code).toBe("EMBEDDING_UNAVAILABLE");
    // Der Grund muss die Frist NENNEN — „ist nicht bereit" allein liesse den
    // Nutzer wieder raten, ob es haengt oder nur dauert.
    expect((error as UntangleError).message).toContain("25 ms");
    expect((error as UntangleError).message).toContain("cancelled");
  });

  it("nennt einen Fristablauf NIE einen Abbruch (sonst waere es Exit 130 statt 4)", async () => {
    const guarded = withEmbeddingDeadline(hangingEmbedder(), {
      timeoutMs: 25,
      outerSignal: new AbortController().signal,
    });

    const error = (await guarded
      .embedDocuments(["a", "b"])
      .catch((thrown: unknown) => thrown)) as UntangleError;

    expect(error.code).not.toBe("JOB_CANCELLED");
    expect(error.name).not.toBe("AbortError");
  });

  it("reicht einen ECHTEN Abbruch des Nutzers unveraendert durch", async () => {
    const controller = new AbortController();
    const guarded = withEmbeddingDeadline(hangingEmbedder(), {
      timeoutMs: 60_000,
      outerSignal: controller.signal,
    });

    const pending = guarded.embedQuery("frage").catch((thrown: unknown) => thrown);
    controller.abort();
    const error = await pending;

    expect(error).not.toBeInstanceOf(UntangleError);
    expect((error as Error).name).toBe("AbortError");
  });

  it("meldet von der ersten Sekunde an, worauf gewartet wird", async () => {
    const seen: string[] = [];
    const guarded = withEmbeddingDeadline(hangingEmbedder(), {
      timeoutMs: 60,
      heartbeatMs: 15,
      outerSignal: new AbortController().signal,
      onProgress: (text) => seen.push(text),
    });

    await guarded.ensureReady().catch(() => undefined);

    // Die erste Zeile steht VOR dem Warten, nicht danach.
    expect(seen[0]).toContain("readiness check");
    // Und danach gibt es Lebenszeichen, statt 300 Sekunden Schweigen.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.slice(1).join("\n")).toContain("without a response");
  });

  it("laesst einen antwortenden Einbetter unangetastet durch", async () => {
    const inner: EmbeddingProvider = {
      profile: PROFILE,
      profileId: "test-profile",
      ensureReady: () =>
        Promise.resolve({
          endpoint: "http://localhost:11434",
          model: "test-embed",
          dimensions: 4,
          probedAt: "2026-01-01T00:00:00.000Z",
        }),
      embedDocuments: (texts) =>
        Promise.resolve({
          vectors: texts.map(() => [0, 0, 0, 1]),
          truncated: texts.map(() => false),
        }),
      embedQuery: () => Promise.resolve([0, 0, 0, 1]),
    };
    const guarded = withEmbeddingDeadline(inner, {
      timeoutMs: 50,
      outerSignal: new AbortController().signal,
    });

    await expect(guarded.embedDocuments(["a"])).resolves.toEqual({
      vectors: [[0, 0, 0, 1]],
      truncated: [false],
    });
    expect(guarded.profileId).toBe("test-profile");
    expect(guarded.profile.model).toBe("test-embed");
  });
});
