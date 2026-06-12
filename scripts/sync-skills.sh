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

# Copy mode: explicit COPY_MODE=1, or Git Bash on MSYS with project under OneDrive (path-based).
USE_COPY=0
if [[ "${COPY_MODE:-}" == "1" ]] || [[ "${OSTYPE:-}" == msys* && "$PROJECT_DIR" == *OneDrive* ]]; then
  USE_COPY=1
fi

echo "🔄 Syncing EightForge shared skills..."
echo "Project: $PROJECT_DIR"
echo "Skills repo: $SKILLS_REPO_DIR"
if [[ "$USE_COPY" -eq 1 ]]; then
  echo "Mode: copy (COPY_MODE or OneDrive/MSYS project path)"
else
  echo "Mode: symlink"
fi

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
  if [ -n "$(git -C "$SKILLS_REPO_DIR" remote)" ]; then
    echo "⬇️  Pulling latest skills..."
    git -C "$SKILLS_REPO_DIR" pull --ff-only
  else
    echo "⏭️  Skipping git pull (no remotes configured in skills repo)."
  fi
fi

lock_hint() {
  echo "   It may be locked by Cursor, Explorer, or OneDrive. Close those and retry."
}

remove_link_or_path() {
  local link="$1"
  if [ -L "$link" ]; then
    if ! rm -f "$link"; then
      echo "❌ Could not remove symlink: $link"
      lock_hint
      exit 1
    fi
  elif [ -e "$link" ]; then
    echo "⚠️  Existing path is not a symlink: $link"
    echo "   Backing it up to: $link.backup"
    rm -rf "$link.backup" 2>/dev/null || true
    if ! mv "$link" "$link.backup"; then
      echo "❌ Could not move aside: $link"
      lock_hint
      exit 1
    fi
  fi
}

create_symlink() {
  local target="$1"
  local link="$2"
  local parent

  parent="$(dirname "$link")"
  mkdir -p "$parent"

  remove_link_or_path "$link"

  if ! ln -sfn "$target" "$link"; then
    echo "❌ Could not create symlink: $link -> $target"
    lock_hint
    exit 1
  fi
  echo "🔗 $link -> $target"
}

copy_skills_tree() {
  local target="$1"
  local link="$2"
  local parent

  parent="$(dirname "$link")"
  mkdir -p "$parent"

  if [ -L "$link" ]; then
    if ! rm -f "$link"; then
      echo "❌ Could not remove symlink: $link"
      lock_hint
      exit 1
    fi
  elif [ -e "$link" ]; then
    if ! rm -rf "$link"; then
      echo "❌ Could not remove existing path for copy: $link"
      lock_hint
      exit 1
    fi
  fi

  mkdir -p "$link"
  cp -R "$target"/. "$link"/
  echo "📁 $link (copy of $target)"
}

sync_destination() {
  local target="$1"
  local link="$2"
  if [[ "$USE_COPY" -eq 1 ]]; then
    copy_skills_tree "$target" "$link"
  else
    create_symlink "$target" "$link"
  fi
}

sync_destination "$SKILLS_REPO_DIR" "$CENTRAL_SKILLS_LINK"
sync_destination "$CENTRAL_SKILLS_LINK" "$CODEX_SKILLS_LINK"
sync_destination "$CENTRAL_SKILLS_LINK" "$CURSOR_SKILLS_LINK"
sync_destination "$CENTRAL_SKILLS_LINK" "$PROJECT_AGENTS_SKILLS_LINK"

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
