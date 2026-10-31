// accel_core.sv — job controller: buffers -> systolic array -> accumulate -> requantize
//
// A job (see accel_pkg.sv) runs K-tile by K-tile. For k-tile t:
//   1. the LOADER reads the 8 weight rows W[8t .. 8t+7][0..7] from WBUF and
//      writes them into weight bank t % 2 of the array, one row per cycle;
//   2. the STREAMER, once tile t is loaded, reads A[m][8t .. 8t+7] from ABUF
//      for m = 0..M-1 and feeds one row per cycle into the array;
//   3. each result row y[0..7] (2N-1 cycles later) is accumulated:
//      ACC[m][n] = (t == 0 ? bias[n] : ACC[m][n]) + y[n].
// After the last tile, every ACC row is requantized to int8 (one row per
// cycle) into OUT8, and the job is done.
//
// Double buffering: while the streamer works on tile t (bank t % 2), the
// loader fills tile t + 1 into the other bank, so weight loading hides
// behind compute. The loader may only overwrite a bank once the last row
// that used it has passed every PE row. If that row's ABUF read is issued in
// cycle c, PE row r last uses its weight in cycle c + r + N. A load that
// starts (ld_go) in cycle g makes PE row r's new weight visible in cycle
// g + r + 3. So g >= c + N - 2: cool[] is set to N - 3 at the end of cycle c
// and the load may start once it reaches 0. (test_corner_shapes with M = 1
// runs exactly on this boundary; one cycle less and the results go wrong.)
//
// Throughput: about max(M, N + 1) cycles per k-tile once the pipeline is
// full, plus 2N - 1 cycles of drain and M cycles of requantization per job.

import accel_pkg::*;

