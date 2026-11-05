/**
 * Where an `add` gets its manifest from, and what it must prove first.
 *
 * A manifest is a description of how to start a program. Fetching one over
 * the network and writing it into the user profile is therefore a supply-chain
 * step, and it is treated like one:
 *
 * - **https only.** Plain http would let anyone on the path replace the
 *   invocation. There is no `--insecure` escape hatch; a local copy plus
 *   `--from <path>` is the supported answer for an internal http host.
 * - **`--digest` is mandatory for a URL.** Without it, "the file at this URL"
 *   is not a fixed artifact — it is whatever the server serves today. This is
 *   the same reason X6 forbids moving image tags: an artifact that can change
 *   under a stable name changes findings silently.
 * - **A size ceiling.** A manifest is a small TOML file; an endless response
 *   must not become an endless allocation.
 *
 * The digest is sha256 over the RAW BYTES, which is exactly what
 * `shasum -a 256 <file>` and `sha256sum <file>` print — so the value a
 * publisher advertises can be verified by hand.
 */
import { createHash } from "node:crypto";

import type { FileSystemPort } from "@untangle-code/domain";
import { MANIFEST_FILE_NAME } from "@untangle-code/extension-runtime";

/** Largest manifest this CLI will accept from a URL. */
export const MAX_MANIFEST_BYTES = 256 * 1024;

/** Network read budget for one manifest fetch. */
export const FETCH_TIMEOUT_MS = 30_000;

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface ManifestSourceV1 {
  kind: "path" | "url";
  /** What the user typed, for the report. */
  requested: string;
  /** Absolute path or final URL the bytes actually came from. */
  resolved: string;
  bytes: Uint8Array;
  text: string;
  /** `sha256:<64 hex>` over `bytes`. */
  digest: string;
}

export class ManifestSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ManifestSourceError";
  }
}

/** True when the argument looks like a URL rather than a path. */
export function isUrlSource(from: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(from);
}

export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface FetchManifestOptions {
  /** Injected so unit tests never touch the network (CONTRIBUTING, §13). */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Reads a manifest from a local path.
 *
 * `path` may be the manifest file or the directory containing it; the same
 * convenience `loadExtensionFrom` offers, applied to the raw bytes so the
 * digest is computed over the file that will actually be installed.
 */
export async function readManifestFromPath(
  fs: FileSystemPort,
  path: string,
): Promise<ManifestSourceV1> {
  const stat = await fs.stat(path);
  if (stat === null) {
    throw new ManifestSourceError(`no such file or directory: "${path}"`);
  }
  const filePath = stat.kind === "directory" ? `${path}/${MANIFEST_FILE_NAME}` : path;
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(filePath);
  } catch (cause) {
    throw new ManifestSourceError(
      `cannot read "${filePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return {
    kind: "path",
    requested: path,
    resolved: filePath,
    bytes,
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    digest: digestOf(bytes),
  };
}

/**
 * Downloads a manifest over https.
 *
 * Redirects are followed but the FINAL url is reported, so a redirect never
 * hides where the bytes came from. The mandatory `--digest` check happens in
 * the caller, against whatever this returns.
 */
export async function fetchManifestFromUrl(
  url: string,
  options: FetchManifestOptions = {},
): Promise<ManifestSourceV1> {
  const parsed = safeParseUrl(url);
  if (parsed === null) {
    throw new ManifestSourceError(`"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new ManifestSourceError(
      `refusing to download a manifest over "${parsed.protocol}//" — ` +
        "a manifest describes how to start a program, so the transport must be authenticated. " +
        "Download it yourself and install the local copy with --from <path>",
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_MANIFEST_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? FETCH_TIMEOUT_MS);
  options.signal?.addEventListener("abort", () => {
    controller.abort();
  });

  try {
    const response = await fetchImpl(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/plain, application/toml, */*" },
    });
    if (!response.ok) {
      throw new ManifestSourceError(
        `${parsed.toString()} answered HTTP ${String(response.status)}; no manifest was installed`,
      );
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ManifestSourceError(
        `the response is ${String(buffer.byteLength)} bytes, above the ${String(maxBytes)}-byte ` +
          "ceiling for a manifest; nothing was installed",
      );
    }
    const resolved =
      typeof response.url === "string" && response.url !== "" ? response.url : parsed.toString();
    return {
      kind: "url",
      requested: url,
      resolved,
      bytes: buffer,
      text: new TextDecoder("utf-8", { fatal: false }).decode(buffer),
      digest: digestOf(buffer),
    };
  } catch (cause) {
    if (cause instanceof ManifestSourceError) {
      throw cause;
    }
    if (controller.signal.aborted) {
      throw new ManifestSourceError(
        `downloading ${parsed.toString()} exceeded the ${String(options.timeoutMs ?? FETCH_TIMEOUT_MS)} ms budget`,
      );
    }
    throw new ManifestSourceError(
      `cannot download ${parsed.toString()}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
