#!/usr/bin/env bash
# ================================================
# EightForge Shared Skills Sync Script
# Syncs shared EightForge skills for Cursor, Codex, and repo-level agents.
# ================================================

set -euo pipefail

SKILLS_REPO_DIR="${EIGHTFORGE_SKILLS_REPO:-$HOME/eightforge-skills}"
CENTRAL_AGENTS_DIR="$HOME/.agents"
CENTRAL_SKILLS_LINK="$CENTRAL_AGENTS_DIR/skills"
CODEX_DIR="$HOME/.codex"
CODEX_SKILLS_LINK="$CODEX_DIR/skills"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURSOR_DIR="$PROJECT_DIR/.cursor"
CURSOR_SKILLS_LINK="$CURSOR_DIR/skills"
PROJECT_AGENTS_DIR="$PROJECT_DIR/.agents"
PROJECT_AGENTS_SKILLS_LINK="$PROJECT_AGENTS_DIR/skills"

echo "🔄 Syncing EightForge shared skills..."
echo "Project: $PROJECT_DIR"
echo "Skills repo: $SKILLS_REPO_DIR"

if [ ! -d "$SKILLS_REPO_DIR" ]; then
  echo "❌ Skills repo not found: $SKILLS_REPO_DIR"
  echo ""
  echo "Create it first, for example:"
  echo "  cd ~"
  echo "  git clone <your-eightforge-skills-repo-url> eightforge-skills"
  echo ""
  echo "Or set EIGHTFORGE_SKILLS_REPO:"
  echo "  EIGHTFORGE_SKILLS_REPO=/path/to/eightforge-skills ./scripts/sync-skills.sh"
  exit 1
fi

if [ ! -d "$SKILLS_REPO_DIR/.git" ]; then
  echo "⚠️  Skills repo exists but is not a git repo: $SKILLS_REPO_DIR"
else
  echo "⬇️  Pulling latest skills..."
  git -C "$SKILLS_REPO_DIR" pull --ff-only
fi

create_symlink() {
  local target="$1"
  local link="$2"
  local parent

  parent="$(dirname "$link")"
  mkdir -p "$parent"

  if [ -L "$link" ]; then
    rm -f "$link"
  elif [ -e "$link" ]; then
    echo "⚠️  Existing path is not a symlink: $link"
    echo "   Backing it up to: $link.backup"
    rm -rf "$link.backup"
    mv "$link" "$link.backup"
  fi

  ln -sfn "$target" "$link"
  echo "🔗 $link -> $target"
}

create_symlink "$SKILLS_REPO_DIR" "$CENTRAL_SKILLS_LINK"
create_symlink "$CENTRAL_SKILLS_LINK" "$CODEX_SKILLS_LINK"
create_symlink "$CENTRAL_SKILLS_LINK" "$CURSOR_SKILLS_LINK"
create_symlink "$CENTRAL_SKILLS_LINK" "$PROJECT_AGENTS_SKILLS_LINK"

echo ""
echo "✅ EightForge skills synced."
echo ""
echo "Locations:"
echo "  Source of truth: $SKILLS_REPO_DIR"
echo "  Shared agents:  $CENTRAL_SKILLS_LINK"
echo "  Codex:          $CODEX_SKILLS_LINK"
echo "  Cursor:         $CURSOR_SKILLS_LINK"
echo "  Repo agents:    $PROJECT_AGENTS_SKILLS_LINK"
echo ""
echo "Tip:"
echo "  If Cursor or Codex was already open, restart/reload the agent session so it sees new skills."
