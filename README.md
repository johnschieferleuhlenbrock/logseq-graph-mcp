# Logseq Graph MCP

[![npm version](https://img.shields.io/npm/v/logseq-graph-mcp.svg)](https://www.npmjs.com/package/logseq-graph-mcp)
[![CI](https://github.com/johnschieferleuhlenbrock/logseq-graph-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/johnschieferleuhlenbrock/logseq-graph-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-brightgreen.svg)](LICENSE)
[![node](https://img.shields.io/node/v/logseq-graph-mcp.svg)](package.json)

Local-only stdio MCP server for safe agent access to Logseq markdown graphs.

The graph root must contain `pages/` and may contain `journals/`. The server
does not bind a network port and does not require a Logseq API, cloud account,
or browser session.

## Requirements

- Node.js 20.17.0 or newer, plus npm for source installs or `npx` usage.
- A local Logseq graph directory containing `pages/`.
- Git installed when `LOGSEQ_GIT_GUARD=strict` is used for write-capable
  sessions.

## Install From Source

```sh
npm install
npm run build
node dist/cli.js --root /path/to/logseq-graph
```

For local setup validation, set `LOGSEQ_ROOT` and run:

```sh
LOGSEQ_ROOT=/path/to/logseq-graph ./install.sh
```

## Install From npm

After publication, the intended one-shot form is:

```sh
npx logseq-graph-mcp --root /path/to/logseq-graph
```

## Maintenance Commands

The MCP CLI and Living Atlas CLI share the same maintenance shape:

```sh
logseq-graph-mcp doctor [--root /path/to/logseq-graph] [--json]
logseq-graph-mcp update [--check|--dry-run|--apply] [--channel latest] [--json]
```

`doctor` validates the local runtime, package metadata, install mode, built CLI, and optional graph root.

`update` checks npm release metadata for the selected channel and prints install-mode-aware guidance:

- source checkout: `git pull && npm install && npm run check`
- npx execution: `npx logseq-graph-mcp@<channel>`
- npm package install: `npm install -g logseq-graph-mcp@<channel>`

Actual mutation requires `update --apply` plus `LOGSEQ_UPDATE_ALLOW_APPLY=1`. Source checkouts and npx runs refuse in-place mutation.

## Client Configuration

Ready-to-edit examples are available under `examples/` for Codex, ChatGPT, and
Claude Desktop.

Claude Desktop configuration:

```json
{
  "mcpServers": {
    "logseq": {
      "command": "npx",
      "args": ["logseq-graph-mcp", "--root", "/path/to/logseq-graph"]
    }
  }
}
```

For local development from a cloned repository:

```json
{
  "mcpServers": {
    "logseq": {
      "command": "node",
      "args": ["/path/to/logseq-graph-mcp/dist/cli.js", "--root", "/path/to/logseq-graph"]
    }
  }
}
```

## Tool Surface

Read tools:

- `list_pages`
- `read_page`
- `read_pages`
- `read_journal`
- `search`
- `backlinks`
- `query_pages`
- `graph_status`

Safe write tools (default write-capable surface):

- `submit_write_intent`
- `flush_write_intents`
- `get_write_intent`
- `list_write_intents`
- `cancel_write_intent`

Raw write tools (`LOGSEQ_WRITE_MODE=admin_raw` only):

- `update_property`
- `batch_update_property`
- `delete_property`
- `append_contact_log`
- `append_journal_bullet`
- `create_stub`
- `rename_page`
- `delete_page`
- `update_body_section`

Analysis and meta tools:

- `find_orphans`
- `find_low_degree`
- `find_hubs`
- `node_degree`
- `graph_stats`
- `find_components`
- `find_dangling_links`
- `regenerate_index` (raw/admin only; submit it as a safe-write intent in default mode)

All tool payloads use `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`.
MCP clients that negotiate protocol `2025-06-18` or newer receive both `structuredContent` and a JSON text item in `content`; older clients receive the JSON text item only.

## Safety Model

The server is designed for local subprocess execution under the current user.
It should not be exposed as a remote service without a separate authentication
and authorization layer.

- `LOGSEQ_READONLY=1` or `LOGSEQ_WRITE_MODE=readonly` exposes read tools only.
- `LOGSEQ_WRITE_MODE=intent` is the default write-capable mode. Agents submit durable write intents and flush explicit intent IDs; raw mutating tools are hidden.
- `LOGSEQ_WRITE_MODE=admin_raw` exposes raw mutating tools for local admin/debug use.
- Safe writes persist an operation ledger outside the graph, enforce idempotency keys, revalidate preconditions before mutation, and record git checkpoint metadata.
- `LOGSEQ_VALIDATE_SCHEMA=block|warn|off` controls property-key validation.
- `LOGSEQ_DISALLOW_FORCE=1` rejects forced schema bypasses.
- `LOGSEQ_VALIDATE_LINKS=block|warn|off` controls dangling wikilink validation.
- `LOGSEQ_GIT_GUARD=strict|warn|off` controls clean-tree checks, blast-radius enforcement, and checkpoint commits.
- Writes use metadata lockfiles plus atomic temp-file replacement.
- Writes re-read target files inside the lock before mutating.
- Mutations are append-style or property-level where possible.
- `delete_page` moves pages into `archive/YYYY/MM/` instead of deleting content.
- `rename_page` leaves a redirect stub by default.
- Successful writes audit to today's journal under `Agent activity`.
- Path traversal and symlink escape protections are enforced.
- Read responses are capped by `LOGSEQ_MAX_RESPONSE_BYTES`.
- The server writes diagnostics only to local stderr.
- A persistent cache stores frontmatter and graph adjacency outside the graph
  directory, and file watchers invalidate in-process state after external edits.
- Search uses the optional `re2` package when installed, falling back to native
  JavaScript `RegExp` with length, line, and time caps.
- `regenerate_index` uses the built-in TypeScript index writer by default; graph-provided
  Python regenerators require `LOGSEQ_ALLOW_EXTERNAL_REGEN=1`.

Recommended first call for write-capable sessions:

```json
{ "tool": "graph_status", "arguments": {} }
```

Proceed only when the reported Git state and generated-index state are expected.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOGSEQ_ROOT` | package directory fallback | Graph root containing `pages/` |
| `LOGSEQ_READONLY` | unset | Set `1` to refuse all writes |
| `LOGSEQ_WRITE_MODE` | `intent` | `readonly`, `intent`, or `admin_raw`; raw mutating tools are hidden unless `admin_raw` |
| `LOGSEQ_VALIDATE_SCHEMA` | `block` | `block`, `warn`, or `off` |
| `LOGSEQ_DISALLOW_FORCE` | unset | Set `1` to reject force bypass |
| `LOGSEQ_VALIDATE_LINKS` | `block` | `block`, `warn`, or `off` |
| `LOGSEQ_GIT_GUARD` | `strict` | `strict` blocks dirty or oversized writes before checkpoint commits; `warn` logs violations and still checkpoints; `off` disables the guard |
| `LOGSEQ_GIT_MAX_CHANGED_FILES` | `25` | Maximum changed files allowed per guarded write; strict blocks, warn logs and checkpoints |
| `LOGSEQ_GIT_MAX_DELETED_FILES` | `0` | Maximum deleted files allowed per guarded write; strict blocks, warn logs and checkpoints |
| `LOGSEQ_GIT_COMMIT_AUTHOR` | local MCP guard author | Author for checkpoint commits |
| `LOGSEQ_GIT_GUARD_IGNORE_DIRS` | unset | Comma-separated top-level guard ignores |
| `LOGSEQ_CACHE_DIR` | `~/.cache/logseq-mcp` | Persistent frontmatter and adjacency cache directory |
| `LOGSEQ_WATCH` | `1` | Set `0` to disable filesystem watcher invalidation |
| `LOGSEQ_LOCK_TIMEOUT_MS` | `5000` | Lock acquisition timeout for writes |
| `LOGSEQ_MAX_RESPONSE_BYTES` | `500000` | Maximum JSON response size |
| `LOGSEQ_MAX_REGEX_LEN` | `500` | Maximum user regex length |
| `LOGSEQ_REGEX_TIMEOUT_S` | `2` | Search wall-clock budget |
| `LOGSEQ_MAX_SEARCH_LINE` | `10000` | Per-line search input cap |
| `LOGSEQ_REGEX_ENGINE` | `auto` | `auto` uses optional `re2` when installed; `native` forces JavaScript `RegExp` |
| `LOGSEQ_ALLOW_EXTERNAL_REGEN` | unset | Set `1` to allow a graph-provided `scripts/regenerate_graph_index.py` |
| `LOGSEQ_PYTHON` | `python3` | Optional executable used by `regenerate_index` only when a graph ships `scripts/regenerate_graph_index.py` |

## Undoing a Write

Every successful write guarded by Git creates a checkpoint commit with a subject
like `mcp-logseq: update_property <txn_id>`. To inspect recent MCP writes:

```sh
git -C /path/to/logseq-graph log --grep=mcp-logseq --oneline -20
```

To undo one checkpoint safely:

```sh
git -C /path/to/logseq-graph revert <commit>
```

Prefer `git revert` for normal recovery because it preserves history. When a
strict-mode guard violation is reported, the response includes `before_head`,
`commit: null`, `changed_files`, `txn_id`, and a `rollback_hint` for emergency
reset workflows. In warn mode, oversized writes still create a checkpoint commit
and record the warning in the commit metadata.

## Development

```sh
npm install
npm run check
npm run sbom
```

Tests use temporary Git-backed Logseq fixture graphs. They do not read or mutate
a real graph.

## Release

GitHub Actions runs CI, SBOM generation, CodeQL, and dependency review.
Dependabot is configured for npm and GitHub Actions updates. Publishing is
handled by the `Release` workflow after npm trusted publishing is configured;
see `docs/RELEASE.md`.

## Architecture

The runtime is split into:

- `src/cli.ts`: CLI argument parsing and process entrypoint.
- `src/index.ts`: package library exports.
- `src/server.ts`: local stdio JSON-RPC/MCP transport.
- `src/logseq.ts`: parity-sensitive graph, tool, write-guard, and Git transaction implementation.
- `src/graph/properties.ts`: Logseq frontmatter parsing and emission.
- `src/graph/links.ts`: wikilink extraction and code-span filtering.
- `src/graph/write-guards.ts`: lockfile and atomic-write primitives.
- `src/graph/cache.ts`: persistent frontmatter and adjacency cache.
- `src/graph/watch.ts`: filesystem watcher invalidation.
- `src/tools/search.ts`: optional RE2-backed search regex compilation.
- `src/tool-schemas.ts`: strict MCP input schemas for every tool.

The current core keeps compatibility-sensitive graph behavior in one auditable
implementation while schemas, graph helpers, search behavior, cache handling,
watching, and public module entrypoints live in narrower modules.

## Troubleshooting

- Tools list but writes fail with `readonly`: remove `LOGSEQ_READONLY=1`.
- Writes fail with a dirty Git error: commit or stash existing graph edits, then retry.
- Unknown property keys fail: add the key to `pages/schema___properties.md`, use `force`, or change `LOGSEQ_VALIDATE_SCHEMA`.
- Dangling wikilinks fail: create target stubs first, pass `allow_dangling`, or change `LOGSEQ_VALIDATE_LINKS`.
- `regenerate_index` fails: by default it uses the built-in TypeScript index writer. If you intentionally enable a graph-provided `scripts/regenerate_graph_index.py`, set `LOGSEQ_ALLOW_EXTERNAL_REGEN=1` and ensure `LOGSEQ_PYTHON` can run it.
