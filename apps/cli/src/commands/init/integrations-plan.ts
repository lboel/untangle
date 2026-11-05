/** Opt-in onboarding offers. The extension runtime still consumes formats, not vendors. */
import { createHash } from "node:crypto";
import path from "node:path";

import { UsageError } from "../../cli/exit.js";

export type IntegrationId =
  "local-search" | "sonarqube-local" | "sonarqube-existing" | "sentrux" | "custom";

export interface IntegrationOfferV1 {
  id: IntegrationId;
  label: string;
  description: string;
  documentation: string;
  licenseSummary: string;
  requiresLicenseAcknowledgment: boolean;
}

export interface IntegrationSelectionV1 {
  id: IntegrationId;
  endpoint?: string;
  projectKey?: string;
  tokenEnvVar?: string;
  manifestPath?: string;
  manifestDigest?: string;
  acknowledgeLicense?: boolean;
  allowProjectLocal?: boolean;
}

export interface IntegrationCommandV1 {
  command: string;
  args: readonly string[];
  purpose: string;
  kind: "process" | "extension";
}

export interface IntegrationFileV1 {
  relativePath: string;
  content: string;
}

export interface IntegrationDownloadV1 {
  url: string;
  sha256: string;
  relativePath: string;
  maxBytes: number;
}

export interface IntegrationPlanItemV1 {
  id: IntegrationId;
  label: string;
  files: readonly IntegrationFileV1[];
  commands: readonly IntegrationCommandV1[];
  downloads: readonly IntegrationDownloadV1[];
  blockers: readonly string[];
  nextSteps: readonly string[];
  licenseAcknowledged: boolean;
  projectName?: string;
}

export interface IntegrationSetupOptionsV1 {
  root: string;
  selections: readonly IntegrationSelectionV1[];
  offline?: boolean;
  platform?: string;
  arch?: string;
}

export interface IntegrationSetupPlanV1 {
  schemaVersion: 1;
  root: string;
  selections: readonly IntegrationSelectionV1[];
  offline: boolean;
  platform: string;
  arch: string;
  items: readonly IntegrationPlanItemV1[];
}

export const SONAR_IMAGE =
  "sonarqube@sha256:f95aaa9016dd4e92c7d70691167a6d96dbb5d8acffd61eba1cb4335d364a7840";
export const SENTRUX_VERSION = "0.5.7";

const OFFERS: readonly IntegrationOfferV1[] = [
  {
    id: "local-search",
    label: "Local search — Qdrant and Ollama",
    description:
      "Prepare or start isolated loopback-only search services and explicitly pull the default nomic embedding model. No index is built automatically.",
    documentation: "https://github.com/lboel/untangle/blob/main/docker/README.md",
    licenseSummary:
      "Qdrant: Apache-2.0; Ollama: MIT; review the selected embedding model's license.",
    requiresLicenseAcknowledgment: false,
  },
  {
    id: "sonarqube-local",
    label: "SonarQube — local Docker installation",
    description:
      "Prepare or start a pinned, loopback-only evaluation server (4 GB RAM and 2 cores starting point). Account, project and scanner setup remain explicit; installing the server does not analyze code.",
    documentation: "https://hub.docker.com/_/sonarqube/",
    licenseSummary:
      "Community server: LGPL-3.0; included analyzers can have additional, edition-specific terms. Review the selected distribution before starting it.",
    requiresLicenseAcknowledgment: true,
  },
  {
    id: "sonarqube-existing",
    label: "SonarQube — existing project metrics",
    description:
      "Generate a declarative HTTP extension for an existing analyzed project. Remote metrics remain external evidence; source freshness is not inferred.",
    documentation: "https://docs.sonarsource.com/sonarqube-server/extension-guide/web-api",
    licenseSummary: "Review the server edition and analyzer terms before using the service.",
    requiresLicenseAcknowledgment: true,
  },
  {
    id: "sentrux",
    label: "Sentrux — project-local binary and MCP template",
    description:
      "Install a hash-verified release binary below .untangle/tools and prepare its documented MCP configuration. This is a separate MCP tool, not a normalized Untangle metric adapter.",
    documentation: "https://sentrux.dev/docs/installation/",
    licenseSummary: "The public repository declares MIT; verify the chosen release terms.",
    requiresLicenseAcknowledgment: false,
  },
  {
    id: "custom",
    label: "Other analyzer — trusted extension manifest",
    description:
      "Explicitly import a manifest for SARIF, JUnit XML, generic findings or generic metrics. The existing source-digest, project-trust and license gates remain active.",
    documentation: "https://github.com/lboel/untangle/blob/main/extensions.md",
    licenseSummary:
      "Declared by the supplied manifest; restricted licenses need explicit acknowledgment.",
    requiresLicenseAcknowledgment: false,
  },
];

