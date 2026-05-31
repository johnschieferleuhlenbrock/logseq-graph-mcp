# Compatibility and Parity

This document tracks the public behavior that should remain stable as the
implementation evolves.

## Tool Surface

Read:

- `list_pages`
- `read_page`
- `read_pages`
- `read_journal`
- `search`
- `backlinks`
- `query_pages`
- `graph_status`

Write:

- `update_property`
- `batch_update_property`
- `delete_property`
- `append_contact_log`
- `append_journal_bullet`
- `create_stub`
- `rename_page`
- `delete_page`
- `update_body_section`

Analysis and meta:

- `find_orphans`
- `find_low_degree`
- `find_hubs`
- `node_degree`
- `graph_stats`
- `find_components`
- `find_dangling_links`
- `regenerate_index`

## Safety Behavior

- `LOGSEQ_READONLY=1` blocks mutations before file access.
- Schema validation supports `block`, `warn`, and `off`.
- `LOGSEQ_DISALLOW_FORCE=1` rejects forced schema bypass.
- Dangling wikilink validation supports `block`, `warn`, and `off`.
- Git guard supports `strict`, `warn`, and `off`.
- Writes use lockfiles and atomic temp-file replacement.
- Writes re-read target files inside the lock.
- Soft delete archives pages instead of hard deleting them.
- Rename leaves redirect stubs by default.
- Successful writes audit to today's journal.
- Response-size caps, path traversal checks, and symlink edit refusal are preserved.
- Stdio transport remains local-only and does not bind a network port.
- Search responses include an additive `regex_engine` field.
- `graph_status` includes additive cache metadata.

## Index Compatibility

- `regenerate_index` preserves opt-in compatibility with graphs that already
  ship `scripts/regenerate_graph_index.py`, using `LOGSEQ_ALLOW_EXTERNAL_REGEN=1`
  plus `LOGSEQ_PYTHON` or `python3`.
- Generic graphs without that script now use the built-in TypeScript index
  writer and still produce `generated/graph_index.json`.

## Validation

Current validation:

```sh
npm run typecheck
npm test
npm run build
```

The Node test suite uses temporary Git-backed Logseq graphs and includes stdio
initialize plus `tools/list` smoke coverage.
