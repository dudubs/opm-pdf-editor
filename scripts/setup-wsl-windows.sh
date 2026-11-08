#!/usr/bin/env bash
# One-time setup in WSL (Ubuntu) to cross-compile the Windows Tauri app.
# Read scripts/wslconfig.example FIRST and cap WSL memory/CPU before running this.
set -euo pipefail
cd "$(dirname "$0")/.."

# Gentle on a low-spec machine: everything here runs niced with at most 2 jobs.
export CARGO_BUILD_JOBS=2
low() { nice -n 19 ionice -c3 "$@"; }

echo "==> apt packages (NSIS installer builder + LLVM toolchain for cargo-xwin)"
sudo apt-get update
sudo apt-get install -y --no-install-recommends nsis lld llvm clang curl unzip ca-certificates

echo "==> Bun"
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "==> Rust (minimal profile) + Windows MSVC target"
if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustup target add x86_64-pc-windows-msvc

echo "==> cargo-xwin (prebuilt binary via cargo-binstall; avoids a long local compile)"
if ! command -v cargo-xwin >/dev/null; then
  if ! command -v cargo-binstall >/dev/null; then
    curl -L --proto '=https' --tlsv1.2 -sSf \
      https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
  fi
  cargo binstall -y cargo-xwin || low cargo install --locked cargo-xwin
fi

echo "==> JS dependencies"
bun install

if [ ! -f src-tauri/icons/icon.ico ]; then
  echo "==> App icons (from src-tauri/app-icon.png)"
  bun --bun run tauri icon src-tauri/app-icon.png
fi

cat <<'EOF'

Done. Next:
  1. bun run build:pdfjs        (once; needs Docker)
  2. bun run tauri:build:win    (first build is slow; close heavy apps)
  3. bun run tauri:run:win      (copy + launch the .exe on Windows)
EOF
