// pe.vh — black-box view of the hardened PE macro for top-level synthesis
module pe (
`ifdef USE_POWER_PINS
    inout         VPWR,
    inout         VGND,
`endif
    input         clk,
    input         rst,
    input         w_we,
    input         w_bank,
    input  [7:0]  w_in,
    input  [7:0]  a_in,
    input         sel_in,
    output [7:0]  a_out,
    output        sel_out,
    input  [31:0] ps_in,
    output [31:0] ps_out
);
endmodule
