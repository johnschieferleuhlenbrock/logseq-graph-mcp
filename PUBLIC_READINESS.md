# Public Readiness Report

This checklist records the repository state expected for a public, local-first
TypeScript MCP package.

## Ready for Public Use

- Package is npm-installable with `package.json`, `tsconfig.json`, `bin`, and
  build/test/typecheck scripts.
- Runtime defaults are generic and accept any `LOGSEQ_ROOT` or `--root` graph.
- No user-specific graph path is required by the server.
- No network listener is present.
- Tests use temporary fixture graphs rather than a user's real graph.
- README, install script, security policy, contribution guide, and environment
  example are generic.
- Example client configurations cover Codex, ChatGPT, and Claude Desktop with
  placeholder graph paths only.
- Dependabot and release workflows are configured for GitHub-hosted automation.
- Dependency review and SBOM workflows are configured for pre-public
  supply-chain checks.
- CodeQL is configured and will run automatically after the repository is
  public. Running CodeQL while the repository is private requires GitHub
  Advanced Security for private repositories.
- Strict MCP input schemas are defined for every tool.
- `regenerate_index` uses the built-in TypeScript index writer by default, and
  graph-provided Python regenerators require explicit opt-in.
- Persistent frontmatter and adjacency caching is implemented outside the graph
  directory.
- File watcher invalidation is implemented and can be disabled with
  `LOGSEQ_WATCH=0`.
- Optional RE2-backed regex search is supported when the `re2` package is
  installed and covered with an isolated optional-module test.
- Documentation distinguishes local subprocess safety controls from any
  deployment, authentication, compliance, or managed-service claims.

## Local Generated Files

The following may exist after local validation and should not be committed:

- `node_modules/`
- `dist/`
- `*.tgz`
- `pack.json`
- `sbom.*.json`

They are ignored by `.gitignore`. Recreate dependencies and build output with
`npm install` and `npm run build`.

## Publication Notes

- Keep the published package focused on source-built runtime artifacts,
  examples, README, license, and security policy.
- Do not publish user graphs, local caches, generated indexes, screenshots,
  or machine-specific configuration.
- Re-run validation in a clean checkout before tagging or publishing.

## Remaining Gaps

No known public-readiness blockers remain for this local npm package.

Optional future refinements:

- Replace the built-in permissive runtime argument coercion with generated
  runtime validators from the MCP schemas if client-side schema enforcement is
  not sufficient.
- Split additional read/write tool methods out of the parity core if the
  project grows enough that smaller files are worth the extra indirection.
