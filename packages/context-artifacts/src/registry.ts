/**
 * `ArtifactAdapterRegistry` (architecture.md §20) — a composite
 * `ArtifactAdapter` that dispatches to the right concrete format adapter
 * and NEVER fails to produce a result: the generic text-fallback adapter
 * is always registered last as a catch-all, so `read()`/`chunk()` always
 * succeed for every file (spec.md §19.2's "sicherer Text-Fallback";
 * rule 4 / BUILD_PLAN §12 E4 — nothing is silently unindexable).
 *
 * Dispatch order (auto-detection priority, see each adapter's own
 * `supports()` for its exact rule):
 *
 * 1. OpenAPI / AsyncAPI  — filename-hint + yaml/json extension
 * 2. Docker / Compose    — `Dockerfile*` / `(docker-)compose.y*ml` filename
 * 3. Kubernetes          — any other `.yaml`/`.yml`
 * 4. Markdown, SQL, Protobuf, Terraform — unambiguous extensions
 * 5. Text fallback       — catch-all
 *
 * `chunk()`/`links()` reuse the SAME per-adapter `supports()` rule, called
 * with `(document.type, document.path)` instead of the config's declared
 * type — every non-"text" `ArtifactDocument.type` is itself one adapter's
 * own literal (`"sql"`, `"openapi"`, …), so this always resolves
 * correctly without needing a second identity mechanism; the Docker
 * adapter's `supports()` additionally recognizes `type === "text"` for
 * exactly this reason (its documents carry type `"text"`, see `docker.ts`).
 */
import type {
  ArtifactAdapter,
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ArtifactLink,
  PortCallOptions,
} from "@untangle-code/domain";
import { jobCancelledError } from "@untangle-code/observability";

import { createAsyncApiAdapter } from "./adapters/asyncapi.js";
import { createDockerAdapter } from "./adapters/docker.js";
import { createKubernetesAdapter } from "./adapters/kubernetes.js";
import { createMarkdownAdapter } from "./adapters/markdown.js";
import { createOpenApiAdapter } from "./adapters/openapi.js";
import { createProtobufAdapter } from "./adapters/protobuf.js";
import type { SkipLedgerReporter } from "./adapters/shared.js";
import { createSqlAdapter } from "./adapters/sql.js";
import { createTerraformAdapter } from "./adapters/terraform.js";
import { createTextFallbackAdapter } from "./adapters/text.js";

export interface ArtifactAdapterRegistry extends ArtifactAdapter {
  /** Registers an additional adapter with LOWER priority than every built-in one (inserted just before the text fallback). */
  register(adapter: ArtifactAdapter): void;
  listAdapters(): readonly ArtifactAdapter[];
}

type ArtifactFile = ArtifactInput["files"][number];

class DefaultArtifactAdapterRegistry implements ArtifactAdapterRegistry {
  private readonly textFallback: ArtifactAdapter;
  private adapters: ArtifactAdapter[];

  constructor(builtins: ArtifactAdapter[], textFallback: ArtifactAdapter) {
    this.textFallback = textFallback;
    this.adapters = [...builtins, textFallback];
  }

  register(adapter: ArtifactAdapter): void {
    // Keep the text fallback last no matter when custom adapters are added.
    const withoutFallback = this.adapters.filter((existing) => existing !== this.textFallback);
    this.adapters = [...withoutFallback, adapter, this.textFallback];
  }

  listAdapters(): readonly ArtifactAdapter[] {
    return [...this.adapters];
  }

  supports(type: string, path: string): boolean {
    return this.adapters.some((adapter) => adapter.supports(type, path));
  }

  private resolve(type: string, path: string): ArtifactAdapter {
    return this.adapters.find((adapter) => adapter.supports(type, path)) ?? this.textFallback;
  }

  async read(input: ArtifactInput, options?: PortCallOptions): Promise<ArtifactDocument[]> {
    const declaredType = input.config.type ?? "auto";
    const groups = new Map<ArtifactAdapter, ArtifactFile[]>();
    for (const file of input.files) {
      if (options?.signal?.aborted) {
        throw jobCancelledError(`context artifact "${input.config.name}" read was aborted`, {
          operation: "context_artifact_read",
          context: { artifactName: input.config.name },
        });
      }
      const adapter = this.resolve(declaredType, file.path);
      const existing = groups.get(adapter);
      if (existing) {
        existing.push(file);
      } else {
        groups.set(adapter, [file]);
      }
    }

    const documents: ArtifactDocument[] = [];
    for (const [adapter, files] of groups) {
      const group = await adapter.read({ config: input.config, files }, options);
      documents.push(...group);
    }
    return documents;
  }

  chunk(document: ArtifactDocument): ArtifactChunk[] {
    return this.resolve(document.type, document.path).chunk(document);
  }

  links(document: ArtifactDocument): ArtifactLink[] {
    const adapter = this.resolve(document.type, document.path);
    return adapter.links?.(document) ?? [];
  }
}

export interface ArtifactAdapterRegistryOptions {
  /**
   * BUILD_PLAN §12 E4: overrides how every BUILT-IN adapter's `chunk()`
   * surfaces a real skip-ledger finding (default: one stderr warning line
   * per finding — see `coverage.ts`'s `defaultSkipLedgerReporter`). Wire in
   * a real structured logger here once, instead of passing the same
   * `onSkipLedgerGap` to every individual `create*Adapter()` call. Does
   * NOT apply to `extra` adapters — those are already fully constructed
   * `ArtifactAdapter`s by the time they reach this factory.
   */
  onSkipLedgerGap?: SkipLedgerReporter;
}

/**
 * Builds a registry with every built-in format adapter registered
 * (priority order per this module's doc comment), plus any `extra`
 * adapters appended just before the text fallback.
 */
export function createArtifactAdapterRegistry(
  extra: ArtifactAdapter[] = [],
  options: ArtifactAdapterRegistryOptions = {},
): ArtifactAdapterRegistry {
  const adapterOptions =
    options.onSkipLedgerGap === undefined ? {} : { onSkipLedgerGap: options.onSkipLedgerGap };
  const builtins: ArtifactAdapter[] = [
    createOpenApiAdapter(adapterOptions),
    createAsyncApiAdapter(adapterOptions),
    createDockerAdapter(adapterOptions),
    createKubernetesAdapter(adapterOptions),
    createMarkdownAdapter(adapterOptions),
    createSqlAdapter(adapterOptions),
    createProtobufAdapter(adapterOptions),
    createTerraformAdapter(adapterOptions),
    ...extra,
  ];
  return new DefaultArtifactAdapterRegistry(builtins, createTextFallbackAdapter(adapterOptions));
}
