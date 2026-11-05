import { describe, expect, it } from "vitest";

import {
  identifierParts,
  LEXICAL_TOKENIZER_VERSION,
  splitIdentifierRun,
  tokenizeIdentifiers,
} from "./identifier-tokenizer.js";

describe("shared identifier token space", () => {
  it.each([
    ["getUserById", ["getuserbyid", "get", "user", "by", "id"]],
    ["get_user_by_id", ["get_user_by_id", "get", "user", "by", "id"]],
    ["HTTPServer", ["httpserver", "http", "server"]],
    ["v2Token", ["v2token", "v2", "token"]],
    ["user", ["user"]],
    ["__private__", ["__private__", "private"]],
    ["用户名称", ["用户名称"]],
    ["größenÄnderung", ["größenänderung", "größen", "änderung"]],
    ["𐐀𐐨User", ["𐐨𐐨user", "𐐨𐐨", "user"]],
    [" ___ --- !!! ", []],
  ])("tokenizes %s without losing the full identifier", (text, tokens) => {
    expect(tokenizeIdentifiers(text as string)).toEqual(tokens);
  });

  it("keeps occurrence counts without duplicating plain words", () => {
    expect(tokenizeIdentifiers("user user get_user_user")).toEqual([
      "user",
      "user",
      "get_user_user",
      "get",
      "user",
      "user",
    ]);
  });

  it("normalizes composed and decomposed Unicode consistently", () => {
    expect(tokenizeIdentifiers("cafe\u0301Name")).toEqual(tokenizeIdentifiers("caféName"));
  });

  it("treats surrounding punctuation as separators and retains snake identifiers", () => {
    expect(tokenizeIdentifiers("service.get_user_by_id(id)")).toEqual([
      "service",
      "get_user_by_id",
      "get",
      "user",
      "by",
      "id",
      "id",
    ]);
  });

  it("shares component splitting for symbol matching", () => {
    expect(identifierParts("service.get_user_by_HTTPId")).toEqual([
      "service",
      "get",
      "user",
      "by",
      "http",
      "id",
    ]);
    expect(splitIdentifierRun("HTTPServer")).toEqual(["http", "server"]);
  });

  it("exposes a persisted compatibility version for sparse vectors", () => {
    expect(LEXICAL_TOKENIZER_VERSION).toBe("untangle-identifier-tokenizer-v2");
  });
});
