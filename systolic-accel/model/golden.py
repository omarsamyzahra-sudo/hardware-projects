"""Bit-exact reference model of the accelerator, in numpy.

    job(A, W, bias, mult, shift, relu)  -> (acc int32 [M, 8], out int8 [M, 8])
    layer(X, Wfull, bias, mult, shift, relu) -> int8 [M, Nout]   (many jobs)

Everything the RTL computes is defined here first: the int32 accumulate
(which wraps, like the hardware), the requantization (rounding, arithmetic
shift, ReLU, saturation), and how a whole layer is cut into jobs of 8 output
columns. The cocotb tests, the UVM scoreboard's vectors, the C driver's
expected outputs and the MNIST model all come back to these functions.
"""

import numpy as np

N = 8
M_MAX = 16
KT_MAX = 128


def wrap32(x):
    """Two's-complement wrap to int32 (the accumulator has 32 bits)."""
    x = np.asarray(x, dtype=np.int64) & 0xFFFF_FFFF
    return np.where(x >= 1 << 31, x - (1 << 32), x).astype(np.int64)


def requant(acc, mult: int, shift: int, relu: bool):
    """y = sat8((acc * mult + 2^(shift-1)) >> shift), then max(y, 0) if relu.
    Python's >> on negative ints is arithmetic (floor), like >>> in the RTL."""
    acc = np.asarray(acc, dtype=np.int64)
    rnd = 0 if shift == 0 else 1 << (shift - 1)
    y = (acc * mult + rnd) >> shift          # |acc*mult| < 2^47, rnd <= 2^62: fits int64
    if relu:
        y = np.maximum(y, 0)
    return np.clip(y, -128, 127).astype(np.int8)


def job(A, W, bias, mult: int, shift: int, relu: bool):
    """One accelerator job. A: int8 [M, K], W: int8 [K, 8], bias: int32 [8]."""
    A = np.asarray(A, dtype=np.int64)
    W = np.asarray(W, dtype=np.int64)
    M, K = A.shape
    assert 1 <= M <= M_MAX and K % N == 0 and 1 <= K // N <= KT_MAX and W.shape == (K, N)
    acc = wrap32(np.asarray(bias, dtype=np.int64)[None, :] + A @ W)
    return acc, requant(acc, mult, shift, relu)


def layer(X, Wfull, bias, mult: int, shift: int, relu: bool):
    """A full int8 layer  out = requant(X @ Wfull + bias)  cut into jobs:
    rows in chunks of M_MAX, output columns in strips of 8, K zero-padded to
    a multiple of 8. Returns int8 [M, Nout]."""
    X = np.asarray(X, dtype=np.int64)
    Wfull = np.asarray(Wfull, dtype=np.int64)
    M, K = X.shape
    Nout = Wfull.shape[1]
    Kp = -(-K // N) * N
    Np = -(-Nout // N) * N
    Xp = np.zeros((M, Kp), np.int64); Xp[:, :K] = X
    Wp = np.zeros((Kp, Np), np.int64); Wp[:K, :Nout] = Wfull
    bp = np.zeros(Np, np.int64); bp[:Nout] = bias
    out = np.zeros((M, Np), np.int8)
    for m0 in range(0, M, M_MAX):
        for n0 in range(0, Np, N):
            _, o = job(Xp[m0:m0 + M_MAX], Wp[:, n0:n0 + N], bp[n0:n0 + N], mult, shift, relu)
            out[m0:m0 + M_MAX, n0:n0 + N] = o
    return out[:, :Nout]


# ---- buffer images (what the driver writes over the bus) ----

def abuf_bytes(A) -> bytes:
    """ABUF: A[m][k] at byte m*K + k."""
    return np.asarray(A, dtype=np.int8).tobytes()


def wbuf_bytes(W) -> bytes:
    """WBUF: W[k][n] at byte 8k + n."""
    return np.asarray(W, dtype=np.int8).tobytes()


def quant_reg(mult: int, shift: int, relu: bool) -> int:
    return (mult & 0xFFFF) | (shift & 0x3F) << 16 | int(relu) << 24


if __name__ == "__main__":
    rng = np.random.default_rng(0)
    A = rng.integers(-128, 128, (4, 16))
    W = rng.integers(-128, 128, (16, 8))
    acc, out = job(A, W, np.arange(8), 3, 8, True)
    print(acc, out, sep="\n")
    assert requant([-3], 1, 1, False)[0] == -1          # -1.5 rounds to -1 (half up)
    assert requant([3], 1, 1, False)[0] == 2            # 1.5 rounds to 2
    assert requant([10**9], 65535, 0, False)[0] == 127
