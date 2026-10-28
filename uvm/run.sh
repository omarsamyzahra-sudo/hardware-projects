#!/usr/bin/env bash
# Compile and run the UVM testbench on Vivado's simulator (xsim).
#   ./uvm/run.sh [test] [seed]      e.g.  ./uvm/run.sh random_test 7
# Defaults: random_test, seed 1. Exit status 0 only if the test passed.
# xsim's scratch files go outside the repo (OneDrive locks files inside it,
# which breaks xelab); the simulation log is copied to uvm/sim_<test>.log.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../env.sh"
TEST=${1:-random_test}
SEED=${2:-1}
WORK=${XSIM_WORK:-$HOME/.cache/systolic-accel-xsim}
mkdir -p "$WORK"
cd "$WORK"
R="$HERE/../rtl"
SRC="$R/accel_pkg.sv $R/pe.sv $R/systolic_array.sv $R/dpram64.sv $R/accel_core.sv \
     $R/accel_axil.sv $HERE/axil_if.sv $HERE/accel_uvm_pkg.sv $HERE/tb_top.sv"

"$VIVADO_BIN/xvlog.bat" -sv -L uvm $SRC > compile.log || { tail compile.log; exit 1; }
"$VIVADO_BIN/xelab.bat" -L uvm -timescale 1ns/1ps tb_top -s tb_snap > elab.log \
    || { grep -E "ERROR" elab.log; exit 1; }
# Options go through a file: xsim.bat would split "UVM_TESTNAME=x" at the '='.
cat > sim.args <<ARGS
--runall
--sv_seed $SEED
--testplusarg UVM_TESTNAME=$TEST
--testplusarg UVM_VERBOSITY=UVM_LOW
ARGS
"$VIVADO_BIN/xsim.bat" tb_snap -f sim.args > sim.log || true
cp sim.log "$HERE/sim_${TEST}.log"

grep -E "UVM_(ERROR|FATAL) |\[SB\]|\[COV\]|\*\*\* (PASSED|FAILED)|Assertion .* failed|SVA a_" sim.log \
    | sed 's/^/  /' | head -40
grep -q "\*\*\* PASSED \*\*\*" sim.log && ! grep -qE "Assertion .* failed|SVA a_" sim.log
