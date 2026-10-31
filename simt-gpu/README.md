# simt-gpu

A small SIMT GPU in SystemVerilog, built on the decoder, ALU, branch unit and
immediate generator of [riscv-core](riscv-core) (a pinned copy of [`../riscv-core`](../riscv-core) at commit 48a8279, reused
unchanged). Threads run RV32I plus `mul`, find out who they are with CUDA-style
ID registers, and are checked against riscv-core's golden model.

## Not "a bunch of CPUs"
Copying a CPU 64 times would give 64 fetch units, 64 decoders and 64 branch
units. A SIMT core has **one** of each, shared by every thread. Each cycle the
scheduler picks one *warp* (8 threads), fetches one instruction for it, and 8
copies of riscv-core's ALU execute it at once, each on its own registers. All
the extra hardware goes into ALUs and registers. Three things make that work,
and they are what this repo builds:

- **Warps hide latency.** Each warp has at most one instruction in flight, so
  there are no hazards and no forwarding. While one warp waits on memory,
  the others issue.
- **Divergence is handled with masks.** Each thread has its own PC. The warp
  runs at the lowest PC among its live threads, and only the threads at that
  PC are enabled. Both sides of an if/else run one after the other, and the
  warp reconverges automatically once all its threads reach the same PC.
- **Coalescing.** The load/store unit merges a warp's 8 accesses into as few
  32-byte memory lines as possible: 1 line when the threads touch consecutive
  words, 8 when they are scattered.

## Shape
| | |
|---|---|
| Cores ("SMs") | 2, each running one thread block at a time |
| Warps per core × lanes per warp | 4 × 8 = 32 threads per block |
| Pipeline | F (pick warp, fetch) → D (decode, read 8 register files) → X (8 ALUs, write back) |
| Memory | 64 KiB global, 32-byte lines, round-robin arbiter, 8-cycle latency (parameter) |
| ISA | RV32I + `mul`; ECALL ends a thread; `csrr` from tid / ctaid / ntid / nctaid / args |

## Status
- ✅ RTL: `simt_core` (scheduler, divergence, per-lane register files),
  `lsu` (coalescer, tag queue, byte/halfword loads and stores), `gpu_mem`,
  `gpu_top` (block dispatcher, perf counters, host port)
- ✅ 11 cocotb tests: vecadd, saxpy, matmul, Collatz (divergence), coalescing
  (exact line counts for strides 1/2/4/8), bytes and halfwords, subroutine calls,
  odd block sizes, latency hiding, host port, and random kernels
- ✅ Every kernel is also run thread by thread on riscv-core's ISS. The final
  64 KiB of memory must match byte for byte, and so must the count of
  executed thread instructions.
- ✅ Random kernels (`tb/randkernel.py`): nested data-dependent branches, loops,
  calls, gathers, early exits; SIMD efficiency anywhere from 12% to 100%
- ✅ Mutation-tested: 10/10 planted bugs caught (`tb/mutate.py`)
- ✅ Benchmarked against riscv-core's pipelined CPU (`tb/test_bench.py`)

## CPU vs GPU
The same data and the same algorithm run on riscv-core's 5-stage pipeline (in
lockstep with its golden model) and on this GPU. The CPU's memory answers in
1 cycle. The GPU runs once with 2-cycle memory (the fastest `gpu_mem` allows)
and once with its default 8-cycle memory.

| workload | CPU cycles | GPU, 2-cycle memory | GPU, 8-cycle memory | SIMD efficiency |
|---|---:|---:|---:|---:|
| vecadd (1024) | 11,276 | 1,698 (6.6×) | 2,290 (4.9×) | 100% |
| Collatz (256) | 169,998 | 19,169 (8.9×) | 19,287 (8.8×) | 40% |

The GPU's peak is 16 thread-instructions per cycle (2 cores × 8 lanes); the
CPU's is 1, and it reaches 0.82 on vecadd and 0.64 on Collatz.

- **vecadd** (1024 elements, memory-bound) has no divergence, so every lane does
  useful work. But each GPU thread runs 20 instructions (global-ID math, four
  argument loads, a bounds check, then the add) where the CPU loop needs 9 per
  element. The GPU sustains 12.1 thread-instructions per cycle with 2-cycle
  memory and 8.9 with 8-cycle memory, because warps sleep on their loads.
  Memory latency matters here.
- **Collatz** (256 starting values, compute-bound) makes every thread loop a
  different number of times. The cores issue on 91% of cycles, but only 40%
  of the lanes in each issue are useful, so a warp runs at the speed of its
  slowest thread. The CPU suffers too: every taken branch flushes two
  instructions. The GPU still wins, but divergence costs it about 2.5×
  (the same issue rate with full warps would be about 23×). Memory latency
  hardly matters: 160 memory lines in 19,000 cycles.

## Layout
- `rtl/`: `gpu_pkg.sv` (shape, CSR numbers), `simt_core.sv`, `lsu.sv`, `gpu_mem.sv`, `gpu_top.sv`
- `tb/gpu.py`: cocotb driver and golden model (riscv-core's ISS, one instance per thread)
- `tb/kernels.py`: the kernels, in assembly, and a memory-image builder
- `tb/test_gpu.py`, `tb/randkernel.py`, `tb/mutate.py`, `tb/test_bench.py`
- `riscv-core/`: the CPU, a pinned copy of `../riscv-core` at 48a8279
- `openlane/`: SKY130 layout of one SIMT core (`run.sh` explains the settings), results and renders

## Running
In Git Bash, from the repo root:

```bash
source env.sh
pytest tb/test_gpu.py -s          # about 1 min; -s prints cycles and SIMD efficiency
pytest tb/test_bench.py -s        # CPU vs GPU table, writes docs/bench.json
python tb/mutate.py               # plants 10 bugs, expects every one caught
```

`RAND_KERNELS=200 pytest tb/test_gpu.py` soaks the random-kernel test longer.

## What a real GPU adds
Shared memory and barriers (`__syncthreads`), L1/L2 caches, several
instructions in flight per warp (a scoreboard), floating point and tensor
units, 32-thread warps and dozens of resident warps per SM, and, since
NVIDIA Volta, independent thread scheduling. That last one fixes a deadlock
this design keeps on purpose: one thread spinning while it waits on another
thread in the same warp.
