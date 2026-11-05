import type {
  HttpBoundaryFileFactsV1,
  HttpBoundaryProvenanceV1,
  HttpCallFactV1,
  HttpExpressionV1,
  HttpFunctionFactV1,
} from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";

import { provenance } from "./endpoints.js";

type Expression = HttpExpressionV1;
type Environment = ReadonlyMap<string, Expression>;
const UNKNOWN: Expression = { kind: "unknown", detail: "unbound value" };
const UNDEFINED: Expression = { kind: "undefined" };
const DYNAMIC = "«dynamic»";
const ENCODED_SEGMENT = "«encoded-segment»";

interface Context {
  file: HttpBoundaryFileFactsV1;
  scope: string;
  env: Environment;
}

function functionAt(file: HttpBoundaryFileFactsV1, scope: string): HttpFunctionFactV1 | undefined {
  return file.functions.find((fn) => fn.scope === scope);
}

function referencesName(expr: Expression, name: string, depth = 0): boolean {
  if (depth > 40) return true;
  if (expr.kind === "name") return expr.name === name;
  if (expr.kind === "template")
    return expr.parts.some(
      (part) => typeof part !== "string" && referencesName(part, name, depth + 1),
    );
  if (expr.kind === "object")
    return expr.entries.some((entry) =>
      referencesName("spread" in entry ? entry.spread : entry.value, name, depth + 1),
    );
  if (expr.kind === "member") return referencesName(expr.object, name, depth + 1);
  if (expr.kind === "call")
    return expr.arguments.some((arg) => referencesName(arg, name, depth + 1));
  return false;
}

/** Fail closed when an options object can escape to code whose writes are unknown. */
function objectEscapes(name: string, context: Context, seen = new Set<string>()): boolean {
  const location = `${context.scope}:${name}`;
  if (seen.has(location) || seen.size >= 12) return true;
  const next = new Set([...seen, location]);
  if (
    context.file.bindings.some(
      (binding) =>
        binding.scope === context.scope &&
        binding.name !== name &&
        referencesName(binding.value, name),
    )
  )
    return true;
  if (
    context.file.bindings.some(
      (binding) =>
        binding.scope === context.scope &&
        binding.name === name &&
        binding.value.kind === "unknown" &&
        binding.value.detail === "reassigned binding",
    )
  )
    return true;
  for (const call of context.file.calls.filter((call) => call.scope === context.scope)) {
    for (let index = 0; index < call.arguments.length; index += 1) {
      const argument = call.arguments[index];
      if (argument?.kind !== "name" || argument.name !== name) continue;
      if (transportName(context.file, call)) continue;
      const target = localFunction(context.file, call);
      const parameter = target?.parameters[index];
      if (
        target === null ||
        target === undefined ||
        parameter === undefined ||
        objectEscapes(parameter.name, { ...context, scope: target.scope, env: new Map() }, next)
      )
        return true;
    }
  }
  return false;
}

function resolveName(name: string, context: Context, seen: Set<string>, depth: number): Expression {
  const lookup = `${context.scope}:${name}`;
  if (seen.has(lookup)) return UNKNOWN;
  const next = new Set([...seen, lookup]);
  const binding = context.file.bindings.filter(
    (item) => item.scope === context.scope && item.name === name,
  );
  if (binding.length > 1) return { kind: "unknown", detail: "multiple or reassigned bindings" };
  if (binding.length === 1 && binding[0]?.value.kind === "object" && objectEscapes(name, context))
    return { kind: "unknown", detail: "object binding escapes static transport analysis" };
  if (binding.length === 1)
    return resolveExpression(
      (binding[0] as (typeof binding)[number]).value,
      context,
      next,
      depth + 1,
    );
  const envValue = context.env.get(name);
  if (envValue !== undefined)
    return envValue.kind === "object" && objectEscapes(name, context)
      ? { kind: "unknown", detail: "object parameter escapes static transport analysis" }
      : envValue;
  const fn = functionAt(context.file, context.scope);
  if (fn?.parameters.some((param) => param.name === name)) return UNKNOWN;
  if (context.scope !== "module")
    return resolveName(
      name,
      { ...context, scope: fn?.parentScope ?? "module", env: new Map() },
      next,
      depth + 1,
    );
  return { kind: "name", name };
}

