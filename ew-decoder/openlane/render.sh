#!/usr/bin/env bash
# render.sh decoder|engine — KLayout die shots of a hardened block (WSL, LibreLane's nix-shell)
set -euo pipefail
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
S="$(cd "$(dirname "$0")" && pwd)"
NAME=$1
GDS=$(ls "$S/$NAME/results/gds/"*.gds | head -1)
W=~/ew-render/$NAME
LYP=$(find ~/.ciel -name sky130A.lyp | head -1)
mkdir -p "$W" && cp "$GDS" "$W/"
cd ~/librelane
nix-shell --run "klayout -zz -rd gds=$W/$(basename "$GDS") -rd lyp=$LYP -rd out=$W -r $S/render.py"
cp "$W"/*.png "$S/$NAME/results/"
