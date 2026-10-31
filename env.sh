# Source this in Git Bash before running tests:  source env.sh
# Edit the two paths for the machine you're on (oss-cad-suite has Icarus
# and Verilator; xPack has riscv-none-elf-gcc).
export OSS_CAD="${OSS_CAD:-/c/Users/rayan/tools/oss-cad-suite}"
export RISCV_GCC="${RISCV_GCC:-/c/Users/rayan/tools/xpack-riscv-none-elf-gcc-15.2.0-1}"
export PATH="$OSS_CAD/bin:$OSS_CAD/lib:$RISCV_GCC/bin:$PATH"
