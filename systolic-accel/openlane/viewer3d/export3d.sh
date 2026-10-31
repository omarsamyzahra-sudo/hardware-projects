#!/usr/bin/env bash
# export3d.sh — export the data behind the 3D viewer (in WSL, after run_tiled.sh)
#
#   pe_tile.json   every layer of the PE macro, diffusion to met4
#   pe_array.json  the top level's own metal, with the 64 PE footprints cut
#                  out of met1-met4 (the viewer instances pe_tile there)
#   cells_*.json   footprint and role of every placed cell (cells3d.py)
set -euo pipefail
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
S="$(cd "$(dirname "$0")" && pwd)"
R=~/systolic-tiled/openlane/tiled
W=~/sa-3d
LEF=$(find ~/.ciel -path "*sky130A/libs.ref/sky130_fd_sc_hd/lef/sky130_fd_sc_hd.lef" | head -1)
mkdir -p "$W"
cp "$R/pe/runs/pe/final/gds/pe.gds" "$W/pe.gds"
cp "$R/top/runs/top/final/gds/systolic_array.gds" "$W/array.gds"

cd ~/librelane
nix-shell --run "klayout -zz -rd gds=$W/pe.gds -rd out=$W/pe_tile.json \
    -rd layers=nwell,diff,tap,poly,licon,li1,mcon,met1,via,met2,via2,met3,via3,met4 -r $S/export3d.py && \
  klayout -zz -rd gds=$W/array.gds -rd out=$W/pe_array.json \
    -rd layers=met1,via,met2,via2,met3,via3,met4,via4,met5 \
    -rd grid=8,120,220,180 -rd cut=met1,via,met2,via2,met3,via3,met4 -r $S/export3d.py"
python3 "$S/cells3d.py" "$LEF" "$R/pe/runs/pe/final/def/pe.def" \
    "$R/top/runs/top/final/def/systolic_array.def" "$W"

mkdir -p "$S/data"
rm -f "$S/data/pe_closeup.json"
cp "$W"/pe_tile.json "$W"/pe_array.json "$W"/cells_pe.json "$W"/cells_top.json "$S/data/"
ls -la "$S/data"