export function integrationCatalog(): readonly IntegrationOfferV1[] {
  return OFFERS.map((offer) => ({ ...offer }));
}

const RELEASES: Readonly<Record<string, { artifact: string; sha256: string }>> = {
  "darwin:arm64": {
    artifact: "sentrux-darwin-arm64",
    sha256: "30ae1a44d4478adf294019fce6d65ce5686c25bc863eb715b320c5234927f6c2",
  },
  "linux:arm64": {
    artifact: "sentrux-linux-aarch64",
    sha256: "27e1b4a3e4716b341dd76e9736a5553c6737c24e165cc27e0dbc399cc5b4d786",
  },
  "linux:x64": {
    artifact: "sentrux-linux-x86_64",
    sha256: "3237f80fe20d54aad4deefa8a143f0d60543bb5d2d6ad891eb42432f155725a6",
  },
  "win32:x64": {
    artifact: "sentrux-windows-x86_64.exe",
    sha256: "40dd2e47804bf9f006015eb742abfe178a824f42d4a19eb00478a7d705697cac",
  },
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const quote = (value: string): string => JSON.stringify(value);

function safeEndpoint(raw: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new UsageError("The analyzer endpoint must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new UsageError(
      "Analyzer URLs cannot contain credentials, query parameters or fragments.",
    );
  }
  return endpoint.href.replace(/\/$/u, "");
}

function sonarManifest(endpoint: string, key: string, tokenEnvVar: string): string {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname);
  return [
    "# Generated only after an explicit init integration selection.",
    "# Reads prior remote analysis, not the current local source revision.",
    "schemaVersion = 1",
    'id = "sonarqube"',
    'displayName = "SonarQube project metrics"',
    'category = "quality-platform"',
    'invocation = ["http"]',
    "languages = []",
    'outputFormat = "generic-metrics"',
    `networkAccess = ${quote(local ? "loopback" : "internet")}`,
    'networkJustification = "Explicitly selected server endpoint; reads existing project metrics."',
    "requiresLicenseAcknowledgment = true",
    "",
    "[http]",
    `defaultUrl = ${quote(endpoint)}`,
    'authSecretName = "token"',
    `analyzePath = ${quote(`/api/measures/component?component=${encodeURIComponent(key)}&metricKeys=cognitive_complexity%2Ccomplexity%2Cncloc%2Cduplicated_lines_density`)}`,
    'analyzeMethod = "GET"',
    "",
    "[resources]",
    "minMemoryMb = 1",
    "recommendedMemoryMb = 16",
    "recommendedCpus = 1",
    "",
    "[license]",
    'spdxId = "NOASSERTION"',
    'usageRestriction = "restricted"',
    'restrictionSummary = "Review the selected server edition and analyzer terms."',
    'url = "https://www.sonarsource.com/legal/"',
    "",
    "[[secrets]]",
    'name = "token"',
    `envVar = ${quote(tokenEnvVar)}`,
    "required = true",
    'purpose = "Read existing project metrics; never saved in project configuration."',
    "",
    "[outputMapping]",
    'container = "component.measures"',
    'key = "metric"',
    'value = "value"',
    "",
    "[telemetry]",
    "sendsTelemetry = true",
    "disabledByDefault = false",
    "",
  ].join("\n");
}

