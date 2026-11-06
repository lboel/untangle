# Guided setup and analyzers

`untangle init --interactive` adds guided setup to the existing noninteractive entry point.
Before execution it shows target paths, downloads, argument arrays, license notices and
next steps. Only explicit installation confirmation starts processes or downloads. Offline
setup prepares local files only; an unavailable service is never reported as installed.

Project templates and immutable results live under `.untangle/setup/integrations/`, and
an offered local binary under `.untangle/tools/`. Existing files with different content
and symlink paths are not overwritten. Cancellation records a partial receipt where the
metadata path can be written safely and propagates the abort. Already started owned
services are not silently deleted.

## Search storage

New projects default to embedded LanceDB under `.untangle/index/lancedb`. The TUI asks where
the index should live before offering analyzers. `init --storage=lancedb` or
`init --storage=qdrant` sets the backend in scriptable setup. Existing explicit storage and
legacy Qdrant selections are preserved. Init and doctor do not create database tables.

With LanceDB, the Qdrant/Ollama Compose offer is hidden. Symbol and lexical search can use
`index --embedder=offline`; language-model semantics require a separately configured embedder.
For service-backed search, select an owned or external Qdrant service. Switching storage
requires indexing that backend; old databases are preserved and never silently migrated.

## Offers

| Selection | Actual effect | Remaining step |
|---|---|---|
| Qdrant local search | Owned Compose recipe with digest-pinned Qdrant 1.12.1 and Ollama 0.5.4; optionally start and pull `nomic-embed-text`. | `doctor`, indexing and a real query; no index is claimed. |
| Local SonarQube | Digest-pinned Community evaluation server, loopback port 19000, owned volumes, telemetry disabled. | Account/password, project, scanner and token setup. |
| Existing SonarQube | Generate a declared HTTP manifest for prior project metrics, explicitly import/enable it and attempt an actual numeric read. | Missing credentials/analysis remain `needs_configuration`; remote source freshness is unverified. |
| Sentrux | Install hash-verified release binary 0.5.7 locally, check `--version`, save an MCP template. | Explicitly import the entry in your agent host; this is a separate MCP service, not a normalized Untangle adapter. |
| Other analyzers | Import an explicitly reviewed external manifest through the existing extension command. | Enable the ID, acknowledge applicable licenses/rules, then execute explicitly. |

The two Sonar modes are mutually exclusive in a single setup selection. The Qdrant recipe binds
only to `127.0.0.1`: Qdrant 16333/16334, Ollama 11435. An occupied port is no reason to stop
or take over a foreign service. The default model profile is `nomic-embed-text`, 768 dimensions,
context 2048; the pinned older Ollama image is not configured with an incompatible Qwen3 model.

The local SonarQube server uses its embedded evaluation database, not a production deployment.
Sonar's small-installation starting point is 4 GB RAM and two cores. Untangle changes no host
sysctl settings, accounts or passwords. Check actual host requirements before starting:
[official host requirements](https://docs.sonarsource.com/sonarqube-community-build/server-installation/server-host-requirements),
[Docker image/license notices](https://hub.docker.com/_/sonarqube/),
[telemetry property](https://docs.sonarsource.com/sonarqube-server/server-installation/system-properties/common-properties).

Sentrux uses individually pinned assets with checked SHA-256, never a downloaded installation
script. Assets cover macOS ARM64, Linux ARM64/x64 and Windows x64; other platforms receive
an official-installation pointer. The MCP template launches `sentrux --mcp`. A passing version
command does not prove a successful project scan.
[Release 0.5.7](https://github.com/sentrux/sentrux/releases/tag/v0.5.7),
[installation](https://sentrux.dev/docs/installation/),
[MCP documentation](https://sentrux.dev/docs/mcp/).

## Shared boundary

The catalog offers tools; the extension runtime remains format-based. Untangle bundles no
analyzer libraries or third-party analyzer sources. A Sonar manifest is generated only from
the user's explicit selection and uses the existing generic HTTP/JSON boundary. External
measurements remain external evidence and replace neither Untangle metrics nor feature or
ownership evidence.

SARIF, JUnit XML, `generic-findings` and `generic-metrics` share the same manifest/process
boundary. Project manifests are not automatically discovered or trusted. Project-local
import requires explicit `allow-project-local`; remote manifests need HTTPS and an independently
checked digest. Personal license acknowledgments and credentials stay in the user profile.
Project metadata stores only the **name** of the token environment variable, never its value.

An imported manifest is not a successful analyzer run. An existing Sonar connection succeeds
only after an actual valid numeric read, which still does not prove that its remote analysis
matches the current local sources.

## Specs and the feature map

[SDD connectors](./SDD_CONNECTORS.md) read supported local Spec Kit/OpenSpec artifacts and
prepare review drafts independently of analyzer installation. Framework scripts are not run.
A map is an English-control, offline 3D view over current declared feature/code/test/ownership
relationships. Reports retain their full measurement scopes; the rendered graph is capped
explicitly. Project text stays unchanged. Neither rotation nor embedding similarity proves
semantic conformance.
