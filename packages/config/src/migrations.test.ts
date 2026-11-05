import { afterEach, describe, expect, it } from "vitest";

import { clearMigrations, migrateConfig, registerMigration } from "./migrations.js";

describe("migrateConfig", () => {
  afterEach(() => {
    clearMigrations();
  });

  it("performs an identity migration when the config is already at the target version", () => {
    const raw = { schemaVersion: 1, workspaceId: "w" };
    const result = migrateConfig(raw, 1);
    expect(result.config).toEqual(raw);
    expect(result.finalVersion).toBe(1);
    expect(result.appliedFrom).toEqual([1]);
  });

  it("defaults a missing schemaVersion to 1 before migrating", () => {
    const raw = { workspaceId: "w" };
    const result = migrateConfig(raw, 1);
    expect(result.finalVersion).toBe(1);
    expect(result.appliedFrom).toEqual([1]);
  });

  it("applies a registered migration step and stamps the new schemaVersion", () => {
    registerMigration({
      fromVersion: 1,
      toVersion: 2,
      migrate: (raw) => ({ ...raw, renamedField: raw["oldField"] }),
    });
    const result = migrateConfig({ schemaVersion: 1, oldField: "value" }, 2);
    expect(result.finalVersion).toBe(2);
    expect(result.config).toMatchObject({ schemaVersion: 2, renamedField: "value" });
    expect(result.appliedFrom).toEqual([1, 2]);
  });

  it("chains multiple registered steps", () => {
    registerMigration({
      fromVersion: 1,
      toVersion: 2,
      migrate: (raw) => ({ ...raw, step1: true }),
    });
    registerMigration({
      fromVersion: 2,
      toVersion: 3,
      migrate: (raw) => ({ ...raw, step2: true }),
    });
    const result = migrateConfig({ schemaVersion: 1 }, 3);
    expect(result.config).toMatchObject({ schemaVersion: 3, step1: true, step2: true });
    expect(result.appliedFrom).toEqual([1, 2, 3]);
  });

  it("throws when a required migration step is missing", () => {
    expect(() => migrateConfig({ schemaVersion: 1 }, 2)).toThrow(/no migration registered/);
  });
});
