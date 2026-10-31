// dpram64.sv — 64-bit wide dual-port RAM (block-RAM style, registered reads)
//
// Port A: the bus side, byte-enabled writes and reads.
// Port B: the controller side, read only.
// A read in the same cycle as a port-A write to that word returns the old
// data on both ports (read-before-write), like an FPGA block RAM.

module dpram64 #(
    parameter int WORDS = 2048
) (
    input  logic                     clk,

    input  logic [$clog2(WORDS)-1:0] a_addr,
    input  logic [7:0]               a_we,      // one bit per byte
    input  logic [63:0]              a_wdata,
    output logic [63:0]              a_rdata,

    input  logic [$clog2(WORDS)-1:0] b_addr,
    output logic [63:0]              b_rdata
);

    logic [63:0] mem [0:WORDS-1];

    initial begin
        for (int i = 0; i < WORDS; i++) mem[i] = 64'd0;
    end

    always_ff @(posedge clk) begin
        a_rdata <= mem[a_addr];
        b_rdata <= mem[b_addr];
        for (int i = 0; i < 8; i++)
            if (a_we[i]) mem[a_addr][8*i +: 8] <= a_wdata[8*i +: 8];
    end

endmodule
