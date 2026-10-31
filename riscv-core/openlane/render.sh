#!/usr/bin/env bash
# render.sh — KLayout die shots of the hardened core (WSL, LibreLane's nix-shell)
set -euo pipefail
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
S="$(cd "$(dirname "$0")" && pwd)"
W=~/cpu-render
LYP=$(find ~/.ciel -name sky130A.lyp | head -1)
mkdir -p "$W" && cp "$S/results/gds/core.gds" "$W/"
cd ~/librelane
nix-shell --run "klayout -zz -rd gds=$W/core.gds -rd lyp=$LYP -rd out=$W -r $S/render.py"
cp "$W"/*.png "$S/results/"
