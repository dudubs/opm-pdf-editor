#!/usr/bin/env bash
# Build the Windows (NSIS) installer using the *Windows* Rust toolchain, driven from WSL.
# Dev stays in WSL/Bun; only the Rust compile runs on Windows (via powershell.exe interop).
#
# Produces the NSIS installer (BUNDLE=none for just the exe). Steps: bun build in WSL -> stage the inputs on the Windows disk -> cargo/tauri on Windows
# (BelowNormal priority, 2 jobs) -> exe under $STAGE/src-tauri/target/release.
#
# Requires on Windows: rustup with a recent `stable` toolchain (not changed as default),
# VS Build Tools (C++), Node/npm, WebView2. Tunables: STAGE_WSL, CARGO_BUILD_JOBS.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"

STAGE_WSL="${STAGE_WSL:-/mnt/c/dev/opm-pdf-editor-win}"
JOBS="${CARGO_BUILD_JOBS:-2}"
BUNDLE="${BUNDLE:-nsis}"   # "nsis" = installer; "none" = exe only

echo "==> Web build (bun, desktop: PDFium editor only)"
bun run build:desktop

echo "==> Staging into $STAGE_WSL (keeps src-tauri/target for incremental builds)"
mkdir -p "$STAGE_WSL/dist"
rm -rf "$STAGE_WSL/dist/public" "$STAGE_WSL/dist/desktop"
cp -a dist/desktop "$STAGE_WSL/dist/desktop"
tar --exclude=src-tauri/target --exclude=src-tauri/gen \
    --exclude=src-tauri/icons/android --exclude=src-tauri/icons/ios \
    -cf - src-tauri .cargo | tar -C "$STAGE_WSL" -xf -
# The web build already ran in WSL; Windows has no bun.
sed -i 's|"beforeBuildCommand": "[^"]*"|"beforeBuildCommand": ""|; s|"beforeDevCommand": "[^"]*"|"beforeDevCommand": ""|' \
  "$STAGE_WSL/src-tauri/tauri.conf.json"
printf '{ "private": true, "devDependencies": { "@tauri-apps/cli": "^2" } }\n' > "$STAGE_WSL/package.json"

cat > "$STAGE_WSL/build.ps1" <<EOF
\$ErrorActionPreference = "Stop"
(Get-Process -Id \$PID).PriorityClass = "BelowNormal"
\$env:RUSTUP_TOOLCHAIN = "stable"
\$env:CARGO_BUILD_JOBS = "$JOBS"
Set-Location \$PSScriptRoot
if (-not (Test-Path "node_modules\\.bin\\tauri.cmd")) { npm install --no-audit --no-fund }
rustc -V
if ("$BUNDLE" -eq "none") { & "node_modules\\.bin\\tauri.cmd" build --no-bundle } else { & "node_modules\\.bin\\tauri.cmd" build --bundles $BUNDLE }
if (\$LASTEXITCODE -ne 0) { exit \$LASTEXITCODE }
EOF

echo "==> Building on Windows (first run is slow: downloads and compiles the Tauri crates)"
cd /mnt/c
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$STAGE_WSL/build.ps1")"

echo "==> Done"
ls -la "$STAGE_WSL"/src-tauri/target/release/*.exe "$STAGE_WSL"/src-tauri/target/release/bundle/nsis/*.exe 2>/dev/null || true
