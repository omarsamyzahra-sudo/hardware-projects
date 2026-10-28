// pe.sv — one processing element of the weight-stationary systolic array
//
// Holds a weight (two banks, so the next k-tile's weight can be loaded while
// the current one is in use). Every cycle it passes the activation coming
// from the left on to the right, and adds activation * weight to the partial
// sum coming from above, passing that down. Both outputs are registered, so
// data moves one PE per cycle in each direction.
//
// The bank-select bit travels with the activation: each activation brings
// the choice of weight it must be multiplied by.

module pe (
    input  logic               clk,
    input  logic               rst,

    // weight load
    input  logic               w_we,
    input  logic               w_bank,
    input  logic signed [7:0]  w_in,

    // activation, left to right
    input  logic signed [7:0]  a_in,
    input  logic               sel_in,
    output logic signed [7:0]  a_out,
    output logic               sel_out,

    // partial sum, top to bottom
    input  logic signed [31:0] ps_in,
    output logic signed [31:0] ps_out
);

    logic signed [7:0] w0, w1, w;

    always_ff @(posedge clk) begin
        if (rst) begin
            w0 <= '0;
            w1 <= '0;
        end else if (w_we) begin
            if (w_bank) w1 <= w_in;
            else        w0 <= w_in;
        end
    end

    assign w = sel_in ? w1 : w0;

    always_ff @(posedge clk) begin
        if (rst) begin
            a_out   <= '0;
            sel_out <= 1'b0;
            ps_out  <= '0;
        end else begin
            a_out   <= a_in;
            sel_out <= sel_in;
            ps_out  <= ps_in + 32'(a_in * w);
        end
    end

endmodule
