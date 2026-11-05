/**
 * Container-Kompositionsdatei → Dienstknoten und Dienstkanten.
 *
 * WARUM DAS HIERHER GEHOERT (Nutzerwunsch A3): Ein Monorepo ist nicht nur ein
 * Importgraph. Wer wissen will, was bricht, wenn er etwas aendert, muss auch
 * die Betriebsebene sehen: `frontend`, `backend`, `worker` sind Knoten einer
 * groeberen Ebene, und ihre Startreihenfolge (`depends_on`) und ihre
 * Erreichbarkeit (gemeinsame Netzwerke) sind Kanten, die kein Import je
 * abbildet.
 *
 * ZWEI KANTENARTEN, BEWUSST GETRENNT:
 * - `depends_on` ist GERICHTET und beantwortet „wer braucht wen zuerst";
 * - `shared-network` ist UNGERICHTET (als zwei gegenlaeufige Kanten gefuehrt)
 *   und beantwortet „wer kann wen ueberhaupt erreichen". Zwei Dienste ohne
 *   `depends_on`, aber im selben Netzwerk, koennen einander trotzdem
 *   aufrufen — das waere sonst ein unsichtbarer Zusammenhang.
 *
 * IMPLIZITES `default`-NETZWERK: Compose legt fuer jede Datei ein Netzwerk
 * `default` an, dem jeder Dienst ohne eigene `networks`-Angabe beitritt. Wer
 * das weglaesst, meldet fuer die haeufigste aller Kompositionsdateien — eine
 * ohne jede `networks`-Angabe — null Erreichbarkeitskanten, obwohl in
 * Wirklichkeit jeder jeden erreicht.
 */
import { compareCodepoints, compareByKeys } from "@untangle-code/domain";
import { parse as parseYaml } from "yaml";

import { dirnameOf, joinRelative, normalizePath } from "../paths.js";
import type { ContainerServiceEdgeV1, ContainerServiceV1 } from "../types.js";

/** Name des impliziten Netzwerks, dem Dienste ohne eigene Angabe beitreten. */
export const IMPLICIT_DEFAULT_NETWORK = "default";

/** Dateinamen, die als Kompositionsdatei gelten (Compose-Spezifikation). */
export const COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

export interface ComposeParseResultV1 {
  services: ContainerServiceV1[];
  edges: ContainerServiceEdgeV1[];
  /** Was nicht gelesen werden konnte, mit Grund (E4). */
  warnings: string[];
}

export type ComposeReadResult =
  { ok: true; result: ComposeParseResultV1 } | { ok: false; error: string };

/**
 * Liest eine Kompositionsdatei.
 *
 * `composeFilePath` ist repo-relativ; relative Build-Kontexte werden gegen
 * SEIN Verzeichnis aufgeloest, nicht gegen die Repositorywurzel — genau so
 * verhaelt sich Compose auch.
 */
export function parseComposeFile(
  repoId: string,
  composeFilePath: string,
  text: string,
): ComposeReadResult {
  let document: unknown;
  try {
    document = parseYaml(text) as unknown;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isObject(document)) {
    return { ok: false, error: "compose document root is not a mapping" };
  }
  const servicesValue = document["services"];
  if (!isObject(servicesValue)) {
    return { ok: false, error: 'compose document has no "services" mapping' };
  }

  const composeFile = normalizePath(composeFilePath);
  const composeDir = dirnameOf(composeFile);
  const warnings: string[] = [];
  const services: ContainerServiceV1[] = [];

  for (const [name, rawService] of Object.entries(servicesValue)) {
    if (!isObject(rawService)) {
      warnings.push(`service "${name}" in ${composeFile} is not a mapping`);
      continue;
    }
    const service: ContainerServiceV1 = {
      name,
      repoId,
      composeFile,
      dependsOn: readDependsOn(rawService, name, composeFile, warnings).names,
      networks: readNetworks(rawService, name, composeFile, warnings),
    };
    const image = rawService["image"];
    if (typeof image === "string") {
      service.image = image;
    }
    const buildContext = readBuildContext(rawService, composeDir, name, composeFile, warnings);
    if (buildContext !== undefined) {
      service.buildContext = buildContext;
    }
    services.push(service);
  }

  services.sort((left, right) => compareCodepoints(left.name, right.name));

  const knownNames = new Set(services.map((service) => service.name));
  const edges: ContainerServiceEdgeV1[] = [];

  for (const [name, rawService] of Object.entries(servicesValue)) {
    if (!isObject(rawService)) continue;
    const dependsOn = readDependsOn(rawService, name, composeFile, warnings);
    for (const target of dependsOn.names) {
      if (!knownNames.has(target)) {
        // E4: eine `depends_on`-Angabe auf einen unbekannten Dienst wird
        // gemeldet, nicht verschluckt — sie ist fast immer ein Tippfehler.
        warnings.push(`service "${name}" in ${composeFile} depends_on unknown service "${target}"`);
        continue;
      }
      const edge: ContainerServiceEdgeV1 = {
        fromService: name,
        toService: target,
        kind: "depends_on",
      };
      const condition = dependsOn.conditions[target];
      if (condition !== undefined) {
        edge.condition = condition;
      }
      edges.push(edge);
    }
  }

  // Erreichbarkeit: je Netzwerk jedes geordnete Paar verschiedener Dienste.
  const membersByNetwork = new Map<string, string[]>();
  for (const service of services) {
    for (const network of service.networks) {
      const members = membersByNetwork.get(network) ?? [];
      members.push(service.name);
      membersByNetwork.set(network, members);
    }
  }
  for (const [network, rawMembers] of [...membersByNetwork.entries()].sort((left, right) =>
    compareCodepoints(left[0], right[0]),
  )) {
    const members = [...rawMembers].sort(compareCodepoints);
    for (const from of members) {
      for (const to of members) {
        if (from === to) continue;
        edges.push({ fromService: from, toService: to, kind: "shared-network", network });
      }
    }
  }

  edges.sort((left, right) =>
    compareByKeys(
      ["kind", "fromService", "toService", "network"] as const,
      sortable(left),
      sortable(right),
    ),
  );

  return { ok: true, result: { services, edges, warnings } };
}

