# Source this in Git Bash before running anything:  source env.sh
# Same tools as riscv-core (OSS CAD Suite: Icarus, Yosys; xPack RISC-V GCC),
# plus Vivado's xsim for the UVM testbench (uvm/).
export OSS_CAD="/c/Users/rayan/tools/oss-cad-suite"
export RISCV_GCC="/c/Users/rayan/tools/xpack-riscv-none-elf-gcc-15.2.0-1"
export VIVADO_BIN="/c/AMDDesignTools/2026.1.1/Vivado/bin"
export PATH="$OSS_CAD/bin:$OSS_CAD/lib:$RISCV_GCC/bin:$PATH"
