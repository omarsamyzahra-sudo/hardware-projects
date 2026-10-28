"""Run bare-metal programs on the whole SoC (riscv-core + RAM + accelerator).

    pytest tb/test_soc.py -v -s        (-s shows the program's console output)

Each test builds sw/<program>.c, loads it into RAM with $readmemh, runs
until the program writes its exit code to SYS TOHOST, and checks it is 0.
The console (SYS PUTCHAR) is printed by the RTL and saved to sw/build/<program>.log.
"""

import os
import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
import cocotb.utils
from cocotb.triggers import First, RisingEdge, Timer

from runner import ACCEL_SOURCES, CORE_SOURCES, REPO, run

sys.path.insert(0, str(REPO / "sw"))
import build  # noqa: E402

SOC_SOURCES = CORE_SOURCES + ACCEL_SOURCES + ["soc/soc_top.sv"]


@cocotb.test()
async def run_program(dut):
    """Reset, then wait (in the simulator, not cycle by cycle in Python) for
    the program's exit pulse. The RTL itself writes the console log."""
    max_cycles = int(os.environ.get("MAX_CYCLES", "20000000"))
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    dut.rst.value = 1
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst.value = 0
    res = await First(RisingEdge(dut.tohost_valid), Timer(10 * max_cycles, unit="ns"))
    assert res is not None and int(dut.tohost_valid.value), f"no exit after {max_cycles} cycles"
    code = int(dut.tohost_data.value)
    dut._log.info(f"exit code {code} at {cocotb.utils.get_sim_time('ns') / 10:.0f} cycles")
    assert code == 0, f"program exited with {code}"


def run_soc(program: str, max_cycles: int = 20_000_000):
    hexf = build.build(program)
    run("soc_top", SOC_SOURCES, "test_soc", build_name=f"soc_{program}",
        plusargs=[f"+HEX={hexf.as_posix()}", f"+LOG={(build.BUILD / (program + '.log')).as_posix()}"],
        extra_env={"MAX_CYCLES": str(max_cycles)})
    return (build.BUILD / f"{program}.log").read_text()


def test_gemm():
    log = run_soc("test_gemm")
    assert log.rstrip().endswith("PASS"), log


def test_mnist():
    log = run_soc("mnist", max_cycles=40_000_000)
    assert log.rstrip().endswith("PASS"), log
