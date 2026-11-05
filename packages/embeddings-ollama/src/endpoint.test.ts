import { describe, expect, it } from "vitest";

import { joinUrl, redactEndpointUrl } from "./endpoint.js";

describe("redactEndpointUrl", () => {
  it("leaves a plain URL without credentials unchanged", () => {
    expect(redactEndpointUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  });

  it("strips userinfo (username/password) embedded in the URL", () => {
    const redacted = redactEndpointUrl("http://user:secret@ollama.internal:11434");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("user");
    expect(redacted).toContain("ollama.internal");
  });

  it("returns the input unchanged when it is not a parseable absolute URL", () => {
    expect(redactEndpointUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("joinUrl", () => {
  it("joins a base URL without a trailing slash to a path", () => {
    expect(joinUrl("http://127.0.0.1:11434", "api/tags")).toBe("http://127.0.0.1:11434/api/tags");
  });

  it("joins a base URL with a trailing slash to a path without doubling the slash", () => {
    expect(joinUrl("http://127.0.0.1:11434/", "api/tags")).toBe("http://127.0.0.1:11434/api/tags");
  });
});
