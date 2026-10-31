# Architecture: exponent-window GEMV engine

Status: v1, written before the RTL (brief §3). Numbers marked **TBD** wait
on Phase 1 (real Qwen2.5-0.5B weights) or board datasheets; nothing here is
a measurement.

```
                 RISC-V core (riscv-core, custom-0 instructions)
                        | cop_* (one request, one response)
                 +------v------+
                 |   ew_ctrl   |  config regs, job FSM, perf counters
                 +------+------+
      start/len/addr    |
   +---------+---------+---------+---------+---------+
   v         v         v         v         v         |
 rd:code   rd:smr    rd:esc    rd:tbase  rd:x        |   axi_rd_stream x5
 64b       2L*8 b    64b       64b       64b         |   (AXI4 read, INCR bursts,
   |         |         |         |         |         |    space-reserved FIFO)
   v         v         v         v         v         |
 +-----------------------------------+  +------+     |
 |         weight_decoder            |  | x buf|     |
 |  tile regs -> L codes/cycle       |  | BRAM |     |
 |  esc window + prefix popcount     |  +--+---+     |
 |  L x ew_lane  | bypass mux (raw)  |     |         |
 +----------------+------------------+     |         |
                  | L x BF16 / cycle       |         |
                  v                        v         |
 +-------------------------------------------------+ |
 | gemv_core: L x bf16_mul -> pairwise fp32 tree ->| |
 |            fp32 accumulator -> y FIFO           | |
 +------------------------+------------------------+ |
                          v                          |
                     wr:y (axi_wr_stream, 64b) <-----+
```

## 1. Weight path (brief §3.1)

### 1.1 Streams and DRAM layout
Matrix weights in row-major order, 64-weight tiles (rows are multiples of
64 for every Qwen2.5-0.5B linear layer: 896, 4864, 128, 151936 all are).
Four streams per matrix, each 4 KB-aligned and padded to 64 bytes
(`sw/ewformat.py` is the reference):

| stream | content | bytes |
|---|---|---|
| code | per tile, `b` 64-bit LE words, word p = bit p of the 64 codes | N·K/64 · 8b |
| sm | `sign<<7 \| mantissa`, one per weight | N·K |
| esc | escaped exponents, stream order | n_esc |
| tbase | per-tile base byte (per-tile variant only) | N·K/64 |
| raw (baseline) | BF16 LE, reuses the sm port | 2·N·K |

**Separate regions, not interleaved.** Each stream gets its own AXI read
port and its own 4 KB-aligned region, so each is one long sequential run of
full INCR bursts (16 beats). Interleaving per tile would make the 3-word
code chunk, the 64-byte sm chunk and a variable 0–64-byte escape chunk share
bursts, and the variable part breaks burst alignment every tile. The cost of
separate regions is up to 4 open DRAM rows at once, which the DDR
controller's bank parallelism absorbs; to be checked on the board.

### 1.2 Decoder lane (`ew_lane.sv`, replicated L times)
Purely combinational:

```
exp = (code == 0) ? esc_byte : base + code      // 8-bit add, wraps mod 256
w   = {sm[7], exp, sm[6:0]}
```

`base + code` wraps on purpose: a window starting at exponent 0 has base
255, and 255 + c mod 256 = c - 1 is right. No BRAM, no DSP.

### 1.3 Codes per cycle (`weight_decoder.sv`)
Two register sets of `b` x 64 bits: the tile being decoded and the next
one (filled from the code FIFO while the current tile drains), so tile
changes cost no cycle. Each cycle takes L codes at position j (a 64/L : 1
mux per code bit).

### 1.4 Escape distribution across lanes
`m_i = (code_i == 0)`; slot `s_i = popcount(m_0 .. m_{i-1})` (a prefix
popcount over L bits); lane i takes `win[s_i]` where `win` is a byte window
holding the next `WB = 2L` escape bytes, and the window shifts by
`popcount(m)` after the cycle. The window refills from the 64-bit escape
FIFO 8 bytes at a time whenever it has room.

**Stall rule:** a chunk is issued only if `win_count >= popcount(m)` (and
the code tile, sm bytes and output credit are there). Otherwise the whole
chunk waits; lanes never issue partially. Worst case (all L lanes escape
for many cycles) runs at 8 escape bytes/cycle, i.e. full speed up to L = 8
and L/8 slower beyond that while the burst lasts.

**Sizing:** `WB = 2L` covers one full-escape chunk plus a refill word. The
escape FIFO depth (default 64 words = 512 bytes) must cover the largest
escape burst in any 256-weight window that arrives faster than the escape
port can refill. **TBD from Phase 1** (`max escapes in N = 16/64/256`);
average-case stalls are expected ≈ 0 at the ~3% escape rate seen in the
literature, and the perf counter `STALL_ESC` measures them.

### 1.5 Base registers
Per-matrix: `EXP.BASE` writes the base register. Per-tile (`PER_TILE_BASE=1`,
a build parameter): each tile's base byte arrives on the tbase stream and is
loaded with the tile's code words. In hardware that is one 8-bit register per
tile buffer; a GPU pays extra instructions per tile for the same thing.

