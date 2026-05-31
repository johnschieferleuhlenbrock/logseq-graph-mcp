#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./install.sh --root /path/to/logseq

Options:
  --root PATH     Logseq graph root containing pages/
  -h, --help      Show this help

You can also set LOGSEQ_ROOT instead of passing --root.

Requires Node.js 20.17.0 or newer and npm. When run from a source checkout, this
installs dependencies and builds dist/. When run from an npm package, it uses
the packaged dist/cli.js.
EOF
}

ROOT="${LOGSEQ_ROOT:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Missing value for --root." >&2
        exit 64
      fi
      ROOT="$2"
      shift 2
      ;;
    --root=*)
      ROOT="${1#--root=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if [[ -z "$ROOT" ]]; then
  echo "Set LOGSEQ_ROOT=/path/to/logseq or pass --root." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20.17.0 or newer is required." >&2
  exit 1
fi

if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && (minor > 17 || (minor === 17 && patch >= 0))) ? 0 : 1)' >/dev/null 2>&1; then
  echo "Node.js 20.17.0 or newer is required; found $(node -v)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$ROOT" ]]; then
  echo "LOGSEQ_ROOT does not exist or is not a directory: $ROOT" >&2
  exit 1
fi

ROOT="$(cd "$ROOT" && pwd)"

if [[ ! -d "$ROOT/pages" ]]; then
  echo "pages/ not found under LOGSEQ_ROOT: $ROOT" >&2
  exit 1
fi

cd "$SCRIPT_DIR"

if [[ -f "tsconfig.json" && -d "src" ]]; then
  if [[ -f "package-lock.json" ]]; then
    npm ci
  else
    npm install
  fi
  npm run build
elif [[ ! -f "dist/cli.js" ]]; then
  echo "dist/cli.js not found and source files are unavailable; reinstall the package or use a source checkout." >&2
  exit 1
fi

echo
echo "Local smoke command:"
echo "  LOGSEQ_ROOT=\"$ROOT\" node \"$SCRIPT_DIR/dist/cli.js\""
echo
echo "Claude Desktop development config:"
cat <<JSON
{
  "mcpServers": {
    "logseq": {
      "command": "node",
      "args": ["$SCRIPT_DIR/dist/cli.js", "--root", "$ROOT"]
    }
  }
}
JSON
