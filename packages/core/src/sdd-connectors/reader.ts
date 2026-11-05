import { createHash } from "node:crypto";
import path from "node:path";

import type { FileSystemPort } from "@untangle-code/domain";
import { canonicalJson, sha256Hex } from "@untangle-code/domain";

import type { SddConnectionReportV1, SddSourceV1 } from "./types.js";

export const SDD_LIMITS = {
  documents: 512,
  bytesPerFile: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  entries: 4096,
  depth: 12,
  features: 128,
} as const;

/** Explicit connector reads reject every symlink and never execute project code. */
export class SddReader {
  readonly sources = new Map<string, SddSourceV1>();
  readonly text = new Map<string, string>();
  readonly issues: SddConnectionReportV1["issues"] = [];
  private bytes = 0;
  private entries = 0;
  constructor(
    readonly root: string,
    readonly fs: FileSystemPort,
    readonly signal?: AbortSignal,
  ) {}

  issue(code: string, file: string, message: string): void {
    if (!this.issues.some((item) => item.code === code && item.path === file))
      this.issues.push({ code, path: file, message });
  }
  absolute(relative: string): string | null {
    if (
      !relative ||
      relative.length > 4096 ||
      /[:\\*?[\]{}]/u.test(relative) ||
      Array.from(relative).some((c) => c.charCodeAt(0) < 32) ||
      relative.split("/").some((part) => !part || part === "." || part === "..")
    )
      return null;
    const result = path.resolve(this.root, relative);
    const within = path.relative(this.root, result);
    return within && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within)
      ? result
      : null;
  }
  async safe(relative: string): Promise<"file" | "directory" | "missing" | "unsafe"> {
    this.signal?.throwIfAborted();
    const target = this.absolute(relative);
    if (!target) return "unsafe";
    let current = this.root;
    for (const component of relative.split("/")) {
      current = path.join(current, component);
      const info = await this.fs.lstat(current, this.signal ? { signal: this.signal } : undefined);
      if (!info) return "missing";
      if (info.kind === "symlink" || info.kind === "other") return "unsafe";
      if (current === target) {
        const physical = await this.fs.realPath(
          current,
          this.signal ? { signal: this.signal } : undefined,
        );
        if (physical !== current) return "unsafe";
        return info.kind;
      }
      if (info.kind !== "directory") return "unsafe";
    }
    return "unsafe";
  }
  async read(relative: string): Promise<string | null> {
    this.signal?.throwIfAborted();
    if (this.text.has(relative)) return this.text.get(relative)!;
    const state = await this.safe(relative);
    if (state !== "file") {
      if (state !== "missing")
        this.issue(
          "unsafe_source",
          relative,
          "The connector requires a physical in-project file, without symlink components.",
        );
      return null;
    }
    const absolute = this.absolute(relative)!;
    const info = await this.fs.lstat(absolute, this.signal ? { signal: this.signal } : undefined);
    if (
      !info ||
      info.sizeBytes > SDD_LIMITS.bytesPerFile ||
      this.sources.size >= SDD_LIMITS.documents ||
      this.bytes + info.sizeBytes > SDD_LIMITS.totalBytes
    ) {
      this.issue("read_limit", relative, "The bounded connector file or byte budget was reached.");
      return null;
    }
    try {
      const bytes = await this.fs.readFile(
        absolute,
        this.signal ? { signal: this.signal } : undefined,
      );
      if (
        bytes.length > SDD_LIMITS.bytesPerFile ||
        this.bytes + bytes.length > SDD_LIMITS.totalBytes
      ) {
        this.issue(
          "read_limit",
          relative,
          "The bounded connector byte budget was reached while reading.",
        );
        return null;
      }
      if ((await this.safe(relative)) !== "file") {
        this.issue("changed_source", relative, "The source path changed during its read.");
        return null;
      }
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (value.includes("\0")) throw new Error("Binary content is not a connector document.");
      this.sources.set(relative, {
        path: relative,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
      this.text.set(relative, value);
      this.bytes += bytes.length;
      return value;
    } catch (error) {
      this.signal?.throwIfAborted();
      this.issue(
        "unreadable_source",
        relative,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }
  async walk(relative: string, depth = 0): Promise<string[]> {
    this.signal?.throwIfAborted();
    const state = await this.safe(relative);
    if (state === "missing") return [];
    if (state === "unsafe") {
      this.issue(
        "unsafe_source",
        relative,
        "Symlink and non-physical connector paths are not followed.",
      );
      return [];
    }
    if (state === "file") return [relative];
    if (depth >= SDD_LIMITS.depth || this.entries >= SDD_LIMITS.entries) {
      this.issue(
        "discovery_limit",
        relative,
        "The bounded connector directory budget was reached.",
      );
      return [];
    }
    const result: string[] = [];
    const children = await this.fs.readDir(
      this.absolute(relative)!,
      this.signal ? { signal: this.signal } : undefined,
    );
    for (const child of [...children].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      this.signal?.throwIfAborted();
      if (++this.entries > SDD_LIMITS.entries) {
        this.issue("discovery_limit", relative, "The bounded connector entry budget was reached.");
        break;
      }
      if (child.name === "archive" && relative === "openspec/changes") continue;
      if (child.name.startsWith(".") || child.name === "node_modules") continue;
      const next = `${relative}/${child.name}`;
      result.push(...(await this.walk(next, depth + 1)));
    }
    return result;
  }
  async fresh(): Promise<boolean> {
    let fresh = true;
    for (const source of this.sources.values()) {
      this.signal?.throwIfAborted();
      try {
        const info = await this.fs.lstat(
          this.absolute(source.path)!,
          this.signal ? { signal: this.signal } : undefined,
        );
        if (info?.sizeBytes !== source.bytes)
          throw new Error("Source size changed after inspection.");
        if (
          (await this.safe(source.path)) !== "file" ||
          createHash("sha256")
            .update(
              await this.fs.readFile(
                this.absolute(source.path)!,
                this.signal ? { signal: this.signal } : undefined,
              ),
            )
            .digest("hex") !== source.sha256
        )
          throw new Error("Source bytes or physical path changed during discovery.");
      } catch (error) {
        this.signal?.throwIfAborted();
        fresh = false;
        this.issue(
          "changed_source",
          source.path,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return fresh;
  }
  digest(): string {
    return sha256Hex(
      canonicalJson(
        [...this.sources.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
    );
  }
}
