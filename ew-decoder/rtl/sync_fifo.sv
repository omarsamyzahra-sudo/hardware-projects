// sync_fifo.sv — single-clock FIFO, show-ahead (head visible while valid)
//
// DEPTH must be a power of two. `clear` empties it in one cycle; callers
// only clear between jobs, when nothing is in flight.

module sync_fifo #(
    parameter int WIDTH = 64,
    parameter int DEPTH = 16
) (
    input  logic                     clk,
    input  logic                     rst_n,
    input  logic                     clear,
    input  logic                     in_valid,
    output logic                     in_ready,
    input  logic [WIDTH-1:0]         in_data,
    output logic                     out_valid,
    input  logic                     out_ready,
    output logic [WIDTH-1:0]         out_data,
    output logic [$clog2(DEPTH):0]   count
);

    localparam int AW = $clog2(DEPTH);

    logic [WIDTH-1:0] mem [DEPTH];
    logic [AW:0]      wp, rp;

    assign count     = wp - rp;
    assign in_ready  = (count != (AW+1)'(DEPTH));
    assign out_valid = (count != '0);
    assign out_data  = mem[rp[AW-1:0]];

    always_ff @(posedge clk) begin
        if (!rst_n || clear) begin
            wp <= '0;
            rp <= '0;
        end else begin
            if (in_valid && in_ready) begin
                mem[wp[AW-1:0]] <= in_data;
                wp <= wp + 1'b1;
            end
            if (out_valid && out_ready)
                rp <= rp + 1'b1;
        end
    end

endmodule
