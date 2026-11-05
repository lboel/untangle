/**
 * WP-222 (b) — DER WIDERSPRUCH ALS TEST.
 *
 * Der Befund war nicht „doctor hat einen Fehler". Der Befund war, dass ZWEI
 * BEFEHLE DESSELBEN WERKZEUGS EINE SICHERHEITSFRAGE VERSCHIEDEN BEANTWORTET
 * HABEN — `init` verweigerte den Standardport einer fremden Qdrant-Instanz
 * unter Berufung auf spec.md §3.2, `doctor` fiel darauf zurueck, fand die
 * fremde Instanz und meldete sie als in Ordnung. Und die gefaehrlichere
 * Antwort gewann, weil ein Nutzer dem Diagnosewerkzeug glaubt.
 *
 * Ein Test, der nur `doctor` prueft, haette den Widerspruch morgen wieder
 * zugelassen. Deshalb pruefen die letzten beiden Faelle hier ausdruecklich
 * die UEBEREINSTIMMUNG der beiden Wege: was `init` anfassen darf und was
 * `wireStorage` erlaubt, kommt aus derselben Quelle und MUSS dasselbe sagen.
 */
import type { QdrantConfig } from "@untangle-code/config";
import { describe, expect, it } from "vitest";

import { CliError } from "./exit.js";
import {
  FOREIGN_DEFAULT_QDRANT_URLS,
  MANAGED_QDRANT_URL,
  assertVectorStoreAllowed,
  decideVectorStore,
  foreignDefaultFor,
  qdrantProbePlan,
} from "./vector-store-policy.js";

const FOREIGN = "http://127.0.0.1:6333";

function decide(qdrant: QdrantConfig, env: Record<string, string | undefined> = {}) {
  return decideVectorStore({ qdrant, env });
}

describe("Vektorspeicher-Regel (WP-222)", () => {
  it('"managed" bedeutet Untangles EIGENE Instanz auf 16333, nie den fremden Standardport', () => {
    const decision = decide({ mode: "managed" });
    expect(decision.allowed).toBe(true);
    expect(decision.url).toBe(MANAGED_QDRANT_URL);
    expect(decision.url).toBe("http://127.0.0.1:16333");
    expect(decision.origin).toBe("managed");
    expect(decision.url).not.toBe(FOREIGN);
  });

  it("kennt den fremden Standardport samt Grund — er ist nicht bloss abwesend (E4)", () => {
    expect(FOREIGN_DEFAULT_QDRANT_URLS.map((entry) => entry.url)).toContain(FOREIGN);
    expect(foreignDefaultFor(FOREIGN)?.reason).toContain("spec.md §3.2");
    expect(foreignDefaultFor("http://127.0.0.1:6333/")).toBeDefined();
    expect(foreignDefaultFor(MANAGED_QDRANT_URL)).toBeUndefined();
  });

  it("uebernimmt den fremden Port, wenn — und nur wenn — der Nutzer ihn benennt", () => {
    const viaEnv = decide({ mode: "managed" }, { UNTANGLE_QDRANT_URL: FOREIGN });
    expect(viaEnv.allowed).toBe(true);
    expect(viaEnv.url).toBe(FOREIGN);
    expect(viaEnv.origin).toBe("environment");

    const viaConfig = decide({ mode: "external", url: FOREIGN });
    expect(viaConfig.allowed).toBe(true);
    expect(viaConfig.origin).toBe("configured");
    expect(viaConfig.reason).toContain("spec.md §3.2");
  });

  it('"external" ohne Adresse wird gemeldet, nicht durch Raten geheilt', () => {
    const decision = decide({ mode: "external" });
    expect(decision.allowed).toBe(false);
    expect(decision.nextStep).toBeDefined();
    expect(decision.url).toBe("");
  });

  it("der Riegel bricht ab, wenn eine fremde Vorgabeadresse ungefragt durchrutscht", () => {
    const managed = decide({ mode: "managed" });
    // Genau der Fall, den der Speicheradapter frueher erzeugte: "managed"
    // ohne `url`, aufgeloest auf 6333.
    expect(() => {
      assertVectorStoreAllowed(managed, FOREIGN);
    }).toThrow(CliError);
    try {
      assertVectorStoreAllowed(managed, FOREIGN);
      expect.unreachable("der Riegel haette werfen muessen");
    } catch (error) {
      expect((error as CliError).message).toContain("foreign");
      expect((error as CliError).nextStep).toContain("UNTANGLE_QDRANT_URL");
    }
    // Und er laesst durch, was durchgelassen gehoert.
    expect(() => {
      assertVectorStoreAllowed(managed, MANAGED_QDRANT_URL);
    }).not.toThrow();
    expect(() => {
      assertVectorStoreAllowed(
        decide({ mode: "managed" }, { UNTANGLE_QDRANT_URL: FOREIGN }),
        FOREIGN,
      );
    }).not.toThrow();
  });

  it("der Probierplan fasst von sich aus nur den eigenen Port an", () => {
    const plan = qdrantProbePlan({});
    expect(plan.probe).toEqual([MANAGED_QDRANT_URL]);
    expect(plan.skipped.map((entry) => entry.url)).toEqual([FOREIGN]);
    expect(plan.skipped[0]?.reason.length ?? 0).toBeGreaterThan(0);
  });

  it("eine benannte Adresse wird zuerst probiert und verschwindet aus der Auslassliste", () => {
    const plan = qdrantProbePlan({ UNTANGLE_QDRANT_URL: FOREIGN });
    expect(plan.probe).toEqual([FOREIGN, MANAGED_QDRANT_URL]);
    expect(plan.skipped).toEqual([]);
  });

  it("KERNAUSSAGE: was init nicht anfassen darf, darf auch der Speicher nicht benutzen", () => {
    for (const skipped of qdrantProbePlan({}).skipped) {
      // Weg 1 — `untangle init`: die Adresse wird nicht einmal gelesen.
      expect(qdrantProbePlan({}).probe).not.toContain(skipped.url);
      // Weg 2 — jeder andere Befehl ueber `wireStorage`: dieselbe Adresse
      // wird abgelehnt, sobald sie ungefragt auftaucht.
      expect(() => {
        assertVectorStoreAllowed(decide({ mode: "managed" }), skipped.url);
      }).toThrow();
    }
  });

  it("KERNAUSSAGE: was der Nutzer benennt, gilt auf BEIDEN Wegen", () => {
    const env = { UNTANGLE_QDRANT_URL: FOREIGN };
    expect(qdrantProbePlan(env).probe[0]).toBe(FOREIGN);
    expect(decide({ mode: "managed" }, env).url).toBe(FOREIGN);
    expect(decide({ mode: "managed" }, env).allowed).toBe(true);
  });
});