function resolveExpression(
  expr: Expression,
  context: Context,
  seen = new Set<string>(),
  depth = 0,
): Expression {
  if (depth > 40) return UNKNOWN;
  if (expr.kind === "name") return resolveName(expr.name, context, seen, depth);
  const resolve = (value: Expression) => resolveExpression(value, context, seen, depth + 1);
  if (expr.kind === "template")
    return {
      kind: "template",
      parts: expr.parts.map((part) => (typeof part === "string" ? part : resolve(part))),
    };
  if (expr.kind === "object")
    return {
      kind: "object",
      entries: expr.entries.map((entry) =>
        "spread" in entry
          ? { spread: resolve(entry.spread) }
          : { key: entry.key, value: resolve(entry.value) },
      ),
    };
  if (expr.kind === "member") return { ...expr, object: resolve(expr.object) };
  if (expr.kind === "call") {
    if (expr.callee.kind === "name" && expr.callee.name === "encodeURIComponent") {
      const shadowed =
        scopeChain(context.file, context.scope).some(
          (scope) =>
            context.file.bindings.some(
              (binding) => binding.scope === scope && binding.name === "encodeURIComponent",
            ) ||
            functionAt(context.file, scope)?.parameters.some(
              (param) => param.name === "encodeURIComponent",
            ) ||
            context.file.functions.some(
              (fn) => fn.parentScope === scope && fn.name === "encodeURIComponent",
            ),
        ) || context.file.imports.some((raw) => raw.importedNames?.includes("encodeURIComponent"));
      if (shadowed) return UNKNOWN;
    }
    return { ...expr, arguments: expr.arguments.map(resolve) };
  }
  return expr;
}

function scopeChain(file: HttpBoundaryFileFactsV1, scope: string): string[] {
  const result = [scope];
  for (let depth = 0; depth < 30 && scope !== "module"; depth += 1) {
    scope = functionAt(file, scope)?.parentScope ?? "module";
    result.push(scope);
  }
  return result;
}

function transportName(file: HttpBoundaryFileFactsV1, call: HttpCallFactV1): boolean {
  if (call.callee.kind !== "name") return false;
  const name = call.callee.name;
  for (const scope of scopeChain(file, call.scope)) {
    if (file.bindings.some((binding) => binding.scope === scope && binding.name === name))
      return false;
    const fn = functionAt(file, scope);
    const parameter = fn?.parameters.find((param) => param.name === name);
    if (parameter !== undefined) return parameter.fetchTransport === true;
    if (
      file.functions.some((candidate) => candidate.parentScope === scope && candidate.name === name)
    )
      return false;
    if (file.imports.some((raw) => raw.importedNames?.includes(name))) return false;
  }
  return name === "fetch";
}

function localFunction(
  file: HttpBoundaryFileFactsV1,
  call: HttpCallFactV1,
): HttpFunctionFactV1 | null {
  if (call.callee.kind !== "name") return null;
  const name = call.callee.name;
  for (const scope of scopeChain(file, call.scope)) {
    const candidates = file.functions.filter((fn) => fn.parentScope === scope && fn.name === name);
    if (candidates.length === 1) return candidates[0] as HttpFunctionFactV1;
    if (
      candidates.length > 1 ||
      file.bindings.some((binding) => binding.scope === scope && binding.name === name)
    )
      return null;
  }
  return null;
}

function render(expr: Expression): string {
  if (expr.kind === "string")
    return expr.value.includes(DYNAMIC) || expr.value.includes(ENCODED_SEGMENT)
      ? DYNAMIC
      : expr.value;
  if (expr.kind === "template")
    return expr.parts.map((part) => (typeof part === "string" ? part : render(part))).join("");
  if (
    expr.kind === "call" &&
    expr.callee.kind === "name" &&
    expr.callee.name === "encodeURIComponent" &&
    expr.arguments.length === 1
  )
    return ENCODED_SEGMENT;
  return DYNAMIC;
}

function methodOf(expr: Expression): string | null {
  if (expr.kind === "undefined") return "GET";
  if (expr.kind !== "object") return null;
  let method: Expression = UNDEFINED;
  for (const entry of expr.entries) {
    if ("spread" in entry) {
      if (entry.spread.kind === "object") {
        const nested = methodOf(entry.spread);
        if (
          nested !== "GET" ||
          entry.spread.entries.some((item) => "key" in item && item.key === "method")
        )
          method = nested === null ? UNKNOWN : { kind: "string", value: nested };
      } else if (entry.spread.kind !== "undefined") method = UNKNOWN;
    } else if (entry.key === "method") method = entry.value;
  }
  if (method.kind === "undefined") return "GET";
  return method.kind === "string" && /^[A-Za-z]+$/.test(method.value)
    ? method.value.toUpperCase()
    : null;
}

