"""cocotb tests for the whole accelerator (rtl/accel_axil.sv) over AXI4-Lite.

    pytest tb/test_accel.py -v

A small bus master drives the AXI4-Lite port the way the CPU's driver will:
fill WBUF/ABUF, write the config registers, start, poll STATUS, read OUT8
and ACC back. Every job is checked bit-for-bit against model/golden.py.
"""

import random
import sys
from pathlib import Path

import cocotb
import numpy as np
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, RisingEdge

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "model"))
import golden  # noqa: E402
from runner import ACCEL_SOURCES, run  # noqa: E402

N = 8
OKAY, SLVERR, DECERR = 0, 2, 3
CTRL, STATUS, MROWS, KTILES, QUANT, CYCLES, ID, BIAS = 0, 4, 8, 0xC, 0x10, 0x14, 0x18, 0x20
OUT8, ACC, WBUF, ABUF = 0x100, 0x200, 0x2000, 0x4000


class AxiLite:
    """Minimal AXI4-Lite master. Signals change on the falling edge and are
    sampled by the DUT on the rising edge. Optional random valid/ready delays."""

    def __init__(self, dut, jitter: bool = False):
        self.dut, self.jitter = dut, jitter
        for s in ("awvalid", "wvalid", "arvalid"):
            getattr(dut, "s_" + s).value = 0
        dut.s_bready.value = 1
        dut.s_rready.value = 1

    async def _idle(self):
        if self.jitter:
            for _ in range(random.choice((0, 0, 0, 1, 2))):
                await FallingEdge(self.dut.clk)

    async def write(self, addr: int, data: int, strb: int = 0xF) -> int:
        d = self.dut
        await self._idle()
        await FallingEdge(d.clk)
        d.s_awaddr.value, d.s_awvalid.value = addr, 1
        d.s_wdata.value, d.s_wstrb.value, d.s_wvalid.value = data & 0xFFFF_FFFF, strb, 1
        d.s_bready.value = 0 if self.jitter and random.random() < 0.3 else 1
        while True:
            await RisingEdge(d.clk)
            if int(d.s_awready.value):
                break
        await FallingEdge(d.clk)
        d.s_awvalid.value = d.s_wvalid.value = 0
        d.s_bready.value = 1
        while not int(d.s_bvalid.value):
            await FallingEdge(d.clk)
        resp = int(d.s_bresp.value)
        await RisingEdge(d.clk)                 # the B handshake
        return resp

    async def read(self, addr: int) -> tuple[int, int]:
        d = self.dut
        await self._idle()
        await FallingEdge(d.clk)
        d.s_araddr.value, d.s_arvalid.value = addr, 1
        while True:
            await RisingEdge(d.clk)
            if int(d.s_arready.value):
                break
        await FallingEdge(d.clk)
        d.s_arvalid.value = 0
        if self.jitter and random.random() < 0.3:
            d.s_rready.value = 0
            await FallingEdge(d.clk)
            await FallingEdge(d.clk)
            d.s_rready.value = 1
        while not int(d.s_rvalid.value):
            await FallingEdge(d.clk)
        data, resp = int(d.s_rdata.value), int(d.s_rresp.value)
        await RisingEdge(d.clk)
        return data, resp

    async def write_ok(self, addr, data, strb=0xF):
        r = await self.write(addr, data, strb)
        assert r == OKAY, f"write {addr:#x} = {data:#x}: resp {r}"

    async def read_ok(self, addr) -> int:
        data, r = await self.read(addr)
        assert r == OKAY, f"read {addr:#x}: resp {r}"
        return data

    async def write_bytes(self, base: int, blob: bytes):
        blob = blob + bytes(-len(blob) % 4)
        for i in range(0, len(blob), 4):
            await self.write_ok(base + i, int.from_bytes(blob[i:i + 4], "little"))


async def setup(dut, jitter=False) -> AxiLite:
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    bus = AxiLite(dut, jitter)
    dut.rst.value = 1
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst.value = 0
    return bus


def s8(x):
    return x - 256 if x >= 128 else x


def s32(x):
    return x - (1 << 32) if x >> 31 else x


