#!/usr/bin/env bash
# run.sh — lay out the pipelined core on SKY130 with LibreLane (in WSL)
#
#   bash openlane/run.sh          (from riscv-core/, inside WSL)
#
# The core only: instruction and data memory stay outside (the imem/dmem
# ports become pins), as SRAM macros would be on a chip. The retirement
# trace ports are kept as pins too; they're just copies of pipeline
# registers. Clock target 20 ns like the TPU and GPU runs; fmax comes from
# the setup slack. Results land in openlane/results/.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=~/cpu-openlane
LL=~/librelane
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

rm -rf "$WORK" && mkdir -p "$WORK/openlane" "$WORK/rtl"
cp "$SRC"/rtl/*.sv "$WORK/rtl/"
cp "$SRC"/openlane/config.json "$WORK/openlane/"

cd "$LL"
nix-shell --run "librelane --run-tag core --overwrite $WORK/openlane/config.json"

RUN="$WORK/openlane/runs/core"
OUT="$SRC/openlane/results"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$RUN"/final/metrics.json "$OUT/"
cp -r "$RUN"/final/gds "$OUT/"
gzip -c "$RUN"/final/def/core.def > "$OUT/core.def.gz"
find "$RUN" -name '*.rpt' -path '*sta*' -exec cp {} "$OUT/" \; 2>/dev/null || true
