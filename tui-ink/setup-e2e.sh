#!/usr/bin/env bash
# setup-e2e.sh — install system dependencies required for E2E tests
# Run once before `npm run test:e2e`

set -euo pipefail

echo "==> Checking for tmux..."
if command -v tmux &>/dev/null; then
  echo "    tmux $(tmux -V | cut -d' ' -f2) already installed"
else
  echo "    tmux not found — installing..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y tmux
  elif command -v brew &>/dev/null; then
    brew install tmux
  else
    echo "ERROR: Cannot install tmux automatically. Install it manually:"
    echo "  sudo apt install tmux   # Debian/Ubuntu"
    echo "  brew install tmux       # macOS"
    exit 1
  fi
  echo "    tmux $(tmux -V | cut -d' ' -f2) installed"
fi

echo "==> Checking for node_modules..."
if [ ! -d node_modules ]; then
  echo "    Running npm ci..."
  npm ci
fi

echo ""
echo "All E2E prerequisites satisfied."
echo "Run tests with:"
echo "  npm run test:e2e:smoke       # fast UI tests (~2 min)"
echo "  npm run test:e2e:regression  # bug regression tests (~5 min)"
echo "  npm run test:e2e:agent       # agent pipeline tests (~5 min)"
echo "  npm run test:e2e             # all of the above"
echo "  npm run test:e2e:stability   # long-running stability tests (~10 min)"