### 1.6 Bypass (baseline) mode
`DEC.BYPASS 1`: the sm port reads raw BF16 (2L bytes/cycle) and the lanes
are skipped by a 2:1 mux per weight. Code/esc/tbase ports stay idle. Every
other block (readers, FIFOs, x buffer, multipliers, tree, accumulator,
writer, control) is shared, so decoded and baseline differ only by the
decoder (brief rule).

## 2. Compute path (brief §3.2)

y = W·x, x (K BF16) loaded once into a BRAM of L-wide words (depth
`KMAX/L`, default KMAX = 4864).

Pipeline, one chunk of L weights per cycle, no internal back-pressure:

| stage | work |
|---|---|
| S0 | accept chunk from the decoder; issue x BRAM read (word = chunk index) |
| S1 | L × `bf16_mul` (8x8-bit significand multiply, exact) → register |
| S2..S(1+log2 L) | pairwise FP32 adder tree, one level per stage |
| SA | accumulator: `acc = (first ? +0 : acc) + chunk_sum`; on the row's last chunk, push to y FIFO |

The accumulator adder is single-cycle (combinational FP32 add) so it can
take a chunk every cycle with no interleaved partial sums; the order is
exactly `sw/golden.py`'s. If it limits Fmax, the fix is P interleaved
accumulators plus a final reduction, and golden.py changes with it.

**Output credit:** a chunk that starts a row is accepted only if the y FIFO
has room for every row already in flight, so the pipeline never needs to
stall.

**DSP mapping:** the 8x8 multiply fits one DSP48 (or ~60 LUTs); left to
Vivado, reported in Phase 6.

### 2.1 Bandwidth matching
Weights per second the engine can take: `L · f_clk`. DRAM weight rate:
`BW / (bits/8)`. Balanced when

```
L · f_clk = BW · 8 / bits_per_weight
```

| board | BW (achievable from PL) | f_clk | L for raw (16 b) | L for ~11.3 b |
|---|---|---|---|---|
| KV260 (ZU5EV, DDR4) | **TBD**, datasheet + measured | **TBD** | **TBD** | **TBD** |
| Arty A7-100T (DDR3) | **TBD** | **TBD** | **TBD** | **TBD** |

The baseline needs `16/bits` ≈ 1.4× more DRAM bandwidth than the decoded
path for the same L. To measure the *bandwidth* win (the thesis), L is
chosen so the MAC array outruns DRAM in both modes, and the runtime is set
by bytes moved. The simulator's memory model enforces a shared bytes/cycle
budget (§5), which stands in for the DRAM until the board numbers are in.

## 3. Control (brief §3.4)

**Core:** our `riscv-core` (5-stage RV32I, this repo's sibling), extended
with a coprocessor port: custom-0 instructions stall in EX until
`ew_ctrl` answers, and the answer goes to `rd`. Chosen over VexRiscv /
PicoRV32 because it's ours and verified (formal + riscv-tests); over the
Zynq PS because the Arty has no PS and the same driver should run on both.

**Encodings:** R-type, opcode `custom-0 = 0001011`, funct7 = 0, op in funct3.

| funct3 | mnemonic | operands | effect |
|---|---|---|---|
| 0 | `EXP.BASE rs1` | rs1[7:0] = base | per-matrix base (window width is a build parameter) |
| 1 | `WSTREAM.CFG rs1, rs2` | rs1 = field id, rs2 = value | 0 code addr, 1 sm/raw addr, 2 esc addr, 3 esc count (bytes), 4 tbase addr, 5 x addr, 6 y addr |
| 2 | `GEMV.RUN rd, rs1, rs2` | rs1 = N rows, rs2 = K cols | starts a job; rd = handle. Stalls while a job is running |
| 3 | `GEMV.WAIT rd, rs1` | rs1 = handle | stalls until that job is done; rd = its cycle count |
| 4 | `DEC.BYPASS rs1` | rs1[0] | 1 = raw BF16 baseline path |
| 5 | `EW.STAT rd, rs1` | rs1 = counter id | 0 cycles, 1 chunks issued, 2 escape stalls, 3 data stalls, 4 escapes |

```
 31      25 24  20 19  15 14 12 11   7 6       0
 0000000    rs2    rs1    f3     rd    0001011
```

Driver: `sw/driver/` (C + assembly) runs one decoder layer's projections
(q, k, v, o, gate, up, down) in sequence.

## 4. Risks (brief §3.5)

| risk | handling |
|---|---|
| escape bursts stall lanes | stall rule above; FIFO depth from measured worst case (Phase 1); `STALL_ESC` counter |
| three-stream DRAM efficiency | separate 4 KB regions, 16-beat bursts, up to 4 outstanding per port; esc stream is small, its bursts may be short at the tail |
| matrices on raw bypass (Gate 1) | `DEC.BYPASS` per job, switching costs nothing (a register) |
| decoder on the critical path | lane is ~3 LUT levels; prefix popcount + window mux is the long part. Build option `DEC_PIPE` adds a register after the decoder if Phase 6 timing says so |
| accumulator loop limits Fmax | see §2 |

## 5. Verification view

The testbench memory (`tb/axi_mem.sv`) serves all five read ports and the
write port from one byte array, with a fixed latency and a shared budget of
`BW_NUM/BW_DEN` bytes per cycle across ports. Cycle counts from it are
**simulated**, and labeled so in RESULTS.md.
