import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name?: string; version?: string; description?: string };

export const packageName = packageJson.name ?? "logseq-graph-mcp";
export const packageVersion = packageJson.version ?? "0.0.0";
export const packageDescription = packageJson.description ?? "Local-only stdio MCP server for safe access to a Logseq markdown graph.";
