#!/usr/bin/env bash
# Cross-compile the Windows .exe (no installer) from WSL with limited CPU/memory.
#
# Tunables (env): CARGO_BUILD_JOBS (default 2), MEM_MAX (default 4G), CPU_QUOTA (default 200%)
# Extra args are passed to `tauri build` (e.g. --debug for a faster, unoptimised build).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.bun/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
MEM_MAX="${MEM_MAX:-4G}"
CPU_QUOTA="${CPU_QUOTA:-200%}"

for tool in bun cargo cargo-xwin makensis; do
  command -v "$tool" >/dev/null || { echo "Missing '$tool'. Run scripts/setup-wsl-windows.sh first." >&2; exit 1; }
done
[ -d vendor/pdfjs/build/dist ] || { echo "Missing vendor/pdfjs/build/dist. Run 'bun run build:pdfjs' first." >&2; exit 1; }

cmd=(bun --bun run tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle "$@")
low=(nice -n 19 ionice -c3)

# Hard cgroup cap when systemd is available (WSL: systemd=true in /etc/wsl.conf).
if command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  echo "Building with MemoryMax=$MEM_MAX CPUQuota=$CPU_QUOTA jobs=$CARGO_BUILD_JOBS (niced)"
  exec systemd-run --user --scope --quiet \
    -p "MemoryMax=$MEM_MAX" -p "CPUQuota=$CPU_QUOTA" \
    "${low[@]}" "${cmd[@]}"
fi

echo "systemd user session not available: no hard cap, only nice + jobs=$CARGO_BUILD_JOBS."
echo "Cap WSL itself via .wslconfig (see scripts/wslconfig.example)."
exec "${low[@]}" "${cmd[@]}"
