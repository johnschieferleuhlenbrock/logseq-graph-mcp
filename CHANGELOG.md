# Changelog

All notable changes to this package will be documented in this file.

This project follows semantic versioning.

## 0.1.2 - 2026-05-31

- Keep MCP `initialize` server metadata in sync with the package version.
- Add release smoke coverage for `serverInfo.version`.

## 0.1.1 - 2026-05-31

- Use a static MIT badge in the npm-rendered README to avoid npm badge cache
  lag.
- Derive release smoke version expectations from `package.json`.

## 0.1.0 - 2026-05-31

- Initial TypeScript Logseq MCP server.
- Local stdio transport with read, write, analysis, and index tools.
- Read-only mode, schema validation, dangling-link validation, lockfiles,
  atomic writes, response caps, and Git guard checkpointing.
- npm package, CI, release workflow, SBOM generation, Dependabot, CodeQL, and
  client examples for Codex, ChatGPT, and Claude Desktop.