function normalizeRequest(url: string): {
  path: string | null;
  origin: string | null;
  reason?: string;
} {
  const bare = url.split(/[?#]/, 1)[0] ?? "";
  if (bare.includes(DYNAMIC))
    return { path: null, origin: null, reason: "unbounded dynamic URL or path" };
  let path = bare,
    origin: string | null = null;
  if (/^https?:\/\//i.test(bare)) {
    try {
      const parsed = new URL(bare);
      if (parsed.username || parsed.password)
        return { path: null, origin: null, reason: "URL credentials are unsupported" };
      origin = parsed.origin;
      const authorityEnd = bare.indexOf("/", bare.indexOf("://") + 3);
      path = authorityEnd === -1 ? "/" : bare.slice(authorityEnd);
    } catch {
      return { path: null, origin: null, reason: "invalid absolute URL" };
    }
  }
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("//") ||
    /%(?:2e|2f|5c)/i.test(path) ||
    /(^|\/)\.{1,2}(\/|$)/.test(path)
  )
    return {
      path: null,
      origin,
      reason: "URL is not a normalized root-relative or absolute HTTP URL",
    };
  if (path.split("/").some((part) => part.includes(ENCODED_SEGMENT) && part !== ENCODED_SEGMENT))
    return { path: null, origin, reason: "dynamic segment has no complete literal boundary" };
  return { path: path.replaceAll(ENCODED_SEGMENT, "{*}"), origin };
}

export interface ExtractedRequest {
  source: HttpBoundaryProvenanceV1;
  method: string | null;
  path: string | null;
  origin: string | null;
  reason?: string;
  provenance: HttpBoundaryProvenanceV1[];
}

/** Bounded, same-file wrapper substitution; no whole-program execution or guessed clients. */
export function collectRequests(file: HttpBoundaryFileFactsV1): ExtractedRequest[] {
  const result: ExtractedRequest[] = [];
  const transportCalls = file.calls.filter((call) => transportName(file, call));
  const wrappers = new Set(transportCalls.map((call) => call.scope));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    let changed = false;
    for (const call of file.calls) {
      const target = localFunction(file, call);
      if (
        target !== null &&
        target.parameters.length > 0 &&
        wrappers.has(target.scope) &&
        !wrappers.has(call.scope)
      ) {
        wrappers.add(call.scope);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const emit = (
    call: HttpCallFactV1,
    context: Context,
    source: HttpBoundaryProvenanceV1,
    chain: HttpBoundaryProvenanceV1[],
  ): void => {
    if (result.length >= 10000)
      throw new UntangleError("ANALYSIS_INCOMPLETE", "HTTP request expansion budget exceeded");
    const url = render(resolveExpression(call.arguments[0] ?? UNKNOWN, context));
    const method = methodOf(resolveExpression(call.arguments[1] ?? UNDEFINED, context));
    const normalized = normalizeRequest(url);
    result.push({
      source,
      method,
      ...normalized,
      ...(method === null && normalized.reason === undefined
        ? { reason: "HTTP method is not statically known" }
        : {}),
      provenance: [...chain, provenance(file, call.range, "transport")],
    });
  };
  const expand = (
    fn: HttpFunctionFactV1,
    args: Expression[],
    source: HttpBoundaryProvenanceV1,
    chain: HttpBoundaryProvenanceV1[],
    seen: Set<string>,
  ): void => {
    if (seen.has(fn.scope) || seen.size >= 8) {
      result.push({
        source,
        method: null,
        path: null,
        origin: null,
        reason: "local wrapper recursion/depth budget exceeded",
        provenance: chain,
      });
      return;
    }
    instantiated.add(fn.scope);
    const env = new Map(
      fn.parameters.map((param, index) => [
        param.name,
        args[index] ?? param.defaultValue ?? UNDEFINED,
      ]),
    );
    const context = { file, scope: fn.scope, env };
    for (const call of file.calls.filter((call) => call.scope === fn.scope)) {
      if (transportName(file, call)) emit(call, context, source, chain);
      else {
        const target = localFunction(file, call);
        if (target !== null && wrappers.has(target.scope))
          expand(
            target,
            call.arguments.map((arg) => resolveExpression(arg, context)),
            source,
            [...chain, provenance(file, call.range, "transport", target.name)],
            new Set([...seen, fn.scope]),
          );
      }
    }
  };
  const instantiated = new Set<string>();
  for (const call of file.calls) {
    const target = localFunction(file, call);
    if (target === null || !wrappers.has(target.scope) || target.parameters.length === 0) continue;
    const args = call.arguments.map((arg) =>
      resolveExpression(arg, { file, scope: call.scope, env: new Map() }),
    );
    // Pure forwarding calls are expanded through their concrete callers, not invented as requests.
    if (
      args.length === 0 ||
      args.every((arg) => arg.kind === "name" || arg.kind === "unknown" || arg.kind === "undefined")
    )
      continue;
    instantiated.add(target.scope);
    expand(target, args, provenance(file, call.range, "request", target.name), [], new Set());
  }
  for (const call of transportCalls) {
    if (instantiated.has(call.scope)) continue;
    emit(
      call,
      { file, scope: call.scope, env: new Map() },
      provenance(file, call.range, "request"),
      [],
    );
  }
  return result;
}
