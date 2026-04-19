#!/usr/bin/env bash
# Install or update the agents MCP server. Idempotent.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Piotr1215/agents-mcp-server/main/scripts/install.sh \
#     | bash -s -- --nats-url=nats://your-endpoint:4222
# On update, --nats-url is optional (existing URL is preserved).
set -euo pipefail

# Wrap in main so a truncated download can't execute partial code.
main() {
  local nats_url=""
  local install_dir="${AGENTS_MCP_DIR:-$HOME/.local/share/agents-mcp-server}"
  local repo_url="${AGENTS_MCP_REPO:-https://github.com/Piotr1215/agents-mcp-server.git}"
  local branch="${AGENTS_MCP_BRANCH:-main}"
  local claude_config="${HOME}/.claude.json"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --nats-url=*) nats_url="${1#*=}"; shift ;;
      --nats-url)   nats_url="${2:-}"; shift 2 ;;
      --dir=*)      install_dir="${1#*=}"; shift ;;
      --dir)        install_dir="${2:-}"; shift 2 ;;
      --help|-h)    usage; exit 0 ;;
      *)            echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
    esac
  done

  require_cmd git node npm duckdb jq

  local node_major
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if (( node_major < 18 )); then
    die "node >= 18 required (found $(node --version))"
  fi

  if [[ -d "$install_dir/.git" ]]; then
    echo "[install] updating $install_dir"
    git -C "$install_dir" fetch --quiet origin "$branch"
    git -C "$install_dir" checkout --quiet "$branch"
    git -C "$install_dir" pull --ff-only --quiet
  else
    echo "[install] cloning into $install_dir"
    mkdir -p "$(dirname "$install_dir")"
    git clone --quiet --branch "$branch" "$repo_url" "$install_dir"
  fi

  echo "[install] npm install (triggers prepare/tsc build)"
  (cd "$install_dir" && npm install --silent --no-audit --no-fund)

  local existing_url=""
  if [[ -f "$claude_config" ]]; then
    existing_url=$(jq -r '.mcpServers.agents.env.AGENTS_NATS_URL // empty' "$claude_config" 2>/dev/null || true)
  else
    echo '{}' > "$claude_config"
  fi

  if [[ -z "$nats_url" && -z "$existing_url" ]]; then
    die "--nats-url required on first install (share endpoint out-of-band)"
  fi

  local final_url="${nats_url:-$existing_url}"
  local backup="$claude_config.bak-$(date +%s)"
  cp "$claude_config" "$backup"

  local entrypoint="$install_dir/build/index.js"
  jq --arg path "$entrypoint" --arg url "$final_url" '
    .mcpServers //= {} |
    .mcpServers.agents = {
      command: "node",
      args: [$path],
      env: {AGENTS_NATS_URL: $url}
    }
  ' "$claude_config" > "$claude_config.tmp" && mv "$claude_config.tmp" "$claude_config"

  echo
  echo "done."
  echo "  install dir:   $install_dir"
  echo "  nats endpoint: $final_url"
  echo "  config backup: $backup"
  echo
  echo "next: /mcp reconnect in any active Claude session (or just relaunch claude)."
}

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "'$c' not found on PATH"
  done
}

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
install.sh — install or update agents-mcp-server

Usage:
  install.sh [--nats-url=<url>] [--dir=<path>]

Options:
  --nats-url=URL   NATS endpoint (required on first install)
  --dir=PATH       install location (default: ~/.local/share/agents-mcp-server)
  -h, --help       this help

Environment:
  AGENTS_MCP_DIR     overrides --dir
  AGENTS_MCP_REPO    override source repo URL
  AGENTS_MCP_BRANCH  override branch (default: main)

Prereqs:
  git, node >= 18, npm, duckdb, jq
EOF
}

main "$@"
