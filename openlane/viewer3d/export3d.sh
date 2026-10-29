#!/usr/bin/env bash
# export3d.sh — export the 3D scenes: the PE tile, a close-up, the tiled array (in WSL)
set -euo pipefail
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
S="$(cd "$(dirname "$0")" && pwd)"
GDS=~/systolic-tiled/openlane/tiled/pe/runs/pe/final/gds/pe.gds
W=~/sa-3d
mkdir -p "$W" && cp "$GDS" "$W/pe.gds"
cp ~/systolic-tiled/openlane/tiled/top/runs/top/final/gds/systolic_array.gds "$W/array.gds"
cd ~/librelane
nix-shell --run "klayout -zz -rd gds=$W/pe.gds -rd out=$W/pe_tile.json \
    -rd layers=met1,via,met2,via2,met3,via3,met4 -r $S/export3d.py && \
  klayout -zz -rd gds=$W/pe.gds -rd out=$W/pe_closeup.json -rd box=82,82,98,98 \
    -rd layers=nwell,diff,tap,poly,licon,li1,mcon,met1,via,met2,via2,met3,via3,met4 -r $S/export3d.py &&   klayout -zz -rd gds=$W/array.gds -rd out=$W/pe_array.json     -rd layers=met4,via4,met5 -r $S/export3d.py"
mkdir -p "$S/data" && cp "$W"/pe_*.json "$S/data/"
ls -la "$S/data"
