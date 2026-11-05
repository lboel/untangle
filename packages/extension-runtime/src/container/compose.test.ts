/**
 * Was die gerenderte Bereitstellung garantieren muss — und was sie nie darf.
 *
 * Die Datei entsteht aus dem Manifest, nicht aus einer mitgebrachten YAML. Der
 * Grund steht im Modulkopf: die vorhandene Fassung dieses Projekts nannte ein
 * wanderndes Tag, womit der gepinnte Digest nichts mehr gepinnt haette.
 */
import { describe, expect, it } from "vitest";

import { parseExtensionManifest } from "../manifest/shape.js";
import { readFixture } from "../test-support/fixtures.js";

import { composeProjectName, renderComposeFile, volumeName } from "./compose.js";

const RESTRICTED = readFixture("manifests/restricted.manifest.toml");

function manifest() {
  const parsed = parseExtensionManifest(RESTRICTED);
  if (parsed.manifest === null) {
    throw new Error(`fixture invalid: ${JSON.stringify(parsed.issues)}`);
  }
  return parsed.manifest;
}

describe("renderComposeFile", () => {
  it("zieht das Image ueber den Digest, nie ueber ein Tag (X6)", () => {
    const yaml = renderComposeFile({ manifest: manifest() });
    expect(yaml).toContain(
      'image: "registry.example.invalid/restricted-analyzer@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
    );
    expect(yaml).not.toMatch(/image: "[^"]*:(latest|community|stable)"/);
  });

  it("bindet jeden Port ausschliesslich an 127.0.0.1", () => {
    const yaml = renderComposeFile({ manifest: manifest() });
    const bindings = [...yaml.matchAll(/- "([^"]*:\d+:\d+)"/g)].map((m) => m[1] ?? "");
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      expect(binding.startsWith("127.0.0.1:")).toBe(true);
    }
  });

  it("weicht einer fremden Instanz aus, ohne das Manifest zu aendern", () => {
    const yaml = renderComposeFile({ manifest: manifest(), hostPorts: { api: 19001 } });
    expect(yaml).toContain('- "127.0.0.1:19001:9000"');
    expect(yaml).not.toContain("19000");
  });

  it("setzt beide Labels — sie sind die spaetere Besitzprobe", () => {
    const yaml = renderComposeFile({ manifest: manifest() });
    expect(yaml).toContain('dev.untangle.managed: "true"');
    expect(yaml).toContain('dev.untangle.extension: "restricted-tool"');
  });

  it("startet nie privilegiert und nimmt alle Capabilities weg", () => {
    const yaml = renderComposeFile({ manifest: manifest() });
    expect(yaml).toContain("privileged: false");
    expect(yaml).toContain("cap_drop:");
    expect(yaml).toContain("- ALL");
    expect(yaml).toContain('- "no-new-privileges:true"');
    expect(yaml).not.toContain("network_mode: host");
  });

  it("praefixiert jedes Volume, damit kein fremdes getroffen wird", () => {
    const yaml = renderComposeFile({ manifest: manifest() });
    for (const volume of manifest().container?.volumes ?? []) {
      expect(yaml).toContain(volumeName("restricted-tool", volume.name));
    }
    expect(composeProjectName("restricted-tool")).toBe("untangle-ext-restricted-tool");
  });

  it("haengt den Arbeitsbereich nur ein, wenn er uebergeben wird — und wie deklariert", () => {
    expect(renderComposeFile({ manifest: manifest() })).not.toContain("/workspace");
    const mounted = renderComposeFile({ manifest: manifest(), workspacePath: "/work/repo" });
    expect(mounted).toContain('- "/work/repo:/workspace:ro"');
  });

  it("rendert deterministisch — gleiche Eingabe, bytegleiche Datei", () => {
    const first = renderComposeFile({ manifest: manifest(), workspacePath: "/work/repo" });
    const second = renderComposeFile({ manifest: manifest(), workspacePath: "/work/repo" });
    expect(first).toBe(second);
  });

  it("rendert nichts Halbes, wenn das Manifest keinen Container beschreibt", () => {
    const parsed = parseExtensionManifest(readFixture("manifests/valid-sarif.manifest.toml"));
    expect(() => renderComposeFile({ manifest: parsed.manifest! })).toThrow(/no container block/);
  });
});
