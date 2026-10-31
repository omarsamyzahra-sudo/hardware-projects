"""Real weights through the engine (brief §5.4): every linear matrix of one
Qwen2.5-0.5B decoder layer, decoded and then on the raw-BF16 bypass, with
the decode monitor and y == golden.py bit for bit on every job.

Needs the model in analysis/weights (python analysis/measure.py downloads
it). EW_LAYER picks the layer (default 12).

    pytest tb/test_real.py -s
"""

import os
import sys
from pathlib import Path

import cocotb
import numpy as np
import pytest
from cocotb.triggers import RisingEdge

from ewformat import synthetic_bf16
from image import Image
from test_top import Engine

REPO = Path(__file__).resolve().parent.parent
WEIGHTS = REPO / "analysis" / "weights"
PROJ = ["self_attn.q_proj", "self_attn.k_proj", "self_attn.v_proj", "self_attn.o_proj",
        "mlp.gate_proj", "mlp.up_proj", "mlp.down_proj"]


def layer(n):
    sys.path.insert(0, str(REPO / "analysis"))
    from measure import bf16_tensors
    want = [f"model.layers.{n}.{p}.weight" for p in PROJ]
    got = {}
    for f in sorted(WEIGHTS.glob("*.safetensors")):
        for name, w in bf16_tensors(f):
            if name in want:
                got[name] = np.array(w)
    return [(p.split(".")[-1], got[w]) for p, w in zip(PROJ, want)]


@cocotb.test()
async def test_real_layer(dut):
    n = int(os.environ.get("EW_LAYER", "12"))
    mats = layer(n)
    rng = np.random.default_rng(n)
    img = Image()
    jobs = []
    for bypass in (False, True):
        for name, w in mats:
            x = synthetic_bf16(1, w.shape[1], rng, std=1.0)[0]
            jobs.append((name, img.add_job(w, x, bypass=bypass)))
    eng = Engine(dut)
    await eng.reset()
    await eng.load(img)
    for name, job in jobs:
        cycles = await eng.run_job(job)
        await eng.check_y(job, f"layer {n} {name}{' (bypass)' if job.bypass else ''}")
        dut._log.info(f"{name:8} {'raw' if job.bypass else 'ew ':3} {job.rows:5}x{job.cols:<5} "
                      f"cycles {cycles:7d}  escapes {job.n_esc:6d}  errors so far {len(eng.errors)}")
    await RisingEdge(dut.clk)
    eng.finish(f"layer {n}")


def test_real():
    if not list(WEIGHTS.glob("*.safetensors")):
        pytest.skip("no model in analysis/weights (run analysis/measure.py)")
    from test_top import _run
    _run("real_l8_b3", module="test_real")
