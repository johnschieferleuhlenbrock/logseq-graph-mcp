# Security Policy

This server is designed for local stdio MCP use against a Logseq markdown graph.
It runs with the filesystem permissions of the user who starts the MCP client.

## Supported Use

- Run it as a local subprocess from an MCP client.
- Point it at a graph root containing `pages/` and optionally `journals/`.
- Keep `LOGSEQ_GIT_GUARD=strict` and `LOGSEQ_VALIDATE_SCHEMA=block` for write-capable agents.
- Keep `LOGSEQ_WRITE_MODE=intent` for normal agent sessions. Use `LOGSEQ_WRITE_MODE=admin_raw`
  only for local admin/debug work that intentionally bypasses the durable intent layer.
- Use `LOGSEQ_READONLY=1` for audit, review, or untrusted agent sessions.
- Review `graph_status` before enabling writes in a new graph or automation.

## Non-Goals

- It does not bind a network port.
- It is not an authentication gateway.
- It should not be exposed as a remote service without a separate threat model.
- It does not replace operating-system permissions, endpoint controls, backups,
  or repository access controls.

## Security Controls

- Mutating tools honor `LOGSEQ_READONLY=1` before file access.
- Write operations use lockfiles, atomic replacement, and path traversal checks.
- Symlink escapes are rejected for edits.
- Git guard can require a clean graph and creates checkpoint commits for
  successful writes.
- Durable write intents require idempotency keys, persist outside the graph,
  and are flushed only by explicit intent ID.
- Response-size and search limits reduce accidental over-exposure through tool
  responses.
- Graph-provided external index regeneration scripts are disabled by default and
  require `LOGSEQ_ALLOW_EXTERNAL_REGEN=1`.
- Diagnostics are written to local stderr only.

## Responsible Disclosure

Report vulnerabilities confidentially through GitHub private vulnerability
reporting or a draft security advisory when that feature is enabled for the
repository. If the hosting platform path is unavailable, contact the maintainer
before public disclosure.

## Reporting Issues

Include:

- Affected package version or commit.
- Reproduction steps and expected impact.
- Relevant environment variables.
- Whether the issue requires write access or a crafted graph.
- Any logs or tool responses needed to reproduce the issue, with sensitive graph
  content removed.
