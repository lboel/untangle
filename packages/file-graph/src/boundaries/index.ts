import type {
  HttpBoundaryFileFactsV1,
  HttpBoundaryReportV1,
  HttpBoundaryRequestV1,
  HttpEndpointV1,
  HttpServiceBindingV1,
} from "@untangle-code/domain";
import { compareCodepoints, UntangleError } from "@untangle-code/domain";

import { collectEndpoints, under } from "./endpoints.js";
import { collectRequests } from "./requests.js";

export interface AnalyzeHttpBoundariesOptions {
  files: readonly HttpBoundaryFileFactsV1[];
  services: readonly HttpServiceBindingV1[];
  signal?: AbortSignal;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UntangleError("JOB_CANCELLED", "HTTP boundary analysis cancelled");
}

function matchesPath(request: string, route: string): boolean {
  const requested = request.split("/"),
    target = route.split("/");
  if (requested.length !== target.length) return false;
  return target.every((segment, index) => {
    const value = requested[index] ?? "";
    if (/^\{[A-Za-z_][A-Za-z0-9_]*(?::str)?\}$/.test(segment)) return value !== "";
    return segment === value && value !== "{*}";
  });
}

function serviceApplies(
  request: { origin: string | null },
  service: HttpServiceBindingV1,
): boolean {
  return request.origin === null
    ? service.sameOrigin === true
    : (service.origins ?? []).some((origin) => {
        try {
          return new URL(origin).origin === request.origin && new URL(origin).pathname === "/";
        } catch {
          return false;
        }
      });
}

/** Resolve declared deployment scopes plus method/path evidence, never bare URL coincidences. */
export function analyzeHttpBoundaries(options: AnalyzeHttpBoundariesOptions): HttpBoundaryReportV1 {
  checkCancelled(options.signal);
  const files = [...options.files].sort((a, b) => compareCodepoints(a.path, b.path));
  const services = [...options.services].sort((a, b) => compareCodepoints(a.id, b.id));
  if (new Set(services.map((service) => service.id)).size !== services.length)
    throw new TypeError("HTTP service identifiers must be unique");
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new TypeError("HTTP source paths must be unique");
  const { endpoints, limitations } = collectEndpoints(files, services, options.signal);
  const requests: HttpBoundaryRequestV1[] = [];
  for (const file of files) {
    checkCancelled(options.signal);
    limitations.push(...file.limitations.map((reason) => ({ path: file.path, reason })));
    if (file.languageId === "python") continue;
    for (const request of collectRequests(file)) {
      checkCancelled(options.signal);
      const applicable = services.filter(
        (service) =>
          service.frontendRoots.some((root) => under(file.path, root)) &&
          serviceApplies(request, service),
      );
      const serviceIds = applicable.map((service) => service.id);
      const targets: HttpEndpointV1[] =
        request.reason === undefined && request.path !== null && request.method !== null
          ? endpoints.filter(
              (endpoint) =>
                endpoint.serviceId !== null &&
                serviceIds.includes(endpoint.serviceId) &&
                endpoint.method === request.method &&
                matchesPath(request.path as string, endpoint.path),
            )
          : [];
      const status =
        targets.length === 1 ? "resolved" : targets.length > 1 ? "ambiguous" : "unresolved";
      const reason =
        request.reason ??
        (applicable.length === 0
          ? "No declared service binding for the request origin and frontend root"
          : targets.length === 0
            ? "No mounted route matches the HTTP method and normalized path"
            : targets.length > 1
              ? "Multiple mounted routes match; no target was selected"
              : undefined);
      requests.push({
        ...request,
        status,
        ...(reason === undefined ? {} : { reason }),
        serviceIds,
        targets,
      });
    }
  }
  return {
    schemaVersion: 1,
    kind: "http-boundaries",
    services,
    endpoints,
    requests,
    limitations,
    summary: {
      files: files.length,
      endpoints: endpoints.length,
      requests: requests.length,
      resolved: requests.filter((request) => request.status === "resolved").length,
      ambiguous: requests.filter((request) => request.status === "ambiguous").length,
      unresolved: requests.filter((request) => request.status === "unresolved").length,
    },
  };
}
