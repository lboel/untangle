import type {
  HttpBoundaryFileFactsV1,
  HttpBoundaryProvenanceV1,
  HttpEndpointV1,
  HttpRouterFactV1,
  HttpServiceBindingV1,
} from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";

export function under(path: string, root: string): boolean {
  const normalized = root.replace(/\/$/, "");
  return normalized === "" || path === normalized || path.startsWith(`${normalized}/`);
}

export function provenance(
  file: HttpBoundaryFileFactsV1,
  range: HttpBoundaryProvenanceV1["range"],
  kind: HttpBoundaryProvenanceV1["kind"],
  name?: string,
): HttpBoundaryProvenanceV1 {
  return {
    path: file.path,
    contentHash: file.contentHash,
    range,
    kind,
    ...(name === undefined ? {} : { name }),
  };
}

interface RouterRef {
  file: HttpBoundaryFileFactsV1;
  router: HttpRouterFactV1;
}

function key(ref: RouterRef): string {
  return `${ref.file.path}:${ref.router.scope}:${ref.router.name}`;
}

function enclosingScopes(file: HttpBoundaryFileFactsV1, scope: string): string[] {
  const result = [scope];
  let current = scope;
  for (let depth = 0; depth < 30 && current !== "module"; depth += 1) {
    current = file.functions.find((fn) => fn.scope === current)?.parentScope ?? "module";
    result.push(current);
  }
  return result;
}

function localRouter(file: HttpBoundaryFileFactsV1, name: string, scope: string): RouterRef | null {
  for (const candidateScope of enclosingScopes(file, scope)) {
    const candidates = file.routers.filter(
      (router) => router.name === name && router.scope === candidateScope,
    );
    const bindings = file.bindings.filter(
      (binding) => binding.scope === candidateScope && binding.name === name,
    );
    const fn = file.functions.find((fn) => fn.scope === candidateScope);
    if (bindings.length > 1 || fn?.parameters.some((param) => param.name === name)) return null;
    if (bindings.length > 0 && candidates.length === 0) return null;
    if (candidates.length === 1) return { file, router: candidates[0] as HttpRouterFactV1 };
    if (candidates.length > 1) return null;
  }
  return null;
}

function importedModulePath(from: string, module: string): string {
  if (!module.startsWith(".")) return module.replaceAll(".", "/");
  const dots = module.match(/^\.+/)?.[0].length ?? 0;
  const dirs = from.split("/").slice(0, -dots);
  return [...dirs, module.slice(dots).replaceAll(".", "/")].filter(Boolean).join("/");
}

function includedRouter(
  files: readonly HttpBoundaryFileFactsV1[],
  file: HttpBoundaryFileFactsV1,
  name: string,
  scope: string,
): RouterRef | null {
  const local = localRouter(file, name, scope);
  if (local !== null) return local;
  const segments = name.split(".");
  const base = segments[0];
  if (
    enclosingScopes(file, scope).some(
      (candidateScope) =>
        file.functions
          .find((fn) => fn.scope === candidateScope)
          ?.parameters.some((parameter) => parameter.name === base) ||
        file.bindings.some(
          (binding) => binding.scope === candidateScope && binding.name === base,
        ) ||
        file.functions.some((fn) => fn.parentScope === candidateScope && fn.name === base),
    )
  )
    return null;
  const imported = file.pythonImports.filter((item) => item.local === base);
  if (imported.length !== 1) return null;
  const item = imported[0];
  if (item === undefined) return null;
  const directRouter = segments.length === 1;
  const module = directRouter ? item.module : `${item.module}.${item.imported ?? item.local}`;
  const modulePath = importedModulePath(file.path, module);
  const candidates = files.filter(
    (candidate) =>
      candidate.path === `${modulePath}.py` || candidate.path.endsWith(`/${modulePath}.py`),
  );
  if (candidates.length !== 1) return null;
  const target = candidates[0];
  return target === undefined
    ? null
    : localRouter(
        target,
        directRouter ? (item.imported ?? "router") : segments.slice(1).join("."),
        "module",
      );
}

function routePath(...parts: (string | null)[]): string | null {
  if (parts.some((part) => part === null)) return null;
  const result = parts.join("");
  if (
    !result.startsWith("/") ||
    result.includes("//") ||
    result.includes("?") ||
    result.includes("#")
  )
    return null;
  return result;
}

