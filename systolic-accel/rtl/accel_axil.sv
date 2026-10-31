// accel_axil.sv — the accelerator as an AXI4-Lite slave (32-bit data, 32 KiB window)
//
// Contains the register file (map in accel_pkg.sv), the two operand buffers
// (dpram64: bus on port A, controller on port B) and accel_core.
//
// Bus rules:
//   * A write needs AW and W together; it is accepted in one cycle and
//     answered on B the next. Only one write is outstanding at a time.
//   * A read is accepted on AR, the buffer/register is read the next cycle
//     and R is valid the cycle after that (2 cycles AR -> R).
//   * Writes win port A of a buffer: AR is not accepted in a cycle where a
//     write is accepted.
//   * Responses: SLVERR for any write while a job is running, for writes to
//     read-only registers, and for a start with M or KT out of range;
//     DECERR for addresses with nothing behind them.

import accel_pkg::*;

module accel_axil (
    input  logic        clk,
    input  logic        rst,

    input  logic [14:0] s_awaddr,
    input  logic        s_awvalid,
    output logic        s_awready,
    input  logic [31:0] s_wdata,
    input  logic [3:0]  s_wstrb,
    input  logic        s_wvalid,
    output logic        s_wready,
    output logic [1:0]  s_bresp,
    output logic        s_bvalid,
    input  logic        s_bready,

    input  logic [14:0] s_araddr,
    input  logic        s_arvalid,
    output logic        s_arready,
    output logic [31:0] s_rdata,
    output logic [1:0]  s_rresp,
    output logic        s_rvalid,
    input  logic        s_rready,

    output logic        irq            // high while STATUS.done is set
);

    // ---- address decode ----
    typedef enum logic [3:0] {
        R_CTRL, R_STATUS, R_MROWS, R_KTILES, R_QUANT, R_CYCLES, R_ID, R_BIAS,
        R_OUT8, R_ACC, R_WBUF, R_ABUF, R_NONE
    } region_t;

    function automatic region_t decode(input logic [14:0] a);
        if (a[14])                          return R_ABUF;
        if (a[13])                          return R_WBUF;
        if (a[12:9] == 4'b0001)             return R_ACC;      // 0x200..0x3FF
        if (a[12:7] == 6'b000010)           return R_OUT8;     // 0x100..0x17F
        if (a[12:5] == 8'h01)               return R_BIAS;     // 0x20..0x3F
        if (a[12:5] != 8'h00)               return R_NONE;
        case (a[4:2])
            3'd0: return R_CTRL;
            3'd1: return R_STATUS;
            3'd2: return R_MROWS;
            3'd3: return R_KTILES;
            3'd4: return R_QUANT;
            3'd5: return R_CYCLES;
            3'd6: return R_ID;
            default: return R_NONE;
        endcase
    endfunction

    function automatic logic [31:0] merge(input logic [31:0] old, input logic [31:0] d,
                                          input logic [3:0] strb);
        for (int i = 0; i < 4; i++)
            if (strb[i]) old[8*i +: 8] = d[8*i +: 8];
        return old;
    endfunction

    // ---- registers ----
    logic [4:0]         mrows;
    logic [7:0]         ktiles;
    logic [31:0]        quant;
    logic [N-1:0][31:0] bias;
    logic               done_sticky;

    logic               busy, core_done, start;
    logic               done_now;      // core_done is high the cycle busy drops,
    assign done_now = done_sticky || core_done;   // before done_sticky catches up
    logic [31:0]        cycles;

    // ---- buffers ----
    logic [10:0] abuf_a_addr, abuf_b_addr;
    logic [9:0]  wbuf_a_addr, wbuf_b_addr;
    logic [7:0]  abuf_we, wbuf_we;
    logic [63:0] abuf_a_rdata, abuf_b_rdata, wbuf_a_rdata, wbuf_b_rdata;
    logic [63:0] buf_wdata;

    dpram64 #(.WORDS(ABUF_WORDS)) u_abuf (
        .clk(clk), .a_addr(abuf_a_addr), .a_we(abuf_we), .a_wdata(buf_wdata),
        .a_rdata(abuf_a_rdata), .b_addr(abuf_b_addr), .b_rdata(abuf_b_rdata));

    dpram64 #(.WORDS(WBUF_WORDS)) u_wbuf (
        .clk(clk), .a_addr(wbuf_a_addr), .a_we(wbuf_we), .a_wdata(buf_wdata),
        .a_rdata(wbuf_a_rdata), .b_addr(wbuf_b_addr), .b_rdata(wbuf_b_rdata));

    // ---- write channel ----
    logic    wr_fire;
    region_t wr_reg;
    logic    wr_ok_range;            // start with legal M and KT

    assign wr_fire   = s_awvalid && s_wvalid && !s_bvalid;
    assign s_awready = wr_fire;
    assign s_wready  = wr_fire;
    assign wr_reg    = decode(s_awaddr);
    assign wr_ok_range = mrows >= 5'd1 && mrows <= 5'(M_MAX) &&
                         ktiles >= 8'd1 && {1'b0, ktiles} <= 9'(KT_MAX);

    logic [1:0] wr_resp;
    always_comb begin
        if (wr_reg == R_NONE)
            wr_resp = RESP_DECERR;
        else if (busy)
            wr_resp = RESP_SLVERR;
        else case (wr_reg)
            R_STATUS, R_CYCLES, R_ID, R_OUT8, R_ACC: wr_resp = RESP_SLVERR;
            R_CTRL: wr_resp = (s_wstrb[0] && s_wdata[0] && !wr_ok_range) ? RESP_SLVERR
                                                                           : RESP_OKAY;
            default: wr_resp = RESP_OKAY;
        endcase
    end

    logic wr_do;                     // the write takes effect
    assign wr_do = wr_fire && wr_resp == RESP_OKAY;
    assign start = wr_do && wr_reg == R_CTRL && s_wstrb[0] && s_wdata[0];

    assign buf_wdata = {s_wdata, s_wdata};
    assign abuf_we   = (wr_do && wr_reg == R_ABUF) ? 8'(s_wstrb) << (s_awaddr[2] * 4) : 8'd0;
    assign wbuf_we   = (wr_do && wr_reg == R_WBUF) ? 8'(s_wstrb) << (s_awaddr[2] * 4) : 8'd0;

    always_ff @(posedge clk) begin
        if (rst) begin
            s_bvalid    <= 1'b0;
            s_bresp     <= RESP_OKAY;
            mrows       <= 5'd1;
            ktiles      <= 8'd1;
            quant       <= 32'd1;           // mult 1, shift 0, no relu
            bias        <= '0;
            done_sticky <= 1'b0;
        end else begin
            if (s_bvalid && s_bready) s_bvalid <= 1'b0;
            if (wr_fire) begin
                s_bvalid <= 1'b1;
                s_bresp  <= wr_resp;
            end
            if (wr_do)
                case (wr_reg)
                    R_MROWS:  mrows  <= 5'(merge(32'(mrows), s_wdata, s_wstrb));
                    R_KTILES: ktiles <= 8'(merge(32'(ktiles), s_wdata, s_wstrb));
                    R_QUANT:  quant  <= merge(quant, s_wdata, s_wstrb) & 32'h013F_FFFF;
                    R_BIAS:   bias[s_awaddr[4:2]] <= merge(bias[s_awaddr[4:2]], s_wdata, s_wstrb);
                    default: ;
                endcase
            if (start)          done_sticky <= 1'b0;
            else if (core_done) done_sticky <= 1'b1;
        end
    end

    // ---- read channel: AR -> (RAM read) -> R ----
    logic        rd_pend;            // accepted, data being read
    logic [14:0] rd_addr;
    region_t     rd_reg;

    assign s_arready = s_arvalid && !rd_pend && !s_rvalid && !wr_fire;
    assign rd_reg    = decode(rd_addr);

    // port A address: the write's address in a write cycle, else the read's
    assign abuf_a_addr = wr_fire ? 11'(s_awaddr[13:3]) : 11'(s_araddr[13:3]);
    assign wbuf_a_addr = wr_fire ? 10'(s_awaddr[12:3]) : 10'(s_araddr[12:3]);

    // result rows for OUT8 / ACC reads
    logic [3:0]         res_m;
    logic [N-1:0][31:0] res_acc;
    logic [N-1:0][7:0]  res_out8;
    assign res_m = (rd_reg == R_OUT8) ? rd_addr[6:3] : rd_addr[8:5];

    logic [31:0] rd_data;
    logic [63:0] rd_word;
    always_comb begin
        rd_word = (rd_reg == R_ABUF) ? abuf_a_rdata : wbuf_a_rdata;
        case (rd_reg)
            R_STATUS: rd_data = {30'd0, done_now, busy};
            R_MROWS:  rd_data = 32'(mrows);
            R_KTILES: rd_data = 32'(ktiles);
            R_QUANT:  rd_data = quant;
            R_CYCLES: rd_data = cycles;
            R_ID:     rd_data = ACCEL_ID;
            R_BIAS:   rd_data = bias[rd_addr[4:2]];
            R_OUT8:   rd_data = rd_addr[2] ? res_out8[7:4] : res_out8[3:0];
            R_ACC:    rd_data = res_acc[rd_addr[4:2]];
            R_WBUF, R_ABUF: rd_data = rd_addr[2] ? rd_word[63:32] : rd_word[31:0];
            default:  rd_data = 32'd0;        // CTRL reads as 0, NONE too
        endcase
    end

    always_ff @(posedge clk) begin
        if (rst) begin
            rd_pend  <= 1'b0;
            rd_addr  <= '0;
            s_rvalid <= 1'b0;
            s_rdata  <= '0;
            s_rresp  <= RESP_OKAY;
        end else begin
            if (s_rvalid && s_rready) s_rvalid <= 1'b0;
            if (s_arready) begin
                rd_pend <= 1'b1;
                rd_addr <= s_araddr;
            end
            if (rd_pend) begin
                rd_pend  <= 1'b0;
                s_rvalid <= 1'b1;
                s_rdata  <= rd_data;
                s_rresp  <= (rd_reg == R_NONE) ? RESP_DECERR : RESP_OKAY;
            end
        end
    end

    assign irq = done_now;

    // ---- the engine ----
    accel_core u_core (
        .clk       (clk),
        .rst       (rst),
        .start     (start),
        .cfg_m     (mrows),
        .cfg_kt    (ktiles),
        .cfg_mult  (quant[15:0]),
        .cfg_shift (quant[21:16]),
        .cfg_relu  (quant[24]),
        .cfg_bias  (bias),
        .busy      (busy),
        .done      (core_done),
        .cycles    (cycles),
        .a_raddr   (abuf_b_addr),
        .a_rdata   (abuf_b_rdata),
        .w_raddr   (wbuf_b_addr),
        .w_rdata   (wbuf_b_rdata),
        .res_m     (res_m),
        .res_acc   (res_acc),
        .res_out8  (res_out8)
    );

endmodule
