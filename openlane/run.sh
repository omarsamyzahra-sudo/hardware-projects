#!/usr/bin/env bash
# run.sh — lay out the decoder or the whole engine on SKY130 with LibreLane (in WSL)
#
#   bash openlane/run.sh decoder     weight_decoder alone: the new block
#   bash openlane/run.sh engine      ew_top: decoder + GEMV core + AXI streams + control
#
# (from ew-decoder/, inside WSL). Clock target 20 ns like the TPU and GPU
# runs; fmax comes from the setup slack. Results (metrics, GDS, placed and
# routed DEF, STA reports) land in openlane/<name>/results/.
#
# The engine is built with KMAX = 896 instead of 4864. The x-vector buffer
# (KMAX/8 words of 128 bits) would be an SRAM macro on a real chip, but this
# flow has no SRAM compiler, so it becomes flip-flops: 78k of them at 4864,
# which would swamp the layout (the GPU core's 33k-flop register file
# already strained routing). 896 covers every Qwen2.5-0.5B matrix except
# down_proj. The decoder doesn't depend on KMAX. Even so the engine has
# ~38k flops (mostly the stream FIFOs and x buffer), about the GPU core's
# count, so it gets the GPU rerun's settings: 25% utilization, and global
# routing congestion passed on to detailed routing (leftovers show as DRC).
set -euo pipefail
NAME="${1:?usage: run.sh decoder|engine}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=~/ew-openlane
LL=~/librelane
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

rm -rf "$WORK/openlane/$NAME" && mkdir -p "$WORK/openlane/$NAME" "$WORK/rtl"
cp "$SRC"/rtl/*.sv "$WORK/rtl/"
cp "$SRC/openlane/$NAME/config.json" "$WORK/openlane/$NAME/"

cd "$LL"
nix-shell --run "librelane --run-tag $NAME --overwrite $WORK/openlane/$NAME/config.json"

RUN="$WORK/openlane/$NAME/runs/$NAME"
OUT="$SRC/openlane/$NAME/results"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$RUN"/final/metrics.json "$OUT/"
cp -r "$RUN"/final/gds "$OUT/"
DEF=$(ls "$RUN"/final/def/*.def)
gzip -c "$DEF" > "$OUT/$(basename "$DEF").gz"
find "$RUN" -name '*.rpt' -path '*sta*' -exec cp {} "$OUT/" \; 2>/dev/null || true
