// tb_top.sv — UVM top: clock, reset, the DUT on an axil_if, run_test()

`timescale 1ns/1ps

module tb_top;
    import uvm_pkg::*;
    import accel_uvm_pkg::*;

    logic clk = 0, rst = 1;
    always #5 clk = ~clk;
    initial begin
        repeat (5) @(posedge clk);
        rst <= 0;
    end

    axil_if bus (clk, rst);

    accel_axil dut (
        .clk(clk), .rst(rst),
        .s_awaddr(bus.awaddr), .s_awvalid(bus.awvalid), .s_awready(bus.awready),
        .s_wdata(bus.wdata), .s_wstrb(bus.wstrb), .s_wvalid(bus.wvalid), .s_wready(bus.wready),
        .s_bresp(bus.bresp), .s_bvalid(bus.bvalid), .s_bready(bus.bready),
        .s_araddr(bus.araddr), .s_arvalid(bus.arvalid), .s_arready(bus.arready),
        .s_rdata(bus.rdata), .s_rresp(bus.rresp), .s_rvalid(bus.rvalid), .s_rready(bus.rready),
        .irq());

    initial begin
        uvm_config_db #(virtual axil_if)::set(null, "*", "vif", bus);
        run_test("smoke_test");
    end
endmodule
