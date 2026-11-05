/**
 * X6 an der Manifestgrenze: das Image wird ueber den Digest gezogen, nie ueber
 * ein bewegliches Tag.
 *
 * Die Pruefung war urspruenglich `image.includes(":")`. Das trifft das Ziel in
 * der Mitte und daneben zugleich: ein Tag wird erkannt, aber eine private
 * Registry mit Port — `registry.example.invalid:5000/analyzer`, die
 * naheliegendste Form in einem abgeschotteten Netz — wird mit der Begruendung
 * „image must be the repository name without a tag" abgelehnt, obwohl gar kein
 * Tag da ist. Eine falsche Begruendung ist teurer als eine strenge Regel: sie
 * schickt den Nutzer in die falsche Richtung.
 */
import { describe, expect, it } from "vitest";

import { parseExtensionManifest } from "./shape.js";

const BASE = `schemaVersion = 1
id = "image-ref"
displayName = "Image Reference Probe"
category = "lint"
invocation = ["container"]
languages = []
outputFormat = "generic-findings"
networkAccess = "none"
requiresLicenseAcknowledgment = false

[container]
image = "IMAGE"
digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

[container.workspaceMount]
mountPath = "/workspace"
readOnly = true

[container.healthcheck]
kind = "command"
command = ["true"]
intervalMs = 1000
timeoutMs = 500
retries = 3

[resources]
minMemoryMb = 128
recommendedMemoryMb = 256
recommendedCpus = 1

[license]
spdxId = "Apache-2.0"
usageRestriction = "none"

[telemetry]
sendsTelemetry = false
disabledByDefault = true
`;

function issuesFor(image: string): string[] {
  const parsed = parseExtensionManifest(BASE.replace("IMAGE", image));
  return parsed.issues.filter((issue) => issue.field === "container.image").map((i) => i.message);
}

describe("container.image (X6)", () => {
  it("nimmt einen einfachen Repositorynamen an", () => {
    expect(issuesFor("vendor/analyzer")).toEqual([]);
  });

  it("nimmt eine Registry mit Host und Port an — ein Port ist kein Tag", () => {
    expect(issuesFor("registry.example.invalid:5000/vendor/analyzer")).toEqual([]);
  });

  it("nimmt `localhost` mit Port an", () => {
    expect(issuesFor("localhost:5000/analyzer")).toEqual([]);
  });

  it("lehnt ein Tag ab", () => {
    expect(issuesFor("vendor/analyzer:latest")).toHaveLength(1);
    expect(issuesFor("vendor/analyzer:latest")[0]).toContain("tag");
  });

  it("lehnt ein Tag hinter einer Registry mit Port ab", () => {
    expect(issuesFor("registry.example.invalid:5000/vendor/analyzer:1.2.3")).toHaveLength(1);
  });

  it("lehnt einen im Image eingebetteten Digest ab — gepinnt wird in `digest`", () => {
    const messages = issuesFor(
      "vendor/analyzer@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("digest");
  });
});
