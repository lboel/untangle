/**
 * Private monorepo compatibility entry. The distributable runtime lives in
 * `@untangle-code/cli/mcp`; keeping this direction avoids a public package
 * depending on an unpublished application.
 */
export * from "@untangle-code/cli/mcp";
