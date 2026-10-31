#!/usr/bin/env bash
# run.sh — harden one SIMT core (one "SM") on SKY130 with LibreLane (in WSL)
#
#   bash openlane/run.sh          (from simt-gpu/, inside WSL)
#
# The core is everything in simt_core.sv: scheduler, fetch/decode, 8 lane
# ALUs with multipliers, the 32-thread register file (as flops) and the LSU.
# Instruction memory and global memory stay outside, where a real chip
# would use SRAM macros. Work happens in ~/gpu-openlane (OneDrive is slow
# and locks files); metrics, reports, the GDS and the placed DEF come back
# to openlane/results/.
#
# The mid-flow STA reports are skipped: before the resizer buffers the
# register file's select nets (fanout up to ~9k), nearly every endpoint
# violates and listing them took over an hour per report. The resizer
# steps time the design themselves, and the full signoff STA still runs.
#
# Post-CTS timing repair is off too (config.json). The core can't make the
# 20 ns target: the worst register-to-register path picks a warp (alive ->
# pick) and then finds the minimum PC over that warp's lanes to build the
# fetch mask (f_mask), all in one cycle, about 39 ns at the typical corner
# after CTS. With 33k endpoints failing, the resizer gained 7 ns in an
# hour. The clock stays at 20 ns; fmax comes from the slack.
#
# The die is sized for 25% utilization (was 45%). At 45% global routing
# failed after ~8 h with met2 at 99.5% and ~272k overflow: the flop register
# file's read muxes are wire-hungry, and the slew repair added ~65k buffers
# on its high-fanout select nets (those stay; they fix real slew violations).
# GRT_ALLOW_CONGESTION lets detailed routing try to clean up what overflow
# is left; any that remains shows up as DRC errors in the final metrics.
#
#   bash openlane/run.sh OpenROAD.RepairDesignPostGPL   resumes the last run
#                                                       from that step
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=~/gpu-openlane
LL=~/librelane
FROM="${1:-}"
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

if [ -z "$FROM" ]; then
    rm -rf "$WORK" && mkdir -p "$WORK/openlane" "$WORK/rtl" "$WORK/riscv-core/rtl"
    cp "$SRC"/rtl/gpu_pkg.sv "$SRC"/rtl/lsu.sv "$SRC"/rtl/simt_core.sv "$WORK/rtl/"
    cp "$SRC"/riscv-core/rtl/{rv32i_pkg,alu,branch_unit,decoder,immgen}.sv "$WORK/riscv-core/rtl/"
    ARGS="--overwrite"
else
    ARGS="--from $FROM"
fi
cp "$SRC"/openlane/config.json "$WORK/openlane/"
SKIP=""
for s in OpenROAD.STAMidPNR OpenROAD.STAMidPNR-1 OpenROAD.STAMidPNR-2 OpenROAD.STAMidPNR-3; do
    SKIP="$SKIP --skip $s"
done

cd "$LL"
nix-shell --run "librelane --run-tag sm $ARGS $SKIP $WORK/openlane/config.json"

RUN="$WORK/openlane/runs/sm"
OUT="$SRC/openlane/results"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$RUN"/final/metrics.json "$OUT/"
cp -r "$RUN"/final/gds "$OUT/"
gzip -c "$RUN"/final/def/simt_core.def > "$OUT/simt_core.def.gz"
find "$RUN" -name '*.rpt' -path '*sta*' -exec cp {} "$OUT/" \; 2>/dev/null || true
