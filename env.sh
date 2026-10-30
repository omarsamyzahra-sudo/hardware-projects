# Source this in Git Bash before running anything:  source env.sh
# Same tools as riscv-core (OSS CAD Suite: Icarus, Yosys; xPack RISC-V GCC).
export OSS_CAD="/c/Users/rayan/tools/oss-cad-suite"
export RISCV_GCC="/c/Users/rayan/tools/xpack-riscv-none-elf-gcc-15.2.0-1"
export PATH="$OSS_CAD/bin:$OSS_CAD/lib:$RISCV_GCC/bin:$PATH"
