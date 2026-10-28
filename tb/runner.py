"""Shared cocotb runner: build an RTL top level with Icarus and run a test module.

Each tb/test_*.py ends with a pytest function that calls run(), so
`pytest tb/` from the repo root runs every cocotb test.
"""

import os
from pathlib import Path

from cocotb_tools.runner import get_runner

REPO = Path(__file__).resolve().parent.parent

ACCEL_SOURCES = ["rtl/accel_pkg.sv", "rtl/pe.sv", "rtl/systolic_array.sv",
                 "rtl/dpram64.sv", "rtl/accel_core.sv",
                 "rtl/accel_axil.sv"]

CORE_SOURCES = [f"riscv-core/rtl/{f}.sv" for f in
                ("rv32i_pkg", "alu", "branch_unit", "csr", "decoder", "immgen", "regfile", "core")]


def run(toplevel: str, sources: list[str], test_module: str, waves: bool = False,
        parameters: dict | None = None, build_name: str | None = None,
        defines: dict | None = None, extra_env: dict | None = None,
        includes: list[str] | None = None, plusargs: list[str] | None = None,
        timescale: tuple[str, str] = ("1ns", "1ps")):
    """sources are relative to the repo root, in compile order (packages first)."""
    root = Path(os.environ.get("SIM_BUILD_ROOT", REPO / "sim_build"))
    build_dir = root / (build_name or toplevel)
    runner = get_runner("icarus")
    runner.build(
        sources=[REPO / s for s in sources],
        includes=[REPO / i for i in (includes or [])],
        hdl_toplevel=toplevel,
        build_dir=build_dir,
        timescale=timescale,
        parameters=parameters or {},
        defines=defines or {},
        waves=waves,
        always=True,
    )
    runner.test(
        hdl_toplevel=toplevel,
        test_module=test_module,
        test_dir=Path(__file__).resolve().parent,
        build_dir=build_dir,
        waves=waves,
        extra_env=extra_env or {},
        plusargs=plusargs or [],
        results_xml=str(build_dir / f"{test_module}.result.xml"),
    )
