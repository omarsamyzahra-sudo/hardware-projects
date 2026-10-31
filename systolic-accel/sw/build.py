"""Build a bare-metal program for the SoC: sw/<name>.c -> sw/build/<name>.hex

    python sw/build.py test_gemm

The .hex has one 32-bit word per line, for $readmemh into soc_top's RAM.
Needs riscv-none-elf-gcc on PATH (source env.sh). -march=rv32i: the core has
no multiply instruction, so libgcc's __mulsi3 / __muldi3 do multiplication.
"""

import subprocess
import sys
from pathlib import Path

SW = Path(__file__).resolve().parent
BUILD = SW / "build"
CFLAGS = ["-march=rv32i", "-mabi=ilp32", "-O2", "-ffreestanding", "-fno-builtin",
          "-nostdlib", "-Wl,--no-warn-rwx-segments", "-Wall", "-Wextra", "-Wno-unused-parameter"]


def build(name: str) -> Path:
    BUILD.mkdir(exist_ok=True)
    elf = BUILD / f"{name}.elf"
    srcs = [SW / "crt0.S", SW / "soc.c", SW / "accel.c", SW / f"{name}.c"]
    subprocess.run(["riscv-none-elf-gcc", *CFLAGS, "-I", str(SW), "-T", str(SW / "link.ld"),
                    *map(str, srcs), "-lgcc", "-o", str(elf)], check=True)
    binf = BUILD / f"{name}.bin"
    subprocess.run(["riscv-none-elf-objcopy", "-O", "binary", str(elf), str(binf)], check=True)
    data = binf.read_bytes()
    data += bytes(-len(data) % 4)
    hexf = BUILD / f"{name}.hex"
    hexf.write_text("".join(f"{int.from_bytes(data[i:i + 4], 'little'):08x}\n"
                            for i in range(0, len(data), 4)))
    size = subprocess.run(["riscv-none-elf-size", str(elf)], capture_output=True, text=True)
    print(size.stdout.strip())
    return hexf


if __name__ == "__main__":
    for n in sys.argv[1:] or ["test_gemm"]:
        print(build(n))
