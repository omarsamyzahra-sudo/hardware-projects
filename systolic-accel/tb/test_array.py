"""cocotb tests for rtl/systolic_array.sv (and the PE inside it), against numpy.

    pytest tb/test_array.py -v

Checks that a stream of input rows comes out as rows of A @ W exactly
LATENCY = 2N-1 cycles later, with the tag riding along; that bubbles in
the input stream don't disturb neighbouring rows; and that the two weight
banks are independent (a row computed with bank 1 is unaffected by bank 0
being rewritten while it is still in flight).
"""

import random

import cocotb
import numpy as np
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, RisingEdge

from runner import run

N = 8
LATENCY = 2 * N - 1


def pack8(vals) -> int:
    return sum((int(v) & 0xFF) << (8 * i) for i, v in enumerate(vals))


def unpack32(x: int) -> np.ndarray:
    out = [(x >> (32 * i)) & 0xFFFF_FFFF for i in range(N)]
    return np.array([v - (1 << 32) if v >> 31 else v for v in out], dtype=np.int64)


async def reset(dut):
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    dut.rst.value = 1
    dut.w_row_we.value = 0
    dut.in_valid.value = 0
    dut.in_tag.value = 0
    dut.in_sel.value = 0
    dut.in_a.value = 0
    dut.w_row.value = 0
    dut.w_bank.value = 0
    dut.w_data.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst.value = 0


async def load_weights(dut, W: np.ndarray, bank: int):
    for k in range(N):
        await FallingEdge(dut.clk)
        dut.w_row_we.value = 1
        dut.w_row.value = k
        dut.w_bank.value = bank
        dut.w_data.value = pack8(W[k])
    await FallingEdge(dut.clk)
    dut.w_row_we.value = 0


class Collector:
    """Records (cycle, tag, y) for every out_valid cycle."""

    def __init__(self, dut):
        self.dut, self.cycle, self.rows = dut, 0, []
        cocotb.start_soon(self._run())

    async def _run(self):
        while True:
            await FallingEdge(self.dut.clk)
            self.cycle += 1
            if int(self.dut.out_valid.value):
                self.rows.append((self.cycle, int(self.dut.out_tag.value),
                                  unpack32(int(self.dut.out_y.value))))


@cocotb.test()
async def test_stream_matches_numpy(dut):
    """Random A rows (with random bubbles) against A @ W, exact latency."""
    await reset(dut)
    rng = np.random.default_rng(1)
    W = rng.integers(-128, 128, size=(N, N))
    await load_weights(dut, W, bank=0)
    col = Collector(dut)

    A = rng.integers(-128, 128, size=(64, N))
    sent = {}                      # tag -> cycle it was driven
    i = 0
    while i < len(A):
        await FallingEdge(dut.clk)
        if random.random() < 0.3:              # a bubble
            dut.in_valid.value = 0
            continue
        dut.in_valid.value = 1
        dut.in_tag.value = i
        dut.in_sel.value = 0
        dut.in_a.value = pack8(A[i])
        sent[i] = col.cycle + 1                # sampled at the next falling edge
        i += 1
    await FallingEdge(dut.clk)
    dut.in_valid.value = 0
    for _ in range(LATENCY + 2):
        await FallingEdge(dut.clk)

    assert len(col.rows) == len(A), f"{len(col.rows)} rows out, {len(A)} in"
    for cyc, tag, y in col.rows:
        want = A[tag] @ W
        assert np.array_equal(y, want), f"row {tag}: got {y}, want {want}"
        assert cyc - sent[tag] == LATENCY, f"row {tag}: latency {cyc - sent[tag]}"


@cocotb.test()
async def test_extremes(dut):
    """-128 * -128 everywhere: the largest products, no int32 wrap."""
    await reset(dut)
    W = np.full((N, N), -128)
    await load_weights(dut, W, bank=1)
    col = Collector(dut)
    for a in (np.full(N, -128), np.full(N, 127), np.full(N, 0)):
        await FallingEdge(dut.clk)
        dut.in_valid.value, dut.in_sel.value, dut.in_a.value = 1, 1, pack8(a)
        dut.in_tag.value = 0
    await FallingEdge(dut.clk)
    dut.in_valid.value = 0
    for _ in range(LATENCY + 2):
        await FallingEdge(dut.clk)
    got = [y for _, _, y in col.rows]
    assert [list(y) for y in got] == [[N * 128 * 128] * N, [-N * 127 * 128] * N, [0] * N]


@cocotb.test()
async def test_bank_switch_in_flight(dut):
    """Rows using bank 1 are in flight while bank 0 is rewritten, then rows
    using the new bank 0 follow back to back: each row must use its own bank."""
    await reset(dut)
    rng = np.random.default_rng(7)
    W0, W1, W0b = (rng.integers(-128, 128, size=(N, N)) for _ in range(3))
    await load_weights(dut, W0, bank=0)
    await load_weights(dut, W1, bank=1)
    col = Collector(dut)
    A = rng.integers(-128, 128, size=(12, N))
    want = {}
    # Rows 0..7 stream on bank 1 while all 8 rows of bank 0 are rewritten
    # (one per cycle, alongside). Rows 8..11 then use the new bank 0 with no
    # gap: row 8 reaches PE row k at cycle 8 + k, after row k was written.
    for i in range(12):
        await FallingEdge(dut.clk)
        bank = 1 if i < 8 else 0
        dut.in_valid.value, dut.in_tag.value = 1, i
        dut.in_sel.value, dut.in_a.value = bank, pack8(A[i])
        want[i] = A[i] @ (W1 if bank == 1 else W0b)
        if i < 8:
            dut.w_row_we.value, dut.w_row.value, dut.w_bank.value = 1, i, 0
            dut.w_data.value = pack8(W0b[i])
        else:
            dut.w_row_we.value = 0
    await FallingEdge(dut.clk)
    dut.in_valid.value = 0
    for _ in range(LATENCY + 2):
        await FallingEdge(dut.clk)
    assert len(col.rows) == 12
    for _, tag, y in col.rows:
        assert np.array_equal(y, want[tag]), (
            f"row {tag} (bank {1 if tag < 8 else 0}): got {y}, want {want[tag]}")


def test_array():
    run("systolic_array", ["rtl/pe.sv", "rtl/systolic_array.sv"], "test_array",
        parameters={"N": N, "TAGW": 8})
