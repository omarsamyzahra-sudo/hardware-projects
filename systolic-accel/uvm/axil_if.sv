// axil_if.sv — AXI4-Lite interface with protocol assertions (SVA)
//
// The assertions check the AXI4-Lite handshake rules on every cycle,
// whoever drives the bus: once VALID is high it stays high, with the
// payload stable, until READY; the slave only responds to requests it
// accepted; and the response codes are ones this slave may return.

interface axil_if (input logic clk, input logic rst);

    logic [14:0] awaddr;  logic awvalid, awready;
    logic [31:0] wdata;   logic [3:0] wstrb;  logic wvalid, wready;
    logic [1:0]  bresp;   logic bvalid, bready;
    logic [14:0] araddr;  logic arvalid, arready;
    logic [31:0] rdata;   logic [1:0] rresp;  logic rvalid, rready;

    // ---- master side: VALID held, payload stable, until READY ----
    a_aw_hold: assert property (@(posedge clk) disable iff (rst)
        awvalid && !awready |=> awvalid && $stable(awaddr)) else $error("SVA a_aw_hold failed");
    a_w_hold: assert property (@(posedge clk) disable iff (rst)
        wvalid && !wready |=> wvalid && $stable(wdata) && $stable(wstrb)) else $error("SVA a_w_hold failed");
    a_ar_hold: assert property (@(posedge clk) disable iff (rst)
        arvalid && !arready |=> arvalid && $stable(araddr)) else $error("SVA a_ar_hold failed");

    // ---- slave side ----
    a_b_hold: assert property (@(posedge clk) disable iff (rst)
        bvalid && !bready |=> bvalid && $stable(bresp)) else $error("SVA a_b_hold failed");
    a_r_hold: assert property (@(posedge clk) disable iff (rst)
        rvalid && !rready |=> rvalid && $stable(rdata) && $stable(rresp)) else $error("SVA a_r_hold failed");
    a_no_exokay_b: assert property (@(posedge clk) disable iff (rst)
        bvalid |-> bresp != 2'b01) else $error("SVA a_no_exokay_b failed");
    a_no_exokay_r: assert property (@(posedge clk) disable iff (rst)
        rvalid |-> rresp != 2'b01) else $error("SVA a_no_exokay_r failed");
    // this slave takes AW and W in the same cycle
    a_aw_w_together: assert property (@(posedge clk) disable iff (rst)
        awready == wready) else $error("SVA a_aw_w_together failed");

    // ---- responses only for accepted requests (one outstanding each way) ----
    int wr_out, rd_out;
    always_ff @(posedge clk) begin
        if (rst) begin
            wr_out <= 0;
            rd_out <= 0;
        end else begin
            wr_out <= wr_out + (awvalid && awready) - (bvalid && bready);
            rd_out <= rd_out + (arvalid && arready) - (rvalid && rready);
        end
    end
    a_b_after_aw: assert property (@(posedge clk) disable iff (rst)
        bvalid |-> wr_out == 1) else $error("SVA a_b_after_aw failed");
    a_r_after_ar: assert property (@(posedge clk) disable iff (rst)
        rvalid |-> rd_out == 1) else $error("SVA a_r_after_ar failed");
    a_one_write: assert property (@(posedge clk) disable iff (rst) wr_out <= 1) else $error("SVA a_one_write failed");
    a_one_read:  assert property (@(posedge clk) disable iff (rst) rd_out <= 1);

    // ---- liveness, bounded: a request is answered within 4 cycles ----
    a_b_soon: assert property (@(posedge clk) disable iff (rst)
        awvalid && awready |-> ##[1:4] bvalid) else $error("SVA a_b_soon failed");
    a_r_soon: assert property (@(posedge clk) disable iff (rst)
        arvalid && arready |-> ##[1:4] rvalid) else $error("SVA a_r_soon failed");

    c_write_while_reading: cover property (@(posedge clk) disable iff (rst)
        (awvalid && awready) && rd_out == 1);
    c_back_pressure_r: cover property (@(posedge clk) disable iff (rst)
        rvalid && !rready ##1 rvalid && rready);

endinterface
