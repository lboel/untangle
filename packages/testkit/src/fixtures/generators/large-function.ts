/**
 * Pflicht-Fixture 5 (spec.md §27.2): "große Funktion für Chunking und
 * Cognitive Complexity". One real, deeply-nested, branch-heavy function —
 * large enough that a real chunker must split it (spec.md §8.3 step 6/7),
 * and structurally rich enough (nested conditionals, a loop, a switch, a
 * try/catch) to give Cognitive Complexity real contributions to sum.
 */
import type { GeneratedFixture } from "../types.js";

function buildLargeFunctionBody(): string {
  const lines: string[] = [
    "export function classifyOrder(order: {",
    "  total: number;",
    "  itemCount: number;",
    "  country: string;",
    "  isFirstOrder: boolean;",
    "  couponCode?: string;",
    "  items: { category: string; quantity: number; price: number }[];",
    "}): string {",
    '  let classification = "standard";',
    "  let discount = 0;",
    "",
    "  if (order.isFirstOrder) {",
    "    if (order.total > 100) {",
    '      classification = "first-order-large";',
    "      discount += 10;",
    "    } else if (order.total > 50) {",
    '      classification = "first-order-medium";',
    "      discount += 5;",
    "    } else {",
    '      classification = "first-order-small";',
    "    }",
    "  } else if (order.total > 500) {",
    '    classification = "vip";',
    "    discount += 15;",
    "  } else if (order.total > 200) {",
    '    classification = "large";',
    "    discount += 8;",
    "  }",
    "",
    "  switch (order.country) {",
    '    case "DE":',
    '    case "AT":',
    '    case "CH":',
    "      discount += 2;",
    "      break;",
    '    case "US":',
    "      if (order.total > 1000) {",
    "        discount += 3;",
    "      }",
    "      break;",
    "    default:",
    '      classification += "-international";',
    "  }",
    "",
    "  let categoryTotal = 0;",
    "  for (const item of order.items) {",
    '    if (item.category === "electronics" && item.quantity > 3) {',
    "      discount += 1;",
    '    } else if (item.category === "perishable") {',
    "      if (item.quantity > 10) {",
    '        classification += "-bulk-perishable";',
    "      }",
    "    }",
    "    categoryTotal += item.price * item.quantity;",
    "  }",
    "",
    "  if (order.couponCode) {",
    "    try {",
    '      const parsed = Number.parseInt(order.couponCode.replace(/\\D/g, ""), 10);',
    "      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 50) {",
    "        discount += parsed;",
    "      } else {",
    '        classification += "-invalid-coupon";',
    "      }",
    "    } catch {",
    '      classification += "-coupon-error";',
    "    }",
    "  }",
    "",
    "  if (discount > 30) {",
    "    discount = 30;",
    "  }",
    "",
    "  return `${classification}:${discount}:${categoryTotal}:${order.itemCount}`;",
    "}",
    "",
  ];
  return lines.join("\n");
}

export function generateLargeFunction(): GeneratedFixture {
  const files = [
    {
      path: "src/classify-order.ts",
      content: buildLargeFunctionBody(),
    },
  ];

  return {
    files,
    groundTruth: {
      description:
        "classifyOrder(): one large function with nested conditionals, a switch, a loop and a try/catch — must be split by chunking and yields non-trivial cognitive complexity",
      expectedParseQuality: { "src/classify-order.ts": "complete" },
      expectedSymbols: ["classifyOrder"],
    },
  };
}
