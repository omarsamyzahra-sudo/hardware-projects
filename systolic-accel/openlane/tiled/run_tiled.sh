#!/usr/bin/env bash
# run_tiled.sh — hierarchical hardening: one PE macro, then 64 of them on a grid
#
#   bash openlane/tiled/run_tiled.sh [all|pe|top]      (inside WSL)
#
# Stage 1 hardens pe (met1-met4 only, so the top can strap power on met5).
# Stage 2 places 64 copies at fixed grid locations and hardens systolic_array
# around them. Work happens in ~/systolic-tiled (OneDrive is slow); reports,
# metrics and renders come back to openlane/tiled/results/.
set -euo pipefail
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
T="$SRC/openlane/tiled"
W=~/systolic-tiled
stage=${1:-all}                 # all | pe | top (top reuses the last PE run)
[[ $stage == top ]] || rm -rf "$W"
mkdir -p "$W/rtl" "$W/openlane/tiled"
cp "$SRC"/rtl/pe.sv "$SRC"/rtl/systolic_array.sv "$W/rtl/"
cp -r "$T/pe" "$T/top" "$W/openlane/tiled/"
cd ~/librelane

if [[ $stage == all || $stage == pe ]]; then
    nix-shell --run "librelane --run-tag pe --overwrite $W/openlane/tiled/pe/config.json"
fi
PF="$W/openlane/tiled/pe/runs/pe/final"
M="$W/openlane/tiled/top/macro"
mkdir -p "$M"
cp "$PF/gds/pe.gds" "$PF/lef/pe.lef" "$PF/nl/pe.nl.v" "$M/"
cp "$PF"/lib/*/pe__*.lib "$M/"
for c in min nom max; do cp "$PF/spef/$c/pe.$c.spef" "$M/"; done

if [[ $stage == all || $stage == top ]]; then
    python3 "$W/openlane/tiled/top/make_config.py"
    # exits non-zero on the deferred input-port hold check; keep going to collect results
    nix-shell --run "librelane --run-tag top --overwrite $W/openlane/tiled/top/config.json" || true
fi

OUT="$T/results"
mkdir -p "$OUT"
cp "$PF/metrics.json" "$OUT/pe_metrics.json"
TF="$W/openlane/tiled/top/runs/top/final"
cp "$TF/metrics.json" "$OUT/top_metrics.json"
head -120 "$W/openlane/tiled/top/runs/top/"*-openroad-stapostpnr/max_ss_100C_1v60/min.rpt > "$OUT/hold_worst_max_ss.rpt"
bash "$T/render_tiled.sh"
echo "done"
