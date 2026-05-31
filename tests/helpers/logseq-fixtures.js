import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LogseqServer } from "../../dist/logseq.js";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

export function writePage(root, name, content) {
  fs.writeFileSync(path.join(root, "pages", `${name}.md`), content.replace(/^\n/, ""), "utf8");
}

export function makeGraph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-"));
  fs.mkdirSync(path.join(root, "pages"));
  fs.mkdirSync(path.join(root, "journals"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "generated"));
  fs.mkdirSync(path.join(root, "data"));
  writePage(root, "schema___properties", `
type:: schema

- \`type::\`
- \`status::\`
- \`last-contacted::\`
- \`confidence::\`
- \`source::\`
- \`org-type::\`
- \`redirects-to::\`
`);
  writePage(root, "Alice", "type:: person\nstatus:: active\nlast-contacted:: 2026-05-01\n\n- hello\n");
  writePage(root, "Bad Date", "type:: person\nstatus:: active\nlast-contacted:: never\n\n- hello\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "*.md.lock\n.mcp-git-guard.lock\n__pycache__/\n*.py[cod]\n", "utf8");
  run("git", ["init", "-b", "main", "-q"], root);
  run("git", ["config", "user.name", "Test User"], root);
  run("git", ["config", "user.email", "test@example.invalid"], root);
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "baseline"], root);
  return root;
}

export function server(root, env = {}) {
  return new LogseqServer({
    root,
    env: {
      ...process.env,
      LOGSEQ_ROOT: root,
      LOGSEQ_GIT_GUARD: "strict",
      LOGSEQ_VALIDATE_SCHEMA: "block",
      LOGSEQ_MAX_RESPONSE_BYTES: "500000",
      ...env,
    },
  });
}

export function status(root) {
  return run("git", ["status", "--short"], root);
}

export function isCaseInsensitiveDir(dir) {
  const probe = path.join(dir, `.case-probe-${process.pid}`);
  fs.writeFileSync(probe, "x", "utf8");
  try {
    return fs.existsSync(probe.toUpperCase());
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
