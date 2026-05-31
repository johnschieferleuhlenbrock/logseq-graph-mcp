# Backlog

No open documentation-owned backlog items remain for the public TypeScript
Logseq MCP server.

## Completed

- Split reusable internals into narrower graph, guard, cache, watcher, and
  search modules:
  - `src/graph/properties.ts`
  - `src/graph/links.ts`
  - `src/graph/write-guards.ts`
  - `src/graph/cache.ts`
  - `src/graph/watch.ts`
  - `src/tools/search.ts`
- Added explicit tests for write lock timeout behavior.
- Added conditional case-only rename coverage for case-insensitive filesystems.
- Added an undo section documenting MCP checkpoint discovery and `git revert`.
- Added persistent frontmatter and full graph-adjacency caching.
- Added filesystem watcher invalidation for cross-process page edits.
- Added optional RE2-backed regex search with native fallback.
- Rechecked documentation for generic paths, public-safe language, and stable
  tool names.

## Validation

```sh
npm run typecheck
npm run build
npm test
```

The Node test suite covers the completed backlog items plus the existing parity
surface.
