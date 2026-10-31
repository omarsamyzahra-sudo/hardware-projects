// accel_pkg.sv — sizes and the register map of the int8 systolic accelerator
//
// One job computes  OUT[m][n] = requant( bias[n] + sum_k A[m][k] * W[k][n] )
// for m < M (rows, up to M_MAX) and the N = 8 output columns of one weight
// strip, over K = 8 * KT (KT k-tiles, up to KT_MAX). The driver runs one job
// per strip of 8 output columns.
//
// Buffer layouts (bytes, little-endian, int8):
//   ABUF  A[m][k]          at  m * (8*KT) + k        (row stride = K)
//   WBUF  W[k][n]          at  k * 8 + n             (one 8-byte word per k)
// The controller reads both 8 bytes (one 64-bit word) at a time.

package accel_pkg;

    localparam int N      = 8;      // the array is N x N processing elements
    localparam int M_MAX  = 16;     // rows (batch) per job
    localparam int KT_MAX = 128;    // k-tiles per job: K up to 1024

    localparam int ABUF_WORDS = M_MAX * KT_MAX;   // 64-bit words (16 KiB)
    localparam int WBUF_WORDS = KT_MAX * N;       // 64-bit words (8 KiB)

    localparam logic [31:0] ACCEL_ID = 32'h5341_0808;   // "SA", 8x8

    // AXI4-Lite byte offsets inside the accelerator's 32 KiB window
    localparam logic [14:0] REG_CTRL   = 15'h0000;  // W: bit 0 = start
    localparam logic [14:0] REG_STATUS = 15'h0004;  // R: bit 0 busy, bit 1 done (sticky)
    localparam logic [14:0] REG_MROWS  = 15'h0008;  // RW: M, 1..M_MAX
    localparam logic [14:0] REG_KTILES = 15'h000C;  // RW: KT, 1..KT_MAX
    localparam logic [14:0] REG_QUANT  = 15'h0010;  // RW: [15:0] mult, [21:16] shift, [24] relu
    localparam logic [14:0] REG_CYCLES = 15'h0014;  // R: cycles taken by the last job
    localparam logic [14:0] REG_ID     = 15'h0018;  // R: ACCEL_ID
    localparam logic [14:0] REG_BIAS   = 15'h0020;  // RW: 8 x int32, 0x20..0x3C
    localparam logic [14:0] REG_OUT8   = 15'h0100;  // R: int8 OUT[m][n] at 0x100 + 8m + n
    localparam logic [14:0] REG_ACC    = 15'h0200;  // R: int32 ACC[m][n] at 0x200 + 32m + 4n
    localparam logic [14:0] WBUF_BASE  = 15'h2000;  // RW: 8 KiB
    localparam logic [14:0] ABUF_BASE  = 15'h4000;  // RW: 16 KiB

    localparam logic [1:0] RESP_OKAY   = 2'b00;
    localparam logic [1:0] RESP_SLVERR = 2'b10;    // e.g. a write while a job runs
    localparam logic [1:0] RESP_DECERR = 2'b11;    // no register at that address

    // Requantization: int32 accumulator -> int8.
    //   y = sat8( (acc * mult + round) >>> shift ),  round = 2^(shift-1) (0 if shift = 0)
    //   then y = max(y, 0) if relu.
    // mult is unsigned 16-bit and shift is 0..63, so the scale is mult / 2^shift.
    function automatic logic [7:0] requant(input logic signed [31:0] acc,
                                           input logic [15:0] mult,
                                           input logic [5:0] shift,
                                           input logic relu);
        logic signed [63:0] prod, rnd, y;     // |acc*mult| < 2^47, rnd <= 2^62: no overflow
        prod = acc * $signed({1'b0, mult});
        rnd  = (shift == 6'd0) ? 64'sd0 : (64'sd1 <<< (shift - 6'd1));
        y    = (prod + rnd) >>> shift;
        if (relu && y < 0)  y = 0;
        if (y > 127)        return 8'sd127;
        if (y < -128)       return -8'sd128;
        return y[7:0];
    endfunction

endpackage
