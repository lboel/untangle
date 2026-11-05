import { describe, expect, it } from "vitest";

import { classifyNodeKind, isAsyncNodeKind, isExceptionNodeKind } from "./node-kind-heuristics.js";

describe("classifyNodeKind", () => {
  it("classifies common tree-sitter-style kind names", () => {
    expect(classifyNodeKind("required_parameter")).toBe("parameter");
    expect(classifyNodeKind("optional_parameter")).toBe("parameter");
    expect(classifyNodeKind("return_statement")).toBe("return");
    expect(classifyNodeKind("throw_statement")).toBe("exit");
    expect(classifyNodeKind("break_statement")).toBe("exit");
    expect(classifyNodeKind("continue_statement")).toBe("exit");
    expect(classifyNodeKind("variable_declaration")).toBe("declaration");
    expect(classifyNodeKind("if_statement")).toBe("statement");
    expect(classifyNodeKind("call_expression")).toBe("expression");
    expect(classifyNodeKind("identifier")).toBe("other");
  });

  it("checks return before the generic statement bucket", () => {
    expect(classifyNodeKind("return_statement")).not.toBe("statement");
  });
});

describe("isAsyncNodeKind / isExceptionNodeKind", () => {
  it("recognizes async/await constructs", () => {
    expect(isAsyncNodeKind("await_expression")).toBe(true);
    expect(isAsyncNodeKind("async_function")).toBe(true);
    expect(isAsyncNodeKind("identifier")).toBe(false);
  });

  it("recognizes exception constructs", () => {
    expect(isExceptionNodeKind("try_statement")).toBe(true);
    expect(isExceptionNodeKind("catch_clause")).toBe(true);
    expect(isExceptionNodeKind("throw_statement")).toBe(true);
    expect(isExceptionNodeKind("identifier")).toBe(false);
  });
});
