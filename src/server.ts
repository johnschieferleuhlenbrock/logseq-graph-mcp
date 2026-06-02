import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { LogseqServer } from "./logseq.js";
import { packageName, packageVersion } from "./package-info.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function send(message: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function toolContent(payload: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(payload, null, 2) }];
}

export async function runStdioServer(server = new LogseqServer()): Promise<void> {
  for (const line of server.startupDiagnostics()) console.error(line);

  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  let protocolVersion = "2024-11-05";
  let structuredContentEnabled = false;
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${(err as Error).message}` } });
      continue;
    }

    if (req.method?.startsWith("notifications/")) continue;
    if (req.id === undefined) continue;

    try {
      if (req.method === "initialize") {
        const requestedProtocol = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2024-11-05";
        structuredContentEnabled = requestedProtocol >= "2025-06-18";
        protocolVersion = structuredContentEnabled ? requestedProtocol : "2024-11-05";
        send({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: packageName, version: packageVersion },
            instructions: "Local-only stdio MCP server for safe access to a Logseq markdown graph.",
          },
        });
      } else if (req.method === "tools/list") {
        send({ jsonrpc: "2.0", id: req.id, result: { tools: server.toolDefinitions() } });
      } else if (req.method === "tools/call") {
        const params = req.params ?? {};
        const name = String(params.name ?? "");
        const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments))
          ? params.arguments as Record<string, unknown>
          : {};
        const result = server.callTool(name, args);
        const response: Record<string, unknown> = { content: toolContent(result), isError: !result.ok };
        if (structuredContentEnabled) response.structuredContent = result;
        send({ jsonrpc: "2.0", id: req.id, result: response });
      } else {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method ?? ""}` } });
      }
    } catch (err) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: (err as Error).message } });
    }
  }
}
