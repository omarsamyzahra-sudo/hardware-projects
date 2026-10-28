#!/usr/bin/env bash
# run.sh — harden the 8x8 systolic array on SKY130 with LibreLane (in WSL)
#
#   bash openlane/run.sh          (from systolic-accel/, inside WSL)
#
# Copies the RTL and config to ~/systolic-openlane (OneDrive is slow and
# locks files), runs the classic flow in LibreLane's nix-shell, and copies
# the reports, final GDS and a summary back to openlane/results/.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=~/systolic-openlane
LL=~/librelane
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

rm -rf "$WORK" && mkdir -p "$WORK/openlane" "$WORK/rtl"
cp "$SRC"/rtl/pe.sv "$SRC"/rtl/systolic_array.sv "$WORK/rtl/"
cp "$SRC"/openlane/config.json "$WORK/openlane/"

cd "$LL"
nix-shell --run "librelane --run-tag sa8 --overwrite $WORK/openlane/config.json"

RUN="$WORK/openlane/runs/sa8"
OUT="$SRC/openlane/results"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$RUN"/final/metrics.json "$OUT/" 2>/dev/null || true
cp -r "$RUN"/final/gds "$OUT/" 2>/dev/null || true
find "$RUN" -name '*.rpt' -path '*sta*' -exec cp {} "$OUT/" \; 2>/dev/null || true
python3 - "$OUT/metrics.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
pick = lambda *ks: next((m[k] for k in ks if k in m), None)
period = 20.0
ws = pick("timing__setup__ws", "timing__setup__ws__corner:nom_tt_025C_1v80")
print("die area um^2       ", pick("design__die__area"))
print("core area um^2      ", pick("design__core__area"))
print("std cells           ", pick("design__instance__count__stdcell", "design__instance__count"))
print("setup WNS ns (worst)", ws)
if ws is not None:
    print("fmax MHz (approx)   ", round(1000 / (period - ws), 1))
print("power W (total)     ", pick("power__total"))
print("DRC errors          ", pick("route__drc_errors", "magic__drc_error__count"))
print("LVS errors          ", pick("design__lvs_error__count"))
PY