function sonarItem(root: string, selection: IntegrationSelectionV1): IntegrationPlanItemV1 {
  const isLocal = selection.id === "sonarqube-local";
  const endpoint = safeEndpoint(selection.endpoint ?? "http://127.0.0.1:19000");
  if (isLocal && endpoint !== "http://127.0.0.1:19000") {
    throw new UsageError(
      "The local installation uses http://127.0.0.1:19000; select an existing server for another endpoint.",
    );
  }
  const tokenEnvVar = selection.tokenEnvVar ?? "UNTANGLE_EXT_SONAR_TOKEN";
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(tokenEnvVar)) {
    throw new UsageError("Enter an environment-variable NAME, not a token value.");
  }
  const key = selection.projectKey?.trim();
  const offer = OFFERS.find((candidate) => candidate.id === selection.id) as IntegrationOfferV1;
  const folder = `.untangle/setup/integrations/${selection.id}`;
  const files: IntegrationFileV1[] = [
    {
      relativePath: `${folder}/connection.json`,
      content: json({
        schemaVersion: 1,
        endpoint,
        projectKey: key,
        tokenEnvVar,
        remoteSourceFreshness: "not_verified",
        scannerRun: "not_started",
      }),
    },
  ];
  const commands: IntegrationCommandV1[] = [];
  let projectName: string | undefined;
  if (isLocal) {
    projectName = `untangle-init-sonar-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
    const composeFile = path.join(root, folder, "compose.yml");
    files.push({
      relativePath: `${folder}/compose.yml`,
      content: [
        "# Local evaluation server. Embedded H2 is not a production database.",
        "services:",
        "  quality:",
        `    image: ${SONAR_IMAGE}`,
        "    ports:",
        '      - "127.0.0.1:19000:9000"',
        "    privileged: false",
        "    cap_drop: [ALL]",
        "    security_opt: [no-new-privileges:true]",
        "    environment:",
        '      SONAR_TELEMETRY_ENABLE: "false"',
        "    labels:",
        '      dev.untangle.init-managed: "true"',
        `      dev.untangle.init-project: ${quote(projectName)}`,
        "    volumes:",
        "      - data:/opt/sonarqube/data",
        "      - logs:/opt/sonarqube/logs",
        "      - extensions:/opt/sonarqube/extensions",
        "volumes:",
        "  data: {}",
        "  logs: {}",
        "  extensions: {}",
        "",
      ].join("\n"),
    });
    commands.push({
      command: "docker",
      args: ["compose", "-p", projectName, "-f", composeFile, "up", "--detach"],
      kind: "process",
      purpose: "Download and start the pinned local evaluation server; no source is uploaded.",
    });
  }
  if (key !== undefined && key !== "") {
    const manifest = path.join(root, folder, "manifest.toml");
    files.push({
      relativePath: `${folder}/manifest.toml`,
      content: sonarManifest(endpoint, key, tokenEnvVar),
    });
    commands.push(
      {
        command: "untangle",
        args: [
          "extensions",
          "add",
          `--from=${manifest}`,
          "--allow-project-local",
          "--acknowledge-license",
        ],
        kind: "extension",
        purpose:
          "Import the explicitly selected generated manifest into the user extension profile.",
      },
      {
        command: "untangle",
        args: ["extensions", "enable", "sonarqube", "--acknowledge-license"],
        kind: "extension",
        purpose: "Enable the manifest; this does not run a scanner.",
      },
    );
    if (!isLocal) {
      commands.push({
        command: "untangle",
        args: [
          "extensions",
          "run",
          "sonarqube",
          `--workspace=${root}`,
          "--timeout=30000",
          "--max-output-bytes=4194304",
        ],
        kind: "extension",
        purpose:
          "Read and validate existing numeric project metrics using the configured token environment variable. This does not launch a scanner or verify remote source freshness.",
      });
    }
  }
  return {
    id: selection.id,
    label: offer.label,
    files,
    commands,
    downloads: [],
    licenseAcknowledged: selection.acknowledgeLicense === true,
    ...(projectName === undefined ? {} : { projectName }),
    blockers: selection.acknowledgeLicense === true ? [] : [offer.licenseSummary],
    nextSteps: [
      ...(isLocal
        ? [
            `Open ${endpoint}, finish account/password setup, create the selected project and run its scanner. This starts an evaluation server only.`,
          ]
        : []),
      ...(key === undefined || key === ""
        ? ["Supply a real project key to generate the metrics manifest."]
        : []),
      `Set ${tokenEnvVar} in your shell or private user credential store; never put its value in the project.`,
      "Run untangle extensions run sonarqube --format=json after a successful scanner run. Remote source freshness remains unverified.",
    ],
  };
}

function sentruxItem(root: string, platform: string, arch: string): IntegrationPlanItemV1 {
  const release = RELEASES[`${platform}:${arch}`];
  const relativeBinary = `.untangle/tools/sentrux/${SENTRUX_VERSION}/sentrux${platform === "win32" ? ".exe" : ""}`;
  const binary = path.join(root, relativeBinary);
  return {
    id: "sentrux",
    label: "Sentrux — project-local binary and MCP template",
    licenseAcknowledged: true,
    files: [
      {
        relativePath: ".untangle/setup/integrations/sentrux/mcp.json",
        content: json({ mcpServers: { sentrux: { command: binary, args: ["--mcp"] } } }),
      },
    ],
    commands: [
      {
        command: binary,
        args: ["--version"],
        kind: "process",
        purpose: "Verify the installed binary. No project scan or host configuration changes.",
      },
    ],
    downloads:
      release === undefined
        ? []
        : [
            {
              url: `https://github.com/sentrux/sentrux/releases/download/v${SENTRUX_VERSION}/${release.artifact}`,
              sha256: release.sha256,
              relativePath: relativeBinary,
              maxBytes: 64 * 1024 * 1024,
            },
          ],
    blockers:
      release === undefined
        ? [
            `No verified ${platform}/${arch} release is offered; use the official source-build instructions.`,
          ]
        : [],
    nextSteps: [
      "Explicitly add the generated MCP entry to your host, then use Sentrux's own scan/check tools. No normalized Untangle adapter is claimed.",
      "Review https://sentrux.dev/docs/installation/ before installing the pinned release.",
    ],
  };
}

