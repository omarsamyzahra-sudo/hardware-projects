// soc_top.sv — riscv-core (5-stage RV32I) + RAM + the accelerator on AXI4-Lite
//
// Address map (data side; instructions come from RAM only):
//   0x0000_0000  RAM, 256 KiB (code, data, stack), block-RAM style
//   0x4000_0000  accelerator, 32 KiB AXI4-Lite window (accel_pkg.sv)
//   0x5000_0000  SYS registers:
//                  +0x00 TOHOST   W: the program's exit code (ends the simulation)
//                  +0x04 PUTCHAR  W: low byte goes to the simulation console
//                  +0x08 CYCLE    R: clock cycles since reset
//                  +0x0C BUSERR   R: [31] an AXI error happened, [17:16] its resp,
//                                    [14:0] its address. Any write clears it.
//
// The core issues a load/store from EX; the access is "accepted" at a clock
// edge where dmem_wait is low, then finishes in MEM. RAM and SYS answer in
// one cycle, like block RAM. An accelerator access becomes one AXI4-Lite
// transaction: the bridge holds dmem_wait high until the B or R response is
// back, then drops it for the one MEM cycle where the read data is valid.

module soc_top #(
    parameter int RAM_WORDS = 65536                // 256 KiB
) (
    input  logic        clk,
    input  logic        rst,

    output logic        tohost_valid,              // pulse: program exited
    output logic [31:0] tohost_data,
    output logic        putc_valid,                // pulse: a character
    output logic [7:0]  putc_char,
    output logic        accel_irq
);

    localparam int AW = $clog2(RAM_WORDS);

    // ---- the core ----
    logic [31:0] imem_addr, imem_rdata;
    logic [31:0] dmem_addr, dmem_wdata, dmem_rdata;
    logic [3:0]  dmem_wstrb;
    logic        dmem_re, dmem_wait;

    core #(.RESET_PC(32'h0)) u_core (
        .clk(clk), .rst(rst),
        .imem_addr(imem_addr), .imem_rdata(imem_rdata),
        .dmem_addr(dmem_addr), .dmem_wdata(dmem_wdata), .dmem_wstrb(dmem_wstrb),
        .dmem_re(dmem_re), .dmem_rdata(dmem_rdata), .dmem_wait(dmem_wait),
        .trace_valid(), .trace_pc(), .trace_instr(), .trace_rd_we(), .trace_rd(),
        .trace_rd_wdata(), .trace_illegal(), .trace_trap(), .trace_cause(),
        .trace_mem_addr(), .trace_mem_wstrb(), .trace_mem_wdata());

    // ---- decode of the access in EX ----
    typedef enum logic [1:0] { S_RAM, S_ACCEL, S_SYS, S_NONE } sel_t;
    sel_t sel_x, sel_m;
    always_comb begin
        if (dmem_addr[31:AW+2] == '0)                sel_x = S_RAM;
        else if (dmem_addr[31:15] == 17'h0_8000)     sel_x = S_ACCEL;   // 0x4000_0000
        else if (dmem_addr[31:8] == 24'h50_0000)     sel_x = S_SYS;
        else                                         sel_x = S_NONE;
    end

    logic access, accept;
    assign access = dmem_re || dmem_wstrb != 4'b0000;
    assign accept = access && !dmem_wait;           // taken at this clock edge

    always_ff @(posedge clk)
        if (rst || (!dmem_wait && !access)) sel_m <= S_NONE;
        else if (!dmem_wait)                sel_m <= sel_x;

    // ---- RAM: one array, instruction port + data port ----
    logic [31:0] ram [0:RAM_WORDS-1];
    logic [31:0] ram_q;
    initial begin
        string hex;
        for (int i = 0; i < RAM_WORDS; i++) ram[i] = 32'd0;
        if ($value$plusargs("HEX=%s", hex)) $readmemh(hex, ram);
    end
    always_ff @(posedge clk) begin
        imem_rdata <= ram[imem_addr[AW+1:2]];
        if (!dmem_wait) ram_q <= ram[dmem_addr[AW+1:2]];
        for (int b = 0; b < 4; b++)
            if (accept && sel_x == S_RAM && dmem_wstrb[b])
                ram[dmem_addr[AW+1:2]][8*b +: 8] <= dmem_wdata[8*b +: 8];
    end

    // ---- SYS registers ----
    logic [31:0] cycle, sys_q, buserr;
    logic        axi_err;               // from the bridge, below
    logic [1:0]  axi_err_resp;
    logic [14:0] axi_err_addr;

    always_ff @(posedge clk) begin
        if (rst) begin
            cycle <= '0; sys_q <= '0; buserr <= '0;
            tohost_valid <= 1'b0; putc_valid <= 1'b0;
        end else begin
            cycle <= cycle + 32'd1;
            tohost_valid <= 1'b0;
            putc_valid   <= 1'b0;
            if (accept && sel_x == S_SYS) begin
                case (dmem_addr[7:2])
                    6'd2:    sys_q <= cycle;
                    6'd3:    sys_q <= buserr;
                    default: sys_q <= '0;
                endcase
                if (dmem_wstrb != 4'b0000)
                    case (dmem_addr[7:2])
                        6'd0: begin tohost_valid <= 1'b1; tohost_data <= dmem_wdata; end
                        6'd1: begin putc_valid <= 1'b1; putc_char <= dmem_wdata[7:0]; end
                        6'd3: buserr <= '0;
                        default: ;
                    endcase
            end
            if (axi_err) buserr <= {1'b1, 13'd0, axi_err_resp, 1'b0, axi_err_addr};
        end
    end

`ifndef SYNTHESIS
    // simulation console: PUTCHAR goes to stdout and to the +LOG=<file>
    int log_fd = 0;
    initial begin
        string log_name;
        if ($value$plusargs("LOG=%s", log_name)) log_fd = $fopen(log_name, "w");
    end
    always_ff @(posedge clk)
        if (putc_valid) begin
            $write("%c", putc_char);
            if (log_fd != 0) begin
                $fwrite(log_fd, "%c", putc_char);
                $fflush(log_fd);
            end
        end
`endif

    // ---- dmem -> AXI4-Lite bridge ----
    logic [14:0] m_awaddr, m_araddr;
    logic        m_awvalid, m_awready, m_wvalid, m_wready, m_bvalid, m_bready;
    logic        m_arvalid, m_arready, m_rvalid, m_rready;
    logic [31:0] m_wdata, m_rdata;
    logic [3:0]  m_wstrb;
    logic [1:0]  m_bresp, m_rresp;

    typedef enum logic [1:0] { B_IDLE, B_REQ, B_RESP, B_DONE } bstate_t;
    bstate_t     bst;
    logic        b_write;
    logic [31:0] b_rdata;

    assign dmem_wait = (bst == B_REQ || bst == B_RESP) && !rst;

    assign m_awvalid = bst == B_REQ && b_write;
    assign m_wvalid  = bst == B_REQ && b_write;
    assign m_arvalid = bst == B_REQ && !b_write;
    assign m_bready  = 1'b1;
    assign m_rready  = 1'b1;

    always_ff @(posedge clk) begin
        axi_err <= 1'b0;
        if (rst) begin
            bst <= B_IDLE;
        end else begin
            case (bst)
                B_REQ:
                    if (b_write ? (m_awready && m_wready) : m_arready) bst <= B_RESP;
                B_RESP:
                    if (b_write ? m_bvalid : m_rvalid) begin
                        bst     <= B_DONE;
                        b_rdata <= m_rdata;
                        if ((b_write ? m_bresp : m_rresp) != 2'b00) begin
                            axi_err      <= 1'b1;
                            axi_err_resp <= b_write ? m_bresp : m_rresp;
                            axi_err_addr <= b_write ? m_awaddr : m_araddr;
                        end
                    end
                default: bst <= B_IDLE;     // IDLE, or DONE for its one cycle
            endcase
            // a new accelerator access is accepted (only when not waiting)
            if (accept && sel_x == S_ACCEL) begin
                bst      <= B_REQ;
                b_write  <= dmem_wstrb != 4'b0000;
                m_awaddr <= dmem_addr[14:0];
                m_araddr <= dmem_addr[14:0];
                m_wdata  <= dmem_wdata;
                m_wstrb  <= dmem_wstrb;
            end
        end
    end

    accel_axil u_accel (
        .clk(clk), .rst(rst),
        .s_awaddr(m_awaddr), .s_awvalid(m_awvalid), .s_awready(m_awready),
        .s_wdata(m_wdata), .s_wstrb(m_wstrb), .s_wvalid(m_wvalid), .s_wready(m_wready),
        .s_bresp(m_bresp), .s_bvalid(m_bvalid), .s_bready(m_bready),
        .s_araddr(m_araddr), .s_arvalid(m_arvalid), .s_arready(m_arready),
        .s_rdata(m_rdata), .s_rresp(m_rresp), .s_rvalid(m_rvalid), .s_rready(m_rready),
        .irq(accel_irq));

    // ---- what MEM sees ----
    always_comb
        case (sel_m)
            S_RAM:   dmem_rdata = ram_q;
            S_SYS:   dmem_rdata = sys_q;
            S_ACCEL: dmem_rdata = b_rdata;
            default: dmem_rdata = 32'd0;
        endcase

endmodule
