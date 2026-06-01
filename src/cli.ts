#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { maintenanceUsage, parseMaintenanceArgs, runDoctor, runUpdate } from "./cli-maintenance.js";
import { LogseqServer } from "./logseq.js";
import { packageVersion } from "./package-info.js";
import { runStdioServer } from "./server.js";

const USAGE_EXIT = 64;
const CONFIG_EXIT = 78;

type CliOptions = {
  help: boolean;
  readonly: boolean;
  root?: string;
  version: boolean;
  watch?: boolean;
};

function usage(): string {
  return `Usage: logseq-graph-mcp --root /path/to/logseq
       logseq-graph-mcp /path/to/logseq

Local-only stdio MCP server for safe agent access to a Logseq markdown graph.

Options:
  -r, --root PATH     Graph root containing pages/
      --readonly      Refuse every mutating tool for this process
      --no-watch      Disable filesystem watcher invalidation
  -v, --version       Print package version
  -h, --help          Show this help

Environment:
  LOGSEQ_ROOT can supply the graph root when --root is omitted.
  LOGSEQ_READONLY=1 is equivalent to --readonly.
  LOGSEQ_WATCH=0 is equivalent to --no-watch.

Optional runtime integrations:
  re2 is used for safer regex searches when installed; native RegExp is used otherwise.
  git is required only when LOGSEQ_GIT_GUARD=strict or warn.
  python3 is required only when LOGSEQ_ALLOW_EXTERNAL_REGEN=1 and the graph supplies scripts/regenerate_graph_index.py.

${maintenanceUsage("logseq-graph-mcp")}
`;
}

function fail(message: string, exitCode = USAGE_EXIT): never {
  process.stderr.write(`${message}\n\n${usage()}`);
  process.exit(exitCode);
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) fail(`Missing value for ${flag}.`);
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, readonly: false, version: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
    } else if (arg === "-r" || arg === "--root") {
      options.root = readValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
      if (!options.root) fail("Missing value for --root.");
    } else if (arg === "--readonly") {
      options.readonly = true;
    } else if (arg === "--no-watch") {
      options.watch = false;
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    } else if (!options.root) {
      options.root = arg;
    } else {
      fail(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function resolveRoot(options: CliOptions): string {
  const root = options.root ?? process.env.LOGSEQ_ROOT;
  if (!root) fail("Missing Logseq graph root. Pass --root or set LOGSEQ_ROOT.");

  const resolved = path.resolve(root);
  const pages = path.join(resolved, "pages");
  if (!fs.existsSync(pages) || !fs.statSync(pages).isDirectory()) {
    fail(`Logseq graph root must contain a pages/ directory: ${resolved}`, CONFIG_EXIT);
  }

  return resolved;
}

function isDirectRun(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  const invokedRealPath = fs.realpathSync(path.resolve(invokedPath));
  const moduleRealPath = fs.realpathSync(fileURLToPath(import.meta.url));
  return pathToFileURL(invokedRealPath).href === pathToFileURL(moduleRealPath).href;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "doctor" || argv[0] === "update") {
    const maintenanceOptions = parseMaintenanceArgs(argv);
    if (maintenanceOptions.help) {
      process.stdout.write(maintenanceUsage("logseq-graph-mcp"));
      return;
    }
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const modulePath = fileURLToPath(import.meta.url);
    process.exitCode = maintenanceOptions.command === "doctor"
      ? runDoctor({ packageRoot, modulePath, root: maintenanceOptions.root, json: maintenanceOptions.json })
      : runUpdate({ packageRoot, modulePath, options: maintenanceOptions });
    return;
  }

  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  if (options.version) {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }

  const root = resolveRoot(options);
  if (options.readonly) process.env.LOGSEQ_READONLY = "1";
  if (options.watch === false) process.env.LOGSEQ_WATCH = "0";

  await runStdioServer(new LogseqServer({ root }));
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export const version = packageVersion;
export { LogseqServer, runStdioServer };