function customItem(root: string, selection: IntegrationSelectionV1): IntegrationPlanItemV1 {
  const source = selection.manifestPath?.trim();
  if (source !== undefined && source.includes("://")) {
    const endpoint = safeEndpoint(source);
    if (!endpoint.startsWith("https://") || selection.manifestDigest === undefined) {
      throw new UsageError(
        "Remote manifests need HTTPS and an independently verified sha256 digest.",
      );
    }
  }
  if (
    selection.manifestDigest !== undefined &&
    !/^sha256:[a-f0-9]{64}$/u.test(selection.manifestDigest)
  ) {
    throw new UsageError("The manifest digest must be sha256:<64 lowercase hex>.");
  }
  const args =
    source === undefined || source === ""
      ? []
      : [
          "add",
          `--from=${source.includes("://") ? source : path.resolve(root, source)}`,
          ...(selection.manifestDigest === undefined
            ? []
            : [`--digest=${selection.manifestDigest}`]),
          ...(selection.allowProjectLocal === true ? ["--allow-project-local"] : []),
          ...(selection.acknowledgeLicense === true ? ["--acknowledge-license"] : []),
        ];
  return {
    id: "custom",
    label: "Other analyzer — trusted extension manifest",
    licenseAcknowledged: selection.acknowledgeLicense === true,
    files: [
      {
        relativePath: ".untangle/setup/integrations/custom/selection.json",
        content: json({
          schemaVersion: 1,
          manifestSource: source,
          expectedDigest: selection.manifestDigest,
          allowProjectLocal: selection.allowProjectLocal === true,
          formats: ["sarif", "junit-xml", "generic-findings", "generic-metrics"],
        }),
      },
    ],
    commands:
      args.length === 0
        ? []
        : [
            {
              command: "untangle",
              args: ["extensions", ...args],
              kind: "extension",
              purpose:
                "Import the explicit manifest through the existing trust, integrity and license gates. No analyzer is started.",
            },
          ],
    downloads: [],
    blockers:
      args.length === 0
        ? ["Supply a trusted analyzer manifest path or a digest-pinned HTTPS URL."]
        : [],
    nextSteps: [
      "Review the manifest, enable its declared ID, then run it explicitly. SARIF, JUnit XML and both generic JSON formats use the same runtime.",
      "A cloned project's manifest is never automatically discovered or trusted.",
    ],
  };
}

