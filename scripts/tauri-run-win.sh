#!/usr/bin/env bash
# Copy the cross-compiled .exe to the Windows desktop and launch it (no install needed;
# requires the WebView2 runtime, which ships with Windows 11).
set -euo pipefail
cd "$(dirname "$0")/.."

exe="${STAGE_WSL:-/mnt/c/dev/opm-pdf-editor-win}/src-tauri/target/release/opm-pdf-editor.exe"
[ -f "$exe" ] || exe="src-tauri/target/x86_64-pc-windows-msvc/release/opm-pdf-editor.exe"
[ -f "$exe" ] || { echo "Missing $exe. Run 'bun run tauri:build:win' first." >&2; exit 1; }

user="$(cd /mnt/c && cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')"
dest="/mnt/c/Users/$user/Desktop/opm-pdf-editor.exe"
cp -f "$exe" "$dest"
echo "Copied to $dest"
cd /mnt/c && cmd.exe /c start "" "$(wslpath -w "$dest")"
