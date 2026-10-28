// systolic_array.sv — N x N weight-stationary systolic array with skew/deskew
//
// PE[k][n] holds W[k][n]. One input row a[0..N-1] (one row of A, one k-tile
// wide) goes in per cycle; N column sums  y[n] = sum_k a[k] * W[k][n]  come
// out per cycle, 2N-1 cycles later. Inside:
//
//   a[k] enters PE row k after k cycles of skew, then moves right one PE per
//   cycle. Partial sums start at 0 above row 0 and move down one PE per
//   cycle, so the wavefront for one input row reaches PE[k][n] at cycle
//   k + n, exactly when the partial sum from PE[k-1][n] arrives. Column n's
//   sum leaves the bottom at cycle N + n; deskewing column n by N-1-n lines
//   all columns up again at cycle 2N-1.
//
//   a[0] ─►PE00─►PE01─►…            (row k delayed k cycles before entering)
//            ▼     ▼
//   a[1] ─►PE10─►PE11─►…
//            ▼     ▼
//            …     …   ──► deskew ──► y[0..N-1]
//
// The PEs don't need valid bits: each wavefront only ever meets its own
// data, so a bubble just produces a sum nobody reads. Validity (and a tag
// the controller attaches, e.g. the row index) rides alongside in a delay
// line of the same 2N-1 cycles.
//
// Weights: a row of PEs is written in one cycle (w_row_we/w_row/w_bank).
// sel picks the bank each input row is multiplied by; the controller writes
// one bank while the array computes with the other.

module systolic_array #(
    parameter int N    = 8,
    parameter int TAGW = 8
) (
    input  logic                   clk,
    input  logic                   rst,

    // weight load: PE[w_row][n] bank w_bank <= w_data[n]
    input  logic                   w_row_we,
    input  logic [$clog2(N)-1:0]   w_row,
    input  logic                   w_bank,
    input  logic [N-1:0][7:0]      w_data,

    // one input row per cycle
    input  logic                   in_valid,
    input  logic [TAGW-1:0]        in_tag,
    input  logic                   in_sel,      // weight bank for this row
    input  logic [N-1:0][7:0]      in_a,

    // one result row per cycle, LATENCY cycles later
    output logic                   out_valid,
    output logic [TAGW-1:0]        out_tag,
    output logic [N-1:0][31:0]     out_y
);

    localparam int LATENCY = 2 * N - 1;

    // ---- input skew: row k delayed k cycles (row 0 not at all) ----
    logic [N-1:0][7:0] a_sk;
    logic [N-1:0]      sel_sk;

    genvar k, n;
    generate
        for (k = 0; k < N; k++) begin : g_skew
            if (k == 0) begin : g_none
                assign a_sk[0]   = in_a[0];
                assign sel_sk[0] = in_sel;
            end else begin : g_delay
                logic [k-1:0][7:0] a_d;
                logic [k-1:0]      s_d;
                always_ff @(posedge clk) begin
                    if (rst) begin
                        a_d <= '0;
                        s_d <= '0;
                    end else begin
                        a_d[0] <= in_a[k];
                        s_d[0] <= in_sel;
                        for (int i = 1; i < k; i++) begin
                            a_d[i] <= a_d[i-1];
                            s_d[i] <= s_d[i-1];
                        end
                    end
                end
                assign a_sk[k]   = a_d[k-1];
                assign sel_sk[k] = s_d[k-1];
            end
        end
    endgenerate

    // ---- the PE grid ----
    // a_h[k][n] / sel_h[k][n]: activation entering PE[k][n] from the left
    // ps_v[k][n]: partial sum entering PE[k][n] from above (ps_v[N] = bottom)
    logic [N-1:0][N:0][7:0]  a_h;
    logic [N-1:0][N:0]       sel_h;
    logic [N:0][N-1:0][31:0] ps_v;

    generate
        for (k = 0; k < N; k++) begin : g_row
            assign a_h[k][0]   = a_sk[k];
            assign sel_h[k][0] = sel_sk[k];
            for (n = 0; n < N; n++) begin : g_col
                if (k == 0) begin : g_top
                    assign ps_v[0][n] = '0;
                end
                pe u_pe (
                    .clk     (clk),
                    .rst     (rst),
                    .w_we    (w_row_we && w_row == k),
                    .w_bank  (w_bank),
                    .w_in    (w_data[n]),
                    .a_in    (a_h[k][n]),
                    .sel_in  (sel_h[k][n]),
                    .a_out   (a_h[k][n+1]),
                    .sel_out (sel_h[k][n+1]),
                    .ps_in   (ps_v[k][n]),
                    .ps_out  (ps_v[k+1][n])
                );
            end
        end
    endgenerate

    // ---- output deskew: column n delayed N-1-n cycles ----
    generate
        for (n = 0; n < N; n++) begin : g_deskew
            localparam int D = N - 1 - n;
            if (D == 0) begin : g_none
                assign out_y[n] = ps_v[N][n];
            end else begin : g_delay
                logic [D-1:0][31:0] y_d;
                always_ff @(posedge clk) begin
                    if (rst) y_d <= '0;
                    else begin
                        y_d[0] <= ps_v[N][n];
                        for (int i = 1; i < D; i++) y_d[i] <= y_d[i-1];
                    end
                end
                assign out_y[n] = y_d[D-1];
            end
        end
    endgenerate

    // ---- valid/tag delay line, LATENCY cycles ----
    logic [LATENCY-1:0]           v_d;
    logic [LATENCY-1:0][TAGW-1:0] t_d;

    always_ff @(posedge clk) begin
        if (rst) begin
            v_d <= '0;
            t_d <= '0;
        end else begin
            v_d[0] <= in_valid;
            t_d[0] <= in_tag;
            for (int i = 1; i < LATENCY; i++) begin
                v_d[i] <= v_d[i-1];
                t_d[i] <= t_d[i-1];
            end
        end
    end

    assign out_valid = v_d[LATENCY-1];
    assign out_tag   = t_d[LATENCY-1];

endmodule