async def run_job(bus: AxiLite, A, W, bias, mult, shift, relu):
    """Program one job, run it, read everything back, compare with golden."""
    M, K = A.shape
    await bus.write_bytes(WBUF, golden.wbuf_bytes(W))
    await bus.write_bytes(ABUF, golden.abuf_bytes(A))
    for n in range(N):
        await bus.write_ok(BIAS + 4 * n, int(bias[n]))
    await bus.write_ok(MROWS, M)
    await bus.write_ok(KTILES, K // N)
    await bus.write_ok(QUANT, golden.quant_reg(mult, shift, relu))
    await bus.write_ok(CTRL, 1)
    polls = 0
    while (st := await bus.read_ok(STATUS)) != 0b10:
        assert st & 1, f"STATUS {st:#x}: neither busy nor done"
        polls += 1
        assert polls < 5000, "job never finished"
    want_acc, want_out = golden.job(A, W, bias, mult, shift, relu)
    for m in range(M):
        for half in range(2):
            w = await bus.read_ok(OUT8 + 8 * m + 4 * half)
            got = [s8((w >> (8 * i)) & 0xFF) for i in range(4)]
            assert got == list(want_out[m, 4 * half:4 * half + 4]), (
                f"OUT8 row {m} cols {4*half}..: got {got}, want {want_out[m, 4*half:4*half+4]}")
        for n in range(N):
            got = s32(await bus.read_ok(ACC + 32 * m + 4 * n))
            assert got == want_acc[m, n], f"ACC[{m}][{n}]: got {got}, want {want_acc[m, n]}"
    return await bus.read_ok(CYCLES)


def random_job(rng, M=None, KT=None):
    M = M or int(rng.integers(1, golden.M_MAX + 1))
    KT = KT or int(rng.integers(1, 9))
    A = rng.integers(-128, 128, (M, KT * N))
    W = rng.integers(-128, 128, (KT * N, N))
    bias = rng.integers(-(1 << 20), 1 << 20, N)
    shift = int(rng.integers(6, 16))
    mult = int(rng.integers(1, 1 << 16))
    return A, W, bias, mult, shift, bool(rng.integers(0, 2))


@cocotb.test()
async def test_id_and_reset_values(dut):
    bus = await setup(dut)
    assert await bus.read_ok(ID) == 0x5341_0808
    assert await bus.read_ok(STATUS) == 0
    assert await bus.read_ok(MROWS) == 1
    assert await bus.read_ok(KTILES) == 1


@cocotb.test()
async def test_random_jobs(dut):
    """Random shapes and quantization, back to back, with bus jitter."""
    bus = await setup(dut, jitter=True)
    rng = np.random.default_rng(2026)
    for _ in range(12):
        await run_job(bus, *random_job(rng))


@cocotb.test()
async def test_corner_shapes(dut):
    """M = 1 and M = 16; KT = 1, 2, 3 (odd, so the banks alternate unevenly)
    and a long K; M < N + 1 makes the loader the bottleneck, M = 16 the streamer."""
    bus = await setup(dut)
    rng = np.random.default_rng(5)
    for M, KT in ((1, 1), (16, 1), (1, 3), (16, 2), (3, 5), (16, 3), (2, 32)):
        await run_job(bus, *random_job(rng, M, KT))


@cocotb.test()
async def test_requant_edges(dut):
    """Saturation both ways, shift 0, a huge shift, ReLU on negatives, a
    bias that makes the int32 accumulator wrap."""
    bus = await setup(dut)
    rng = np.random.default_rng(9)
    A = np.full((4, 16), -128)
    W = np.full((16, 8), -128)               # every product +16384
    for bias, mult, shift, relu in (
            (np.zeros(8, int), 1, 0, False),             # saturates at +127
            (np.full(8, -(1 << 20)), 1, 0, False),       # saturates at -128
            (np.full(8, -(1 << 20)), 1, 0, True),        # ReLU -> 0
            (np.full(8, (1 << 31) - 1000), 1, 0, False), # wraps negative
            (np.arange(8) * 1000, 65535, 63, False),     # everything rounds to 0
            (np.arange(8) - 4, 3, 1, False)):            # rounding of halves
        await run_job(bus, A, W, bias, mult, shift, relu)
    A = rng.integers(-128, 128, (5, 8))
    W = rng.integers(-128, 128, (8, 8))
    await run_job(bus, A, W, np.zeros(8, int), 1, 7, False)


@cocotb.test()
async def test_throughput(dut):
    """With M = 16 the streamer is busy every cycle: the job should take about
    M * KT cycles plus a fixed pipeline fill/drain, not (N + 1) * KT extra."""
    bus = await setup(dut)
    rng = np.random.default_rng(3)
    c8 = await run_job(bus, *random_job(rng, 16, 8))
    c16 = await run_job(bus, *random_job(rng, 16, 16))
    dut._log.info(f"M=16: KT=8 took {c8} cycles, KT=16 took {c16}")
    assert c16 - c8 <= 8 * 16 + 4, f"8 more k-tiles cost {c16 - c8} cycles (ideal 128)"


@cocotb.test()
async def test_bus_errors(dut):
    bus = await setup(dut)
    assert await bus.write(0x1C, 0) == DECERR
    assert (await bus.read(0x1C))[1] == DECERR
    assert (await bus.read(0x400))[1] == DECERR
    assert (await bus.read(0x180))[1] == DECERR
    assert await bus.write(0x1FFC, 0) == DECERR
    for ro in (STATUS, CYCLES, ID, OUT8, ACC + 4):
        assert await bus.write(ro, 1) == SLVERR, f"write to read-only {ro:#x}"
    # start with out-of-range M or KT
    await bus.write_ok(MROWS, 0)
    assert await bus.write(CTRL, 1) == SLVERR
    await bus.write_ok(MROWS, 17)
    assert await bus.write(CTRL, 1) == SLVERR
    await bus.write_ok(MROWS, 4)
    await bus.write_ok(KTILES, 0)
    assert await bus.write(CTRL, 1) == SLVERR
    await bus.write_ok(KTILES, 129)
    assert await bus.write(CTRL, 1) == SLVERR
    assert await bus.read_ok(STATUS) == 0                 # nothing started
    # writes while busy are refused and change nothing
    await bus.write_ok(KTILES, 64)
    await bus.write_ok(CTRL, 1)
    assert (await bus.read_ok(STATUS)) & 1
    assert await bus.write(MROWS, 2) == SLVERR
    assert await bus.write(ABUF, 0x1234) == SLVERR
    assert await bus.write(CTRL, 1) == SLVERR
    assert await bus.read_ok(MROWS) == 4
    while await bus.read_ok(STATUS) != 0b10:
        pass
    # byte strobes on a buffer word and a register
    await bus.write_ok(WBUF + 4, 0xAABBCCDD)
    await bus.write_ok(WBUF + 4, 0x11223344, strb=0b0101)
    assert await bus.read_ok(WBUF + 4) == 0xAA22CC44
    await bus.write_ok(BIAS + 8, 0x01020304)
    await bus.write_ok(BIAS + 8, 0xFF000000, strb=0b1000)
    assert await bus.read_ok(BIAS + 8) == 0xFF020304


def test_accel():
    run("accel_axil", ACCEL_SOURCES, "test_accel")
