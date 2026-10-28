#!/usr/bin/env bash
# render.sh — run render.py on the hardened GDS inside LibreLane's nix-shell (WSL)
set -euo pipefail
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
S="$(cd "$(dirname "$0")" && pwd)"
W=~/sa-render
LYP=$(find ~/.ciel -name sky130A.lyp | head -1)
mkdir -p "$W" && cp "$S/results/gds/systolic_array.gds" "$W/"
cd ~/librelane
nix-shell --run "klayout -zz -rd gds=$W/systolic_array.gds -rd lyp=$LYP -rd out=$W -r $S/render.py"
cp "$W"/*.png "$S/results/"