export function collectEndpoints(
  files: readonly HttpBoundaryFileFactsV1[],
  services: readonly HttpServiceBindingV1[],
  signal?: AbortSignal,
): { endpoints: HttpEndpointV1[]; limitations: { path: string; reason: string }[] } {
  const endpoints: HttpEndpointV1[] = [],
    limitations: { path: string; reason: string }[] = [];
  const mounted = new Set<string>();
  let visits = 0;
  const visit = (
    ref: RouterRef,
    prefix: string | null,
    chain: HttpBoundaryProvenanceV1[],
    seen: Set<string>,
    serviceId: string | null,
  ): void => {
    if (signal?.aborted)
      throw new UntangleError("JOB_CANCELLED", "HTTP endpoint collection cancelled");
    visits += 1;
    if (visits > 10000 || endpoints.length > 20000)
      throw new UntangleError("ANALYSIS_INCOMPLETE", "HTTP router expansion budget exceeded");
    if (seen.size >= 100) {
      limitations.push({ path: ref.file.path, reason: "Router include depth budget exceeded" });
      return;
    }
    if (seen.has(key(ref))) {
      limitations.push({
        path: ref.file.path,
        reason: `Router include cycle at ${ref.router.name}`,
      });
      return;
    }
    mounted.add(key(ref));
    const nextSeen = new Set([...seen, key(ref)]);
    const routerPrefix = routePath(prefix, ref.router.prefix);
    const nextPrefix = prefix === "" && ref.router.prefix === "" ? "" : routerPrefix;
    const provenanceChain = [
      ...chain,
      provenance(ref.file, ref.router.range, "router", ref.router.name),
    ];
    for (const route of ref.file.routes.filter(
      (route) =>
        route.router === ref.router.name &&
        localRouter(ref.file, route.router, route.scope)?.router === ref.router,
    )) {
      const path = routePath(nextPrefix, route.path);
      if (path === null)
        limitations.push({
          path: ref.file.path,
          reason: `Dynamic or invalid route prefix/path for ${route.handler}`,
        });
      else {
        if (/\{[^}]+:(?!str\})[^}]+\}/.test(path))
          limitations.push({
            path: ref.file.path,
            reason: `Typed or catch-all route converters are not matched: ${path}`,
          });
        endpoints.push({
          serviceId,
          method: route.method,
          path,
          handler: route.handler,
          provenance: [
            ...provenanceChain,
            provenance(ref.file, route.range, "route", route.handler),
          ],
        });
      }
    }
    for (const include of ref.file.includes.filter(
      (include) => localRouter(ref.file, include.owner, include.scope)?.router === ref.router,
    )) {
      const target = includedRouter(files, ref.file, include.router, include.scope);
      if (target === null) {
        limitations.push({
          path: ref.file.path,
          reason: `Unresolved router include ${include.router}`,
        });
        continue;
      }
      if (
        serviceId !== null &&
        !services.some(
          (service) =>
            service.id === serviceId &&
            service.backendRoots.some((root) => under(target.file.path, root)),
        )
      ) {
        limitations.push({
          path: ref.file.path,
          reason: `Router include ${include.router} lies outside declared backend roots`,
        });
        continue;
      }
      const includePrefix =
        nextPrefix === "" && include.prefix === "" ? "" : routePath(nextPrefix, include.prefix);
      visit(
        target,
        includePrefix,
        [...provenanceChain, provenance(ref.file, include.range, "include", include.router)],
        nextSeen,
        serviceId,
      );
    }
  };
  for (const file of files) {
    const unsafeMounts = files.filter((candidate) =>
      candidate.limitations.some((reason) => reason.startsWith("ASGI app.mount")),
    );
    const unsafeService = unsafeMounts.some(
      (unsafe) =>
        services.length === 0 ||
        services.some(
          (service) =>
            service.backendRoots.some((root) => under(file.path, root)) &&
            service.backendRoots.some((root) => under(unsafe.path, root)),
        ),
    );
    if (unsafeService) {
      limitations.push({
        path: file.path,
        reason: "App endpoint inventory suppressed because ASGI mount routing is unsupported",
      });
      continue;
    }
    for (const router of file.routers.filter((router) => router.kind === "app")) {
      const matching = services.filter((service) =>
        service.backendRoots.some((root) => under(file.path, root)),
      );
      for (const service of matching.length > 0 ? matching : [null])
        visit({ file, router }, "", [], new Set(), service?.id ?? null);
    }
  }
  for (const file of files)
    for (const router of file.routers) {
      if (router.kind === "router" && !mounted.has(key({ file, router })))
        limitations.push({
          path: file.path,
          reason: `Router ${router.name} is not proven mounted on a FastAPI app`,
        });
    }
  return { endpoints, limitations };
}
