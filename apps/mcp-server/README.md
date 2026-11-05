# @untangle-code/mcp-server

Private monorepo compatibility entry point for Untangle's MCP server. The published
implementation and stdio command live in `@untangle-code/cli`, exported as
`@untangle-code/cli/mcp`. This package only re-exports that API, so the public CLI
never depends on a private application.

License: AGPL-3.0-only. See `LICENSE` and `NOTICE`.