function localSearchItem(root: string): IntegrationPlanItemV1 {
  const projectName = `untangle-init-search-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
  const folder = ".untangle/setup/integrations/local-search";
  const compose = path.join(root, folder, "compose.yml");
  const common = [
    "    privileged: false",
    "    cap_drop: [ALL]",
    "    security_opt: [no-new-privileges:true]",
    "    labels:",
    '      dev.untangle.init-managed: "true"',
    `      dev.untangle.init-project: ${quote(projectName)}`,
  ];
  const health = (port: number): string[] => [
    "    healthcheck:",
    `      test: ["CMD-SHELL", "bash -c 'echo -n > /dev/tcp/127.0.0.1/${String(port)}'"]`,
    "      interval: 3s",
    "      timeout: 3s",
    "      retries: 40",
  ];
  return {
    id: "local-search",
    label: "Local search — Qdrant and Ollama",
    licenseAcknowledged: true,
    projectName,
    files: [
      {
        relativePath: `${folder}/compose.yml`,
        content: [
          "services:",
          "  vectors:",
          "    image: qdrant/qdrant@sha256:d774e7bb65744454984c6021637a0da89271f30df15e48601a9fafc926d26b1f",
          "    ports:",
          '      - "127.0.0.1:16333:6333"',
          '      - "127.0.0.1:16334:6334"',
          "    volumes:",
          "      - qdrant_data:/qdrant/storage",
          ...common,
          ...health(6333),
          "  embeddings:",
          "    image: ollama/ollama@sha256:18bfb1d605604fd53dcad20d0556df4c781e560ebebcd923454d627c994a0e37",
          "    ports:",
          '      - "127.0.0.1:11435:11434"',
          "    volumes:",
          "      - ollama_models:/root/.ollama",
          ...common,
          ...health(11434),
          "volumes:",
          "  qdrant_data: {}",
          "  ollama_models: {}",
          "",
        ].join("\n"),
      },
      {
        relativePath: `${folder}/connection.json`,
        content: json({
          schemaVersion: 1,
          qdrant: { mode: "external", url: "http://127.0.0.1:16333" },
          embeddings: {
            provider: "ollama",
            mode: "external",
            url: "http://127.0.0.1:11435",
            model: "nomic-embed-text",
            dimensions: 768,
            contextLength: 2048,
          },
          indexBuilt: false,
        }),
      },
    ],
    commands: [
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          projectName,
          "-f",
          compose,
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          "180",
        ],
        kind: "process",
        purpose:
          "Download and start the pinned loopback-only services; an occupied port fails without adopting a foreign container.",
      },
      {
        command: "docker",
        args: [
          "compose",
          "-p",
          projectName,
          "-f",
          compose,
          "exec",
          "-T",
          "embeddings",
          "ollama",
          "pull",
          "nomic-embed-text",
        ],
        kind: "process",
        purpose:
          "Explicitly download the configured default model into this setup's own named volume.",
      },
    ],
    downloads: [],
    blockers: [],
    nextSteps: [
      "Use Qdrant http://127.0.0.1:16333 and Ollama http://127.0.0.1:11435 with nomic-embed-text/768/2048 in the project configuration.",
      "Run untangle doctor, untangle index and a query with --require-fresh. Setup does not claim a fresh index.",
      "If a configured service already occupies these ports, reuse it explicitly rather than stopping it; no existing service or volume is deleted.",
    ],
  };
}

/** Planning is deterministic and performs no filesystem, process or network operation. */
export function planIntegrationSetup(options: IntegrationSetupOptionsV1): IntegrationSetupPlanV1 {
  const root = path.resolve(options.root);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const selections = options.selections.map((selection) => ({ ...selection }));
  const ids = selections.map((selection) => selection.id);
  if (
    new Set(ids).size !== ids.length ||
    (ids.includes("sonarqube-local") && ids.includes("sonarqube-existing"))
  ) {
    throw new UsageError("Select each integration once and only one SonarQube mode.");
  }
  for (const id of ids) {
    if (!OFFERS.some((offer) => offer.id === id))
      throw new UsageError("Unknown integration selection.");
  }
  return {
    schemaVersion: 1,
    root,
    selections,
    offline: options.offline ?? false,
    platform,
    arch,
    items: selections.map((selection) =>
      selection.id === "local-search"
        ? localSearchItem(root)
        : selection.id === "sentrux"
          ? sentruxItem(root, platform, arch)
          : selection.id === "custom"
            ? customItem(root, selection)
            : sonarItem(root, selection),
    ),
  };
}
