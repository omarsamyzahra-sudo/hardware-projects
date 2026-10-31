#!/usr/bin/env bash
# render_tiled.sh — render the tiled top-level GDS with ../render.py (in WSL)
set -euo pipefail
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
S="$(cd "$(dirname "$0")" && pwd)"
RUN=~/systolic-tiled/openlane/tiled/top/runs/top
GDS=$(ls "$RUN"/final/gds/systolic_array.gds 2>/dev/null || ls "$RUN"/*-magic-streamout/systolic_array.gds)
W=~/sa-render-tiled
LYP=$(find ~/.ciel -name sky130A.lyp | head -1)
mkdir -p "$W" "$S/results" && cp "$GDS" "$W/"
cd ~/librelane
nix-shell --run "klayout -zz -rd gds=$W/systolic_array.gds -rd lyp=$LYP -rd out=$W -r $S/../render.py"
cp "$W"/*.png "$S/results/"
