import { describe, expect, it } from "vitest";

import { symbolNameFilterCandidates } from "./symbol-match.js";

describe("symbol storage filter candidate characterization", () => {
  it.each([
    { query: "\t charge \r\n", expected: ["charge"] },
    { query: "\u00a0\ufeffcharge\u2028\u2029", expected: ["charge"] },
    { query: "\ufeff\u00a0\t", expected: [] },
    { query: "get user", expected: ["get user"] },
    { query: "get\tuser", expected: ["get\tuser"] },
    { query: "get\nuser", expected: ["get\nuser"] },
    { query: " get\u00a0user ", expected: ["get\u00a0user"] },
    { query: "PaymentService::charge", expected: ["PaymentService::charge", "charge"] },
    { query: "src/payment#charge", expected: ["charge", "src/payment#charge"] },
    { query: "service...charge", expected: ["charge", "service...charge"] },
    { query: "service/", expected: ["service/"] },
    { query: "service::", expected: ["service::"] },
    { query: "///", expected: ["///"] },
    { query: ".charge", expected: [".charge", "charge"] },
    { query: "service. charge", expected: [" charge", "service. charge"] },
    { query: " service.charge ", expected: ["charge", "service.charge"] },
    { query: "\u200bcharge\u200b", expected: ["\u200bcharge\u200b"] },
    { query: "größenÄnderung", expected: ["größenÄnderung"] },
    { query: "Service.😀", expected: ["Service.😀", "😀"] },
  ])("preserves exact candidates for $query", ({ query, expected }) => {
    expect(symbolNameFilterCandidates(query)).toEqual(expected);
  });
});
