# Contributing

Thanks for helping keep this project useful, local-first, and safe for public
reuse.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Tests create temporary Logseq graphs and must not use a real graph.

## Scope

- Keep changes small and reviewable.
- Preserve the documented MCP tool names and response shape unless a breaking
  change is intentional and clearly documented.
- Prefer generic examples that work for any Logseq graph.
- Do not commit generated output such as `dist/`, `node_modules/`, caches, or
  local graph data.

## Safety Rules

- Mutating tools must check `LOGSEQ_READONLY` before touching files.
- Writes must use lockfiles and atomic temp-file replacement.
- Changes that touch graph data must be covered by temp-graph tests.
- Do not add user-specific paths, graph contents, screenshots, or machine-specific defaults.

## Documentation Rules

- Use `/path/to/logseq-graph` for placeholder graph paths.
- Avoid references to non-public workflows, sensitive graph structure, or local
  machine names.
- Keep install instructions valid for a clean clone and a published npm package.
- Separate local-only guarantees from claims that would require deployment,
  network, compliance, or managed-service controls.

## Pull Request Checklist

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- New behavior is documented when it changes public use, configuration, safety,
  or tool payloads.
