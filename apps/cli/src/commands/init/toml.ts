/**
 * A small, purpose-built TOML emitter.
 *
 * WHY NOT A LIBRARY: the point of the file `init` writes is the COMMENTS —
 * the user must be able to see what was decided and why. Every general TOML
 * serializer takes a value and drops the prose, because prose is not part of
 * the value. So the emitter here is a line builder that happens to know how
 * to spell TOML scalars, not a serializer of an object graph.
 *
 * It is deliberately narrow: tables, array-of-tables, scalars and homogeneous
 * scalar arrays. Anything outside that throws rather than guessing — a config
 * file that silently loses a value would be worse than no config file at all.
 */

export type TomlScalar = string | number | boolean;

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * TOML basic-string escaping. `\` and `"` plus the control characters TOML
 * names explicitly; everything else below U+0020 goes to `\uXXXX` because a
 * raw control byte in a config file is unreadable and, in some cases,
 * unparseable.
 */
export function escapeTomlString(value: string): string {
  let out = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
        } else {
          out += char;
        }
      }
    }
  }
  return out;
}

/** A key is written bare when it can be, quoted when it must be. */
export function formatTomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : `"${escapeTomlString(key)}"`;
}

/**
 * Formats a number the way TOML distinguishes integers from floats: an
 * integral value stays integral, a fractional one keeps its decimal point.
 * Non-finite numbers are rejected — TOML has `inf`/`nan` literals, but a
 * config value that is either is a bug upstream, not something to serialize.
 */
export function formatTomlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`cannot serialize non-finite number: ${String(value)}`);
  }
  if (Number.isInteger(value)) {
    return value.toFixed(0);
  }
  return String(value);
}

export function formatTomlScalar(value: TomlScalar): string {
  if (typeof value === "string") {
    return `"${escapeTomlString(value)}"`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return formatTomlNumber(value);
}

/**
 * A line builder for commented TOML.
 *
 * Order is the order of the calls: this class never reorders anything, which
 * is what lets the caller interleave prose and values so that each decision
 * sits directly under its justification.
 */
export class TomlWriter {
  private readonly lines: string[] = [];

  /** A `#` comment. An empty string yields a bare `#`, which reads as a spacer. */
  public comment(text: string): this {
    this.lines.push(text.length === 0 ? "#" : `# ${text}`);
    return this;
  }

  /** Several comment lines at once; convenience for wrapped prose. */
  public comments(texts: readonly string[]): this {
    for (const text of texts) {
      this.comment(text);
    }
    return this;
  }

  public blank(): this {
    this.lines.push("");
    return this;
  }

  /** A `[table.path]` header. */
  public table(path: readonly string[]): this {
    this.lines.push(`[${path.map(formatTomlKey).join(".")}]`);
    return this;
  }

  /** A `[[table.path]]` array-of-tables header. */
  public arrayTable(path: readonly string[]): this {
    this.lines.push(`[[${path.map(formatTomlKey).join(".")}]]`);
    return this;
  }

  public scalar(key: string, value: TomlScalar): this {
    this.lines.push(`${formatTomlKey(key)} = ${formatTomlScalar(value)}`);
    return this;
  }

  /**
   * A single-line array. Written multi-line once it would be long, because a
   * 200-column exclude list is not something a human edits.
   */
  public array(key: string, values: readonly TomlScalar[]): this {
    const rendered = values.map(formatTomlScalar);
    const inline = `${formatTomlKey(key)} = [${rendered.join(", ")}]`;
    if (rendered.length === 0 || inline.length <= 96) {
      this.lines.push(inline);
      return this;
    }
    this.lines.push(`${formatTomlKey(key)} = [`);
    for (const item of rendered) {
      this.lines.push(`  ${item},`);
    }
    this.lines.push("]");
    return this;
  }

  /** An empty inline table — the honest way to write "nothing configured here". */
  public emptyInlineTable(key: string): this {
    this.lines.push(`${formatTomlKey(key)} = {}`);
    return this;
  }

  /**
   * The finished document. Always ends in exactly one newline: a trailing
   * newline is what every line-oriented tool expects, and "exactly one" is
   * what keeps the idempotency comparison from reporting phantom changes.
   */
  public render(): string {
    const body = this.lines.join("\n").replace(/\n+$/u, "");
    return `${body}\n`;
  }
}