module accel_core (
    input  logic                    clk,
    input  logic                    rst,

    // job configuration, sampled on start
    input  logic                    start,
    input  logic [4:0]              cfg_m,       // 1..M_MAX
    input  logic [7:0]              cfg_kt,      // 1..KT_MAX
    input  logic [15:0]             cfg_mult,
    input  logic [5:0]              cfg_shift,
    input  logic                    cfg_relu,
    input  logic [N-1:0][31:0]      cfg_bias,

    output logic                    busy,
    output logic                    done,        // one-cycle pulse at the end of a job
    output logic [31:0]             cycles,      // length of the last job

    // buffer read ports (registered reads: data the cycle after the address)
    output logic [$clog2(ABUF_WORDS)-1:0] a_raddr,
    input  logic [63:0]                   a_rdata,
    output logic [$clog2(WBUF_WORDS)-1:0] w_raddr,
    input  logic [63:0]                   w_rdata,

    // results, one row at a time
    input  logic [3:0]              res_m,
    output logic [N-1:0][31:0]      res_acc,
    output logic [N-1:0][7:0]       res_out8
);

    localparam int TAGW = 6;               // {first, last, m[3:0]}

    // ---- configuration latched at start ----
    logic [4:0]          m_q;
    logic [7:0]          kt_q;
    logic [15:0]         mult_q;
    logic [5:0]          shift_q;
    logic                relu_q;
    logic [N-1:0][31:0]  bias_q;

    // ---- phases ----
    logic                running;          // loading/streaming/accumulating
    logic                rq_active;        // requantizing
    logic [3:0]          rq_m;

    assign busy = running || rq_active;

    // the array's output side (driven further down)
    logic                 arr_v;
    logic [TAGW-1:0]      arr_tag;
    logic [N-1:0][31:0]   arr_y;
    logic                 arr_first, arr_last;
    logic [3:0]           arr_m;
    logic                 acc_last_row;    // the job's final result row is arriving

    // ==================================================================
    // Loader
    // ==================================================================
    logic [7:0]  ld_kt;            // next tile to load
    logic [3:0]  ld_row;           // row being issued, 0..N-1
    logic        ld_active;
    logic [8:0]  ld_done;          // tiles fully loaded
    logic        ld_wr;            // a WBUF read was issued last cycle
    logic [2:0]  ld_wr_row;
    logic        ld_wr_bank;
    logic [1:0][3:0] cool;         // per bank: cycles until it may be overwritten

    // tiles whose activations have all been issued
    logic [8:0]  st_done;

    logic        bank_free;
    assign bank_free = (ld_kt < 8'd2) ||
                       ({1'b0, ld_kt} <= st_done + 9'd1 && cool[ld_kt[0]] == 4'd0);

    logic ld_go;
    assign ld_go = running && !ld_active && ld_kt < kt_q && bank_free;

    assign w_raddr = 10'(ld_kt) * 10'(N) + 10'(ld_row);

    // ==================================================================
    // Streamer
    // ==================================================================
    logic [7:0]  st_kt;
    logic [3:0]  st_m;
    logic        st_issue;
    logic        st_v;             // an ABUF read was issued last cycle
    logic [TAGW-1:0] st_tag;
    logic        st_sel;

    assign st_issue = running && st_kt < kt_q && {1'b0, st_kt} < ld_done;
    assign a_raddr  = 11'(st_m) * 11'(kt_q) + 11'(st_kt);

    always_ff @(posedge clk) begin
        if (rst) begin
            running   <= 1'b0;
            ld_kt     <= '0;
            ld_row    <= '0;
            ld_active <= 1'b0;
            ld_done   <= '0;
            ld_wr     <= 1'b0;
            ld_wr_row <= '0;
            ld_wr_bank<= 1'b0;
            cool      <= '0;
            st_kt     <= '0;
            st_m      <= '0;
            st_done   <= '0;
            st_v      <= 1'b0;
            st_tag    <= '0;
            st_sel    <= 1'b0;
        end else if (start && !busy) begin
            running   <= 1'b1;
            ld_kt     <= '0;
            ld_row    <= '0;
            ld_active <= 1'b0;
            ld_done   <= '0;
            ld_wr     <= 1'b0;
            cool      <= '0;
            st_kt     <= '0;
            st_m      <= '0;
            st_done   <= '0;
            st_v      <= 1'b0;
        end else begin
            // cool-down counters
            for (int b = 0; b < 2; b++)
                if (cool[b] != 4'd0) cool[b] <= cool[b] - 4'd1;

            // loader: issue N row reads, write each into the array a cycle later
            ld_wr <= 1'b0;
            if (ld_go) begin
                ld_active <= 1'b1;
                ld_row    <= 4'd0;
            end
            if (ld_active) begin
                ld_wr      <= 1'b1;
                ld_wr_row  <= ld_row[2:0];
                ld_wr_bank <= ld_kt[0];
                if (ld_row == 4'(N - 1)) begin
                    ld_active <= 1'b0;
                    ld_kt     <= ld_kt + 8'd1;
                end else begin
                    ld_row <= ld_row + 4'd1;
                end
            end
            if (ld_wr && ld_wr_row == 3'(N - 1))
                ld_done <= ld_done + 9'd1;         // last row written: tile ready

            // streamer: one ABUF read per cycle while the tile is loaded
            st_v <= st_issue;
            if (st_issue) begin
                st_tag <= {st_kt == 8'd0, st_kt == kt_q - 8'd1, st_m};
                st_sel <= st_kt[0];
                if ({1'b0, st_m} == m_q - 5'd1) begin
                    st_m      <= '0;
                    st_kt     <= st_kt + 8'd1;
                    st_done   <= st_done + 9'd1;
                    cool[st_kt[0]] <= 4'(N - 3);
                end else begin
                    st_m <= st_m + 4'd1;
                end
            end

            if (acc_last_row) running <= 1'b0;
        end
    end

    // The loader issues its WBUF reads during the N ld_active cycles (row
    // ld_row each); the data arrives the next cycle, together with ld_wr.

    // ==================================================================
    // The array
    // ==================================================================
    systolic_array #(.N(N), .TAGW(TAGW)) u_array (
        .clk       (clk),
        .rst       (rst),
        .w_row_we  (ld_wr),
        .w_row     (ld_wr_row),
        .w_bank    (ld_wr_bank),
        .w_data    (w_rdata),
        .in_valid  (st_v),
        .in_tag    (st_tag),
        .in_sel    (st_sel),
        .in_a      (a_rdata),
        .out_valid (arr_v),
        .out_tag   (arr_tag),
        .out_y     (arr_y)
    );

    // ==================================================================
    // Accumulate, then requantize
    // ==================================================================
    // one entry per result row; whole rows are read and written at once
    logic [N-1:0][31:0] acc  [M_MAX];
    logic [N-1:0][7:0]  out8 [M_MAX];

    logic [N-1:0][31:0] acc_old, acc_new;   // the row being accumulated
    logic [N-1:0][31:0] rq_acc;             // the row being requantized
    logic [N-1:0][7:0]  rq_out;
    assign acc_old = acc[arr_m];
    assign rq_acc  = acc[rq_m];
    for (genvar n = 0; n < N; n++) begin : g_row
        assign acc_new[n] = (arr_first ? bias_q[n] : acc_old[n]) + arr_y[n];
        assign rq_out[n]  = requant(rq_acc[n], mult_q, shift_q, relu_q);
    end

    assign {arr_first, arr_last, arr_m} = arr_tag;
    assign acc_last_row = arr_v && arr_last && {1'b0, arr_m} == m_q - 5'd1;

    always_ff @(posedge clk) begin
        if (arr_v) acc[arr_m] <= acc_new;
    end

    always_ff @(posedge clk) begin
        if (rst) begin
            rq_active <= 1'b0;
            rq_m      <= '0;
            done      <= 1'b0;
        end else begin
            done <= 1'b0;
            if (acc_last_row) begin
                rq_active <= 1'b1;
                rq_m      <= '0;
            end else if (rq_active) begin
                out8[rq_m] <= rq_out;
                if ({1'b0, rq_m} == m_q - 5'd1) begin
                    rq_active <= 1'b0;
                    done      <= 1'b1;
                end else begin
                    rq_m <= rq_m + 4'd1;
                end
            end
        end
    end

    // ---- configuration and the cycle counter ----
    logic [31:0] cyc;
    always_ff @(posedge clk) begin
        if (rst) begin
            m_q <= 5'd1; kt_q <= 8'd1; mult_q <= '0; shift_q <= '0; relu_q <= 1'b0;
            bias_q <= '0; cyc <= '0; cycles <= '0;
        end else if (start && !busy) begin
            m_q <= cfg_m; kt_q <= cfg_kt; mult_q <= cfg_mult; shift_q <= cfg_shift;
            relu_q <= cfg_relu; bias_q <= cfg_bias;
            cyc <= 32'd1;
        end else if (busy) begin
            cyc <= cyc + 32'd1;
            if (rq_active && {1'b0, rq_m} == m_q - 5'd1) cycles <= cyc + 32'd1;
        end
    end

    // ---- result read port ----
    assign res_acc  = acc[res_m];
    assign res_out8 = out8[res_m];

endmodule
