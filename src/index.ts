import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };

export const version = packageJson.version ?? "0.0.0";
export { LogseqServer } from "./logseq.js";
export { runStdioServer } from "./server.js";
export { TOOL_DEFINITIONS } from "./tool-schemas.js";
export type { Frontmatter, GraphNode, StatusEntry, ToolDefinition, ToolResult } from "./types.js";
