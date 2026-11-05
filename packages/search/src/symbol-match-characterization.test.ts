import { describe, expect, it } from "vitest";

import { matchSymbolName } from "./symbol-match.js";
import { payloadFixture } from "./testing/candidates.js";

describe("symbol matching precedence characterization", () => {
  it.each([
    [undefined, "Service.charge", "charge"],
    [undefined, "Service::charge", "charge"],
    [undefined, "Service.charge", "Service.charge"],
    [undefined, "Service::charge", "Service::charge"],
    ["", "Service.charge", "charge"],
    ["other", "Service.charge", "charge"],
    ["getCharge", "Service.charge", "charge"],
    [undefined, "Service.charge", "  charge\t"],
  ])("keeps qualified-name evidence for name=%s fqn=%s query=%s", (name, fqn, text) => {
    const payload = payloadFixture({ ...(name === undefined ? {} : { symbol_name: name }), ...(fqn === undefined ? {} : { symbol_fqn: fqn }) });
    const before = structuredClone(payload);
    expect(matchSymbolName(payload, text!)).toEqual({
      strength: 0.6,
      evidence: `symbol_fqn "${fqn}" ends with "${text!.trim()}"`,
    });
    expect(payload).toEqual(before);
  });

  it.each([
    ["charge", "Service.charge", "charge", 1, 'symbol_name == "charge"'],
    ["Charge", "Service.charge", "charge", 0.8, 'symbol_name ~= "Charge" (case-insensitive)'],
    ["charge", "Service.other", " charge ", 1, 'symbol_name == "charge"'],
    [
      "getUserById",
      undefined,
      "get user",
      0.4,
      'symbol_name "getUserById" contains all query parts',
    ],
    [
      "get_user_by_id",
      undefined,
      "getUser",
      0.4,
      'symbol_name "get_user_by_id" contains all query parts',
    ],
    [
      "HTTPServer",
      undefined,
      "http server",
      0.4,
      'symbol_name "HTTPServer" contains all query parts',
    ],
  ] as const)(
    "retains priority and exact evidence for %s / %s / %s",
    (name, fqn, text, strength, evidence) => {
      const payload = payloadFixture({ ...(name === undefined ? {} : { symbol_name: name }), ...(fqn === undefined ? {} : { symbol_fqn: fqn }) });
      const before = structuredClone(payload);
      expect(matchSymbolName(payload, text)).toEqual({ strength, evidence });
      expect(payload).toEqual(before);
    },
  );

  it.each([
    [undefined, undefined, "charge"],
    [undefined, "Service.other", "charge"],
    [undefined, "Service/charge", "charge"],
    [undefined, "Service#charge", "charge"],
    [undefined, "Service.Charge", "charge"],
    [undefined, "Service.chargeExtra", "charge"],
    [undefined, undefined, "---"],
    ["", undefined, "charge"],
    ["refund", undefined, "charge"],
    ["getUser", undefined, "user charge"],
    ["charge", "Service.charge", " \n\t"],
    ["getUser", undefined, "---"],
  ])("retains no-match behavior for name=%s fqn=%s query=%s", (name, fqn, text) => {
    expect(
      matchSymbolName(payloadFixture({ ...(name === undefined ? {} : { symbol_name: name }), ...(fqn === undefined ? {} : { symbol_fqn: fqn }) }), text!),
    ).toBeNull();
  });

  it.each([
    ["charge", "Service.charge", "charge", ["name"]],
    ["Charge", "Service.charge", "charge", ["name"]],
    [undefined, "Service.charge", "charge", ["name", "fqn"]],
    [undefined, "Service.other", "charge", ["name", "fqn"]],
    ["getUserById", undefined, "get user", ["name", "fqn"]],
    [undefined, "Service.charge", "   ", ["name"]],
  ] as const)("preserves payload read order for %s / %s / %s", (name, fqn, text, expected) => {
    const reads: string[] = [];
    const payload = payloadFixture();
    Object.defineProperties(payload, {
      symbol_name: {
        get: () => {
          reads.push("name");
          return name;
        },
      },
      symbol_fqn: {
        get: () => {
          reads.push("fqn");
          return fqn;
        },
      },
    });
    matchSymbolName(payload, text);
    expect(reads).toEqual(expected);
  });
});
