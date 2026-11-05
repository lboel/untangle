/**
 * Canonical JSON serializer (spec.md §5.7, portfolio.md §8.3).
 *
 * Rules:
 * - object keys are serialized in ascending UTF-16 code-unit order;
 * - object properties whose value is `undefined` are omitted entirely;
 * - arrays keep their order; `undefined`, functions and symbols inside arrays
 *   are rejected (they would silently serialize to `null` and hide bugs);
 * - non-finite numbers (`NaN`, `Infinity`), `bigint`, functions and symbols
 *   are rejected everywhere;
 * - `-0` serializes as `0` so that numerically equal inputs hash equally;
 * - cyclic structures are rejected.
 *
 * The output is deterministic: canonicalJson(a) === canonicalJson(b) whenever
 * a and b are structurally equal after dropping undefined object properties.
 */

/** Error thrown when a value cannot be canonically serialized. */
export class CanonicalJsonError extends Error {
  public readonly path: string;

  public constructor(message: string, path: string) {
    super(`${message} (at ${path === "" ? "$" : `$${path}`})`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("non-finite number is not canonically serializable", path);
      }
      // Normalize -0 to 0 for stable hashing.
      return JSON.stringify(value === 0 ? 0 : value);
    }
    case "undefined":
      throw new CanonicalJsonError("undefined is not canonically serializable here", path);
    case "bigint":
      throw new CanonicalJsonError("bigint is not canonically serializable", path);
    case "function":
      throw new CanonicalJsonError("function is not canonically serializable", path);
    case "symbol":
      throw new CanonicalJsonError("symbol is not canonically serializable", path);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`unsupported value type "${typeof value}"`, path);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalJsonError("cyclic structure is not canonically serializable", path);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((element, index) => {
        if (element === undefined) {
          throw new CanonicalJsonError(
            "undefined array element is not canonically serializable",
            `${path}[${index}]`,
          );
        }
        return serialize(element, `${path}[${index}]`, seen);
      });
      return `[${parts.join(",")}]`;
    }

    const proto = Object.getPrototypeOf(obj) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(
        "only plain objects and arrays are canonically serializable",
        path,
      );
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const propertyValue = record[key];
      if (propertyValue === undefined) {
        continue; // undefined object properties are omitted
      }
      parts.push(`${JSON.stringify(key)}:${serialize(propertyValue, `${path}.${key}`, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Serializes `value` to canonical JSON. Deterministic for structurally equal
 * inputs; throws {@link CanonicalJsonError} for values without a canonical form.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "", new Set());
}
