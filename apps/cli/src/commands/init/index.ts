/**
 * `untangle init` (WP-125) — the only public surface of this command.
 *
 * WHAT THE CLI SHELL NEEDS FROM HERE: `initCommand`, a `Command` in the sense
 * of `src/cli/command.ts`. Registering it is the whole integration:
 *
 *     import { initCommand } from "./commands/init/index.js";
 *
 * Everything else exported here is for tests and for other commands that want
 * the DETECTION without the terminal — `runInit` returns the full
 * `InitResultV1` (findings, rendered file, diff, next step) and writes
 * nothing when `dryRun` is set. `untangle doctor` in particular should reuse
 * `probeOllama`/`probeQdrant` rather than growing its own probes.
 */

export { createInitCommand, initCommand, initOptionsFrom } from "./command.js";
export { CONFIG_FILE_NAME, decideOutcome, qdrantProbeList, runInit } from "./run.js";
export type { InitDepsV1, InitOptionsV1 } from "./run.js";
export { formatTextReport } from "./report.js";
export { renderUntangleToml } from "./render.js";
export { buildConfigDraft, deriveProjectId, nextStepFor } from "./config-draft.js";
export { buildLanguageCensus, countLines } from "./languages.js";
export { detectTopology } from "./topology.js";
export { assessProductContext } from "./product-context.js";
export type { AssessProductContextInputV1, ProductContextAssessmentV1 } from "./product-context.js";
export { detectIgnoreRules, DEFAULT_PROJECT_EXCLUDES } from "./ignore-rules.js";
export {
  DEFAULT_OLLAMA_URL,
  DEFAULT_QDRANT_URL,
  chooseEmbeddingModel,
  probeOllama,
  probeQdrant,
  readEmbeddingModels,
} from "./services.js";
export { nodeHttpProbe, offlineProbe } from "./http-probe.js";
// WP-222: die Regel, welcher Vektorspeicher benutzt werden darf, steht an
// EINER Stelle und wird von `init` wie von `doctor` benutzt.
export {
  FOREIGN_DEFAULT_QDRANT_URLS,
  MANAGED_QDRANT_URL,
  decideVectorStore,
  qdrantProbePlan,
} from "../../cli/vector-store-policy.js";
export { diffLines, toLines } from "./diff.js";
export { TomlWriter } from "./toml.js";
export { DEFAULT_INIT_LIMITS } from "./types.js";
export type {
  ConfigChangeV1,
  DetectedPackageV1,
  DetectedServiceV1,
  HttpProbePort,
  IgnoreFindingsV1,
  InitLimitsV1,
  InitOutcome,
  InitResultV1,
  LanguageCensusEntryV1,
  LanguageCensusV1,
  OllamaFindingsV1,
  ProjectFindingsV1,
  QdrantFindingsV1,
  StorageFindingsV1,
  TopologyFindingsV1,
} from "./types.js";
