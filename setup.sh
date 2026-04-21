#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "  ◧  SILO — Setup"
echo "  ────────────────"
echo ""

# 1. Check Node.js >= 18
if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install Node.js 18+ and retry."
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "  ✗ Node.js v${NODE_VER} detected. Silo requires Node.js 18+."
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

# 2. Check npm
if ! command -v npm &>/dev/null; then
  echo "  ✗ npm not found."
  exit 1
fi
echo "  ✓ npm $(npm -v)"

# 3. macOS: check Xcode CLI tools (needed for node-pty native compilation)
if [ "$(uname)" = "Darwin" ]; then
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    echo "  ✓ Apple Silicon arm64 detected"
  else
    echo "  ! Intel/Rosetta detected. Silo is optimized for Apple Silicon arm64."
  fi
  if ! xcode-select -p &>/dev/null; then
    echo "  ✗ Xcode Command Line Tools not installed."
    echo "    Run: xcode-select --install"
    exit 1
  fi
  echo "  ✓ Xcode CLI tools"
fi

# 4. Install dependencies
echo ""
echo "  Installing dependencies..."
if [ -x /opt/homebrew/bin/python3.11 ]; then
  PYTHON=/opt/homebrew/bin/python3.11 npm install
else
  npm install
fi
echo ""
echo "  ✓ Dependencies installed"

# 5. Detect AI CLIs
echo ""
echo "  AI tools detected:"
if command -v claude &>/dev/null; then
  echo "    ✓ claude (Claude Code)"
else
  echo "    · claude — not found"
fi
if command -v codex &>/dev/null; then
  echo "    ✓ codex (Codex CLI)"
else
  echo "    · codex — not found"
fi
if command -v ollama &>/dev/null; then
  echo "    ✓ ollama (local Gemma supervisor)"
  if ollama list 2>/dev/null | grep -qi "gemma4"; then
    echo "    ✓ gemma4 model installed"
  else
    echo "    · gemma4 model not found — run: ollama pull gemma4"
  fi
else
  echo "    · ollama — not found (install it for local-first supervision)"
fi

# 6. Done
echo ""
echo "  ────────────────"
echo "  ✓ Setup complete. Run:"
echo ""
echo "    npm start"
echo ""