/** Vergleichsform: `compareByKeys` verlangt Strings, `network` ist optional. */
function sortable(edge: ContainerServiceEdgeV1): {
  kind: string;
  fromService: string;
  toService: string;
  network: string;
} {
  return {
    kind: edge.kind,
    fromService: edge.fromService,
    toService: edge.toService,
    network: edge.network ?? "",
  };
}

function readDependsOn(
  service: Record<string, unknown>,
  serviceName: string,
  composeFile: string,
  warnings: string[],
): { names: string[]; conditions: Record<string, string> } {
  const value = service["depends_on"];
  const conditions: Record<string, string> = {};
  if (value === undefined) {
    return { names: [], conditions };
  }
  // Kurzform: eine Liste von Dienstnamen.
  if (Array.isArray(value)) {
    const names = value.filter((entry): entry is string => typeof entry === "string");
    if (names.length !== value.length) {
      warnings.push(`depends_on of "${serviceName}" in ${composeFile} contains non-string entries`);
    }
    return { names: names.sort(compareCodepoints), conditions };
  }
  // Langform: Name → { condition: ... }.
  if (isObject(value)) {
    const names: string[] = [];
    for (const [target, options] of Object.entries(value)) {
      names.push(target);
      if (isObject(options) && typeof options["condition"] === "string") {
        conditions[target] = options["condition"];
      }
    }
    return { names: names.sort(compareCodepoints), conditions };
  }
  warnings.push(`depends_on of "${serviceName}" in ${composeFile} is neither a list nor a mapping`);
  return { names: [], conditions };
}

function readNetworks(
  service: Record<string, unknown>,
  serviceName: string,
  composeFile: string,
  warnings: string[],
): string[] {
  const value = service["networks"];
  if (value === undefined) {
    return [IMPLICIT_DEFAULT_NETWORK];
  }
  if (Array.isArray(value)) {
    const names = value.filter((entry): entry is string => typeof entry === "string");
    if (names.length !== value.length) {
      warnings.push(`networks of "${serviceName}" in ${composeFile} contains non-string entries`);
    }
    return names.length === 0 ? [IMPLICIT_DEFAULT_NETWORK] : names.sort(compareCodepoints);
  }
  if (isObject(value)) {
    const names = Object.keys(value).sort(compareCodepoints);
    return names.length === 0 ? [IMPLICIT_DEFAULT_NETWORK] : names;
  }
  warnings.push(`networks of "${serviceName}" in ${composeFile} is neither a list nor a mapping`);
  return [IMPLICIT_DEFAULT_NETWORK];
}

function readBuildContext(
  service: Record<string, unknown>,
  composeDir: string,
  serviceName: string,
  composeFile: string,
  warnings: string[],
): string | undefined {
  const build = service["build"];
  const rawContext =
    typeof build === "string"
      ? build
      : isObject(build) && typeof build["context"] === "string"
        ? build["context"]
        : undefined;
  if (rawContext === undefined) {
    return undefined;
  }
  const resolved = joinRelative(composeDir, rawContext);
  if (resolved === null) {
    warnings.push(
      `build context of "${serviceName}" in ${composeFile} escapes the repository root: ${rawContext}`,
    );
    return undefined;
  }
  return resolved;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
