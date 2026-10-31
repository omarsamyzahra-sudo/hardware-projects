// gemv_core.sv — y = W x, L weights per cycle, FP32 accumulation
//
// x arrives first (64-bit words, 4 BF16 each) and is packed into a BRAM of
// L-wide words. Then weight chunks stream in, one per cycle:
//
//   S0  accept the chunk, read the x word for this column (sync BRAM)
//   S1  L x bf16_mul (exact products)                      -> register
//   T*  pairwise FP32 adder tree, one level per stage       -> register
//   SA  acc = (first chunk of the row ? +0 : acc) + chunk sum; on the last
//       chunk of the row, push acc to the y FIFO
//
// The accumulator add is single-cycle, so a row takes one chunk per cycle
// with no interleaved partial sums, and the summation order is exactly
// sw/golden.py gemv(). Nothing inside stalls: a chunk that starts a new row
// is only accepted if the y FIFO has room for every row already in flight.
// y leaves as 64-bit words, two FP32 values each (row 2m in the low half).

module gemv_core #(
    parameter int L      = 8,
    parameter int KMAX   = 4864,
    parameter int YDEPTH = 16
) (
    input  logic            clk,
    input  logic            rst_n,
    input  logic            clear,

    input  logic            start,
    input  logic [15:0]     rows,
    input  logic [15:0]     cols,
    output logic            busy,

    input  logic            x_valid,
    output logic            x_ready,
    input  logic [63:0]     x_data,

    input  logic            w_valid,
    output logic            w_ready,
    input  logic [16*L-1:0] w_data,
    output logic            chunk_fire,

    output logic            y_valid,
    input  logic            y_ready,
    output logic [63:0]     y_data
);

    localparam int LG  = $clog2(L);
    localparam int XW  = KMAX / L;
    localparam int XAW = $clog2(XW);
    localparam int YCW = $clog2(YDEPTH) + 1;

    // ------------------------------------------------------------ x load
    logic [16*L-1:0] xmem [XW];
    logic [16*L-1:0] xs;
    logic [LG-1:0]   xk;                          // beats packed into xs
    logic [XAW-1:0]  x_waddr;
    logic [15:0]     x_left;                      // beats still to come
    logic            x_loaded;

    assign x_ready = (x_left != 0);

    // ------------------------------------------------------ chunk issue
    logic [15:0]     cpr;                         // chunks per row
    logic [15:0]     c;                           // chunk within the row
    logic [15:0]     r_left;                      // rows not yet started
    logic [YCW-1:0]  inflight;                    // rows started, not yet in the y FIFO
    logic [YCW-1:0]  ycount;
    logic            credit_ok, fire, row_first, row_last;

    assign row_first  = (c == 16'd0);
    assign row_last   = (c == cpr - 1'b1);
    assign credit_ok  = !row_first || (32'(inflight) + 32'(ycount) < YDEPTH);
    assign w_ready    = x_loaded && (r_left != 0) && credit_ok;
    assign fire       = w_valid && w_ready;
    assign chunk_fire = fire;

    // ---------------------------------------------------------- pipeline
    logic            s1_v, s1_first, s1_last;
    logic [16*L-1:0] s1_w, s1_x;
    wire  [32*L-1:0] prod;

    // tree level k holds L>>k values; level 0 = registered products
    logic [32*L-1:0] lv    [LG+1];
    logic            lv_v  [LG+1];
    logic            lv_f  [LG+1];
    logic            lv_l  [LG+1];
    wire  [32*L-1:0] lsum  [LG];

    genvar gi, gk;
    generate
        for (gi = 0; gi < L; gi++) begin : g_mul
            bf16_mul u_mul (.a(s1_w[16*gi +: 16]), .b(s1_x[16*gi +: 16]), .y(prod[32*gi +: 32]));
        end
        for (gk = 0; gk < LG; gk++) begin : g_lvl
            for (gi = 0; gi < (L >> (gk + 1)); gi++) begin : g_add
                fp32_add u_add (.a(lv[gk][64*gi +: 32]), .b(lv[gk][64*gi + 32 +: 32]),
                                .y(lsum[gk][32*gi +: 32]));
            end
            if ((L >> (gk + 1)) < L) begin : g_pad
                assign lsum[gk][32*L-1 : 32*(L >> (gk + 1))] = '0;
            end
        end
    endgenerate

    // accumulator
    logic [31:0] acc, acc_in, acc_n;
    logic        y_push;
    assign acc_in = lv_f[LG] ? 32'd0 : acc;
    fp32_add u_acc (.a(acc_in), .b(lv[LG][31:0]), .y(acc_n));
    assign y_push = lv_v[LG] && lv_l[LG];

    always_ff @(posedge clk) begin
        if (!rst_n || clear) begin
            x_left   <= '0;
            x_loaded <= 1'b0;
            xk       <= '0;
            x_waddr  <= '0;
            r_left   <= '0;
            c        <= '0;
            inflight <= '0;
            s1_v     <= 1'b0;
            for (int k = 0; k <= LG; k++) lv_v[k] <= 1'b0;
        end else begin
            if (start) begin
                x_left   <= cols >> 2;
                x_loaded <= 1'b0;
                xk       <= '0;
                x_waddr  <= '0;
                cpr      <= cols >> LG;
                r_left   <= rows;
                c        <= '0;
            end

            // x: shift 4 BF16 in per beat; every L/4 beats is one BRAM word
            if (x_valid && x_ready) begin
                xs <= {x_data, xs[16*L-1:64]};
                if (xk == LG'(L / 4 - 1)) begin
                    xmem[x_waddr] <= {x_data, xs[16*L-1:64]};
                    x_waddr       <= x_waddr + 1'b1;
                    xk            <= '0;
                end else begin
                    xk <= xk + 1'b1;
                end
                x_left <= x_left - 1'b1;
                if (x_left == 16'd1) x_loaded <= 1'b1;
            end

            // S0
            if (fire) begin
                c <= row_last ? 16'd0 : c + 1'b1;
                if (row_last) r_left <= r_left - 1'b1;
            end
            s1_v     <= fire;
            s1_w     <= w_data;
            s1_x     <= xmem[XAW'(c)];
            s1_first <= row_first;
            s1_last  <= row_last;

            // S1 -> tree
            lv_v[0] <= s1_v;
            lv_f[0] <= s1_first;
            lv_l[0] <= s1_last;
            lv[0]   <= prod;
            for (int k = 0; k < LG; k++) begin
                lv_v[k+1] <= lv_v[k];
                lv_f[k+1] <= lv_f[k];
                lv_l[k+1] <= lv_l[k];
                lv[k+1]   <= lsum[k];
            end

            // SA
            if (lv_v[LG]) acc <= acc_n;
            inflight <= inflight + YCW'(fire && row_first) - YCW'(y_push);
        end
    end

    // ------------------------------------------------- y: FP32 -> 64-bit
    logic        yf_valid, yf_ready, have_lo;
    logic [31:0] yf_data, y_lo;

    sync_fifo #(.WIDTH(32), .DEPTH(YDEPTH)) u_yfifo (
        .clk, .rst_n, .clear,
        .in_valid(y_push), .in_ready(), .in_data(acc_n),
        .out_valid(yf_valid), .out_ready(yf_ready), .out_data(yf_data),
        .count(ycount)
    );

    assign y_valid  = have_lo && yf_valid;
    assign y_data   = {yf_data, y_lo};
    assign yf_ready = !have_lo || y_ready;

    always_ff @(posedge clk) begin
        if (!rst_n || clear) begin
            have_lo <= 1'b0;
        end else if (yf_valid && yf_ready) begin
            if (!have_lo) begin
                y_lo    <= yf_data;
                have_lo <= 1'b1;
            end else begin
                have_lo <= 1'b0;
            end
        end
    end

    assign busy = (r_left != 0) || (inflight != 0) || yf_valid || have_lo || (x_left != 0);

`ifndef SYNTHESIS
    initial begin
        if ((L & (L - 1)) != 0 || L < 4) $fatal(1, "gemv_core: L must be a power of two >= 4");
        if (KMAX % L != 0)               $fatal(1, "gemv_core: KMAX must be a multiple of L");
    end
    always @(posedge clk)
        if (rst_n && !clear && y_push && ycount == YCW'(YDEPTH)) $fatal(1, "gemv_core: y FIFO overflow");
`endif

endmodule
