#!/usr/bin/env bash
# sweep.sh — decoder-alone SKY130 layouts across build parameters (brief Phase 7)
#
#   bash openlane/sweep.sh [tag]      (from ew-decoder/, inside WSL; tag = one point)
#
# One layout per point, one at a time, same flow settings as
# openlane/decoder/config.json (20 ns target, 40% utilization); only the
# chparam'd parameters change. The default point (L = 8, 3-bit, per-matrix
# base) is openlane/decoder/results. Metrics land in openlane/sweep/<tag>/.
# Exception: L8_b4 runs at 30% utilization. Its 4 code planes, double
# buffered, left global routing congested at 40% (GRT-0116), twice.
#
# Escape encoding (exponent byte vs. full-BF16 fallback) isn't swept in
# hardware: the two store exactly the same number of bytes (Phase 1), so the
# choice is the simpler datapath, already built.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=~/ew-openlane
LL=~/librelane
ONLY="${1:-}"
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

POINTS=(
    "L8_b2   L=8  CODE_BITS=2 PER_TILE_BASE=0"
    "L8_b4   L=8  CODE_BITS=4 PER_TILE_BASE=0 UTIL=30"
    "L8_b3_tb L=8 CODE_BITS=3 PER_TILE_BASE=1"
    "L4_b3   L=4  CODE_BITS=3 PER_TILE_BASE=0"
    "L16_b3  L=16 CODE_BITS=3 PER_TILE_BASE=0"
)
mkdir -p "$WORK/rtl" && cp "$SRC"/rtl/*.sv "$WORK/rtl/"
for p in "${POINTS[@]}"; do
    set -- $p
    tag=$1; shift
    [ -n "$ONLY" ] && [ "$tag" != "$ONLY" ] && continue
    util=40
    args=()
    for a in "$@"; do case $a in UTIL=*) util=${a#UTIL=} ;; *) args+=("$a") ;; esac; done
    params=$(printf '"%s",' "${args[@]}"); params="[${params%,}]"
    d="$WORK/openlane/sweep_$tag"
    rm -rf "$d" && mkdir -p "$d"
    python3 - "$SRC/openlane/decoder/config.json" "$d/config.json" "$params" "$util" <<'EOF'
import json, sys
c = json.load(open(sys.argv[1]))
c["SYNTH_PARAMETERS"] = json.loads(sys.argv[3])
c["FP_CORE_UTIL"] = int(sys.argv[4])
json.dump(c, open(sys.argv[2], "w"), indent=4)
EOF
    echo "== $tag $* $(date)"
    (cd "$LL" && nix-shell --run "librelane --run-tag $tag --overwrite $d/config.json") > "$d.log" 2>&1
    echo "   exit $?"
    out="$SRC/openlane/sweep/$tag"
    mkdir -p "$out"
    cp "$d/runs/$tag/final/metrics.json" "$out/" 2>/dev/null || echo "   no metrics for $tag"
    tail -5 "$d.log" > "$out/flow_tail.log"
done
