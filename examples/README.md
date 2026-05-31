# Client Examples

These examples use `/path/to/logseq-graph` as a placeholder. Replace it with a
local Logseq graph directory that contains `pages/`.

For write-capable sessions, keep `LOGSEQ_GIT_GUARD=strict` and start with the
`graph_status` tool before making changes. For read-only review sessions, set
`LOGSEQ_READONLY=1`.

## Codex

Use `examples/codex-mcp.json` as the MCP server entry for a local Codex client
configuration that supports stdio MCP servers.

## ChatGPT

Use `examples/chatgpt-mcp.json` as a stdio MCP server declaration for ChatGPT
surfaces that support local MCP connectors.

## Claude Desktop

Copy the `mcpServers` object from `examples/claude-desktop.json` into Claude
Desktop's configuration file, then restart Claude Desktop.
