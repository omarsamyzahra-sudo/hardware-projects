// accel_uvm_pkg.sv — UVM environment for the AXI4-Lite accelerator
//
//   test ─► env ─┬─ agent ─┬─ sequencer ─► driver ─► axil_if ─► DUT
//                │         └─ monitor ──┬─► scoreboard (reference model)
//                │                      └─► coverage
//
// The monitor sees every completed bus transaction (what the bus really did,
// not what the driver meant to do). The scoreboard keeps its own copy of the
// accelerator's state — registers, both buffers, results — updates it from
// the monitored writes, and checks every response code and read value
// against it. Its job arithmetic is written independently of the RTL
// (64-bit integers, its own requantization).

package accel_uvm_pkg;

    import uvm_pkg::*;
    `include "uvm_macros.svh"

    // ---- register map (kept separate from accel_pkg on purpose) ----
    localparam int A_CTRL = 'h0, A_STATUS = 'h4, A_MROWS = 'h8, A_KTILES = 'hC,
                   A_QUANT = 'h10, A_CYCLES = 'h14, A_ID = 'h18, A_BIAS = 'h20,
                   A_OUT8 = 'h100, A_ACC = 'h200, A_WBUF = 'h2000, A_ABUF = 'h4000;
    localparam bit [1:0] OKAY = 2'b00, SLVERR = 2'b10, DECERR = 2'b11;

    typedef enum { RG_CTRL, RG_STATUS, RG_MROWS, RG_KTILES, RG_QUANT, RG_CYCLES,
                   RG_ID, RG_BIAS, RG_OUT8, RG_ACC, RG_WBUF, RG_ABUF, RG_NONE } region_e;

    function automatic region_e region_of(int unsigned a);
        if (a >= 'h4000 && a < 'h8000) return RG_ABUF;
        if (a >= 'h2000 && a < 'h4000) return RG_WBUF;
        if (a >= 'h200  && a < 'h400)  return RG_ACC;
        if (a >= 'h100  && a < 'h180)  return RG_OUT8;
        if (a >= 'h20   && a < 'h40)   return RG_BIAS;
        case (a & ~3)
            'h0:  return RG_CTRL;
            'h4:  return RG_STATUS;
            'h8:  return RG_MROWS;
            'hC:  return RG_KTILES;
            'h10: return RG_QUANT;
            'h14: return RG_CYCLES;
            'h18: return RG_ID;
            default: return RG_NONE;
        endcase
    endfunction

    // ======================================================================
    // Transaction
    // ======================================================================
    class axil_item extends uvm_sequence_item;
        rand bit        write;
        rand bit [14:0] addr;
        rand bit [31:0] data;
        rand bit [3:0]  strb;
        rand int        delay;          // idle cycles before the request
        bit [1:0]       resp;           // filled in from the bus
        bit [31:0]      rdata;

        constraint c_align { addr[1:0] == 0; }
        constraint c_strb  { strb dist { 4'hF := 8, [4'h1:4'hE] := 2 }; }
        constraint c_delay { delay dist { 0 := 6, [1:3] := 3 }; }

        `uvm_object_utils_begin(axil_item)
            `uvm_field_int(write, UVM_ALL_ON)
            `uvm_field_int(addr,  UVM_ALL_ON | UVM_HEX)
            `uvm_field_int(data,  UVM_ALL_ON | UVM_HEX)
            `uvm_field_int(strb,  UVM_ALL_ON | UVM_BIN)
            `uvm_field_int(resp,  UVM_ALL_ON)
            `uvm_field_int(rdata, UVM_ALL_ON | UVM_HEX)
        `uvm_object_utils_end

        function new(string name = "axil_item");
            super.new(name);
        endfunction

        function string brief();
            return write ? $sformatf("W %04h=%08h/%b resp %0d", addr, data, strb, resp)
                         : $sformatf("R %04h -> %08h resp %0d", addr, rdata, resp);
        endfunction
    endclass

    typedef uvm_sequencer #(axil_item) axil_sequencer;

    // ======================================================================
    // Driver: one transaction at a time, random idle gaps and B/R back-pressure
    // ======================================================================
    class axil_driver extends uvm_driver #(axil_item);
        `uvm_component_utils(axil_driver)
        virtual axil_if vif;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            if (!uvm_config_db #(virtual axil_if)::get(this, "", "vif", vif))
                `uvm_fatal("NOVIF", "no virtual interface")
        endfunction

        task run_phase(uvm_phase phase);
            vif.awvalid <= 0; vif.wvalid <= 0; vif.arvalid <= 0;
            vif.bready  <= 1; vif.rready <= 1;
            @(negedge vif.rst);
            forever begin
                axil_item it;
                seq_item_port.get_next_item(it);
                repeat (it.delay) @(posedge vif.clk);
                if (it.write) do_write(it); else do_read(it);
                seq_item_port.item_done();
            end
        endtask

        task do_write(axil_item it);
            vif.awaddr <= it.addr; vif.awvalid <= 1;
            vif.wdata  <= it.data; vif.wstrb  <= it.strb; vif.wvalid <= 1;
            vif.bready <= ($urandom_range(0, 3) != 0);
            do @(posedge vif.clk); while (!vif.awready);
            vif.awvalid <= 0; vif.wvalid <= 0;
            forever begin
                @(posedge vif.clk);
                if (vif.bvalid && vif.bready) break;
                vif.bready <= ($urandom_range(0, 2) != 0);
            end
            it.resp = vif.bresp;
            vif.bready <= 1;
        endtask

        task do_read(axil_item it);
            vif.araddr <= it.addr; vif.arvalid <= 1;
            vif.rready <= ($urandom_range(0, 3) != 0);
            do @(posedge vif.clk); while (!vif.arready);
            vif.arvalid <= 0;
            forever begin
                @(posedge vif.clk);
                if (vif.rvalid && vif.rready) break;
                vif.rready <= ($urandom_range(0, 2) != 0);
            end
            it.rdata = vif.rdata;
            it.resp  = vif.rresp;
            vif.rready <= 1;
        endtask
    endclass

    // ======================================================================
    // Monitor: rebuilds transactions from the handshakes
    // ======================================================================
    class axil_monitor extends uvm_monitor;
        `uvm_component_utils(axil_monitor)
        virtual axil_if vif;
        uvm_analysis_port #(axil_item) ap;

        function new(string name, uvm_component parent);
            super.new(name, parent);
            ap = new("ap", this);
        endfunction

        function void build_phase(uvm_phase phase);
            void'(uvm_config_db #(virtual axil_if)::get(this, "", "vif", vif));
        endfunction

        task run_phase(uvm_phase phase);
            axil_item w, r;
            forever begin
                @(posedge vif.clk);
                if (vif.rst) continue;
                if (vif.awvalid && vif.awready) begin
                    w = axil_item::type_id::create("w");
                    w.write = 1; w.addr = vif.awaddr; w.data = vif.wdata; w.strb = vif.wstrb;
                end
                if (vif.bvalid && vif.bready && w != null) begin
                    w.resp = vif.bresp;
                    ap.write(w);
                    w = null;
                end
                if (vif.arvalid && vif.arready) begin
                    r = axil_item::type_id::create("r");
                    r.write = 0; r.addr = vif.araddr;
                end
                if (vif.rvalid && vif.rready && r != null) begin
                    r.rdata = vif.rdata; r.resp = vif.rresp;
                    ap.write(r);
                    r = null;
                end
            end
        endtask
    endclass

    class axil_agent extends uvm_agent;
        `uvm_component_utils(axil_agent)
        axil_sequencer sqr;
        axil_driver    drv;
        axil_monitor   mon;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            sqr = axil_sequencer::type_id::create("sqr", this);
            drv = axil_driver::type_id::create("drv", this);
            mon = axil_monitor::type_id::create("mon", this);
        endfunction

        function void connect_phase(uvm_phase phase);
            drv.seq_item_port.connect(sqr.seq_item_export);
        endfunction
    endclass

    // ======================================================================
    // Reference model + scoreboard
    // ======================================================================
    class accel_scoreboard extends uvm_subscriber #(axil_item);
        `uvm_component_utils(accel_scoreboard)

        // model state
        bit [7:0]  wbuf [8192];
        bit [7:0]  abuf [16384];
        bit [31:0] mrows = 1, ktiles = 1, quant = 1;
        bit [31:0] bias [8];
        bit [31:0] acc  [16][8];
        bit [7:0]  out8 [16][8];
        bit        running, done;
        int        n_checked, n_errors, n_jobs;
        int        n_out, n_sat;            // int8 results, and how many saturated

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        static function bit [31:0] merge(bit [31:0] old, bit [31:0] d, bit [3:0] s);
            for (int i = 0; i < 4; i++) if (s[i]) old[8*i +: 8] = d[8*i +: 8];
            return old;
        endfunction

        // y = clamp((acc * mult + 2^(shift-1)) >> shift), relu first
        static function bit [7:0] requant(int acc, int unsigned mult, int unsigned shift, bit relu);
            longint p, y;
            p = longint'(acc) * longint'(mult);
            if (shift != 0) p += longint'(1) << (shift - 1);
            y = p >>> shift;
            if (relu && y < 0) y = 0;
            if (y > 127) y = 127;
            if (y < -128) y = -128;
            return y[7:0];
        endfunction

        function void run_job();
            int M = mrows, K = 8 * ktiles;
            for (int m = 0; m < M; m++)
                for (int n = 0; n < 8; n++) begin
                    int s = int'(bias[n]);                    // 32-bit wrap like the RTL
                    for (int k = 0; k < K; k++)
                        s += int'($signed(abuf[m * K + k])) * int'($signed(wbuf[8 * k + n]));
                    acc[m][n]  = s;
                    out8[m][n] = requant(s, quant[15:0], quant[21:16], quant[24]);
                    n_out++;
                    if (out8[m][n] inside {8'h7F, 8'h80}) n_sat++;
                end
            n_jobs++;
        endfunction

        function void expect_ok(bit ok, axil_item t, string what);
            n_checked++;
            if (!ok) begin
                n_errors++;
                `uvm_error("SB", $sformatf("%s: %s", t.brief(), what))
            end
        endfunction

        function void write(axil_item t);
            region_e rg = region_of(t.addr);
            bit [1:0] want;
            if (t.write) begin
                // expected response
                if (rg == RG_NONE)                  want = DECERR;
                else if (running)                   want = SLVERR;
                else if (rg inside {RG_STATUS, RG_CYCLES, RG_ID, RG_OUT8, RG_ACC})
                                                    want = SLVERR;
                else if (rg == RG_CTRL && t.strb[0] && t.data[0] &&
                         !(mrows inside {[1:16]} && ktiles inside {[1:128]}))
                                                    want = SLVERR;
                else                                want = OKAY;
                expect_ok(t.resp == want, t, $sformatf("resp %0d, want %0d", t.resp, want));
                if (want != OKAY) return;
                case (rg)
                    RG_MROWS:  mrows  = merge(mrows, t.data, t.strb) & 'h1F;
                    RG_KTILES: ktiles = merge(ktiles, t.data, t.strb) & 'hFF;
                    RG_QUANT:  quant  = merge(quant, t.data, t.strb) & 'h013F_FFFF;
                    RG_BIAS:   bias[t.addr[4:2]] = merge(bias[t.addr[4:2]], t.data, t.strb);
                    RG_WBUF, RG_ABUF:
                        for (int i = 0; i < 4; i++)
                            if (t.strb[i]) begin
                                if (rg == RG_WBUF) wbuf[t.addr - A_WBUF + i] = t.data[8*i +: 8];
                                else               abuf[t.addr - A_ABUF + i] = t.data[8*i +: 8];
                            end
                    RG_CTRL:
                        if (t.strb[0] && t.data[0]) begin
                            run_job();          // results are compared once it's done
                            running = 1;
                            done    = 0;
                        end
                    default: ;
                endcase
            end else begin
                bit [31:0] d;
                bit check_data = 1;
                want = (rg == RG_NONE) ? DECERR : OKAY;
                expect_ok(t.resp == want, t, $sformatf("resp %0d, want %0d", t.resp, want));
                case (rg)
                    RG_STATUS: begin
                        if (running && t.rdata == 32'b01) check_data = 0;   // still busy
                        else if (running && t.rdata == 32'b10) begin running = 0; done = 1; end
                        d = {30'b0, done, running};
                    end
                    RG_MROWS:  d = mrows;
                    RG_KTILES: d = ktiles;
                    RG_QUANT:  d = quant;
                    RG_ID:     d = 32'h5341_0808;
                    RG_BIAS:   d = bias[t.addr[4:2]];
                    RG_CYCLES: check_data = 0;
                    RG_OUT8: begin
                        int m = (t.addr - A_OUT8) / 8, n0 = t.addr[2] * 4;
                        d = {out8[m][n0 + 3], out8[m][n0 + 2], out8[m][n0 + 1], out8[m][n0]};
                        check_data = !running;
                    end
                    RG_ACC: begin
                        d = acc[(t.addr - A_ACC) / 32][t.addr[4:2]];
                        check_data = !running;
                    end
                    RG_WBUF: for (int i = 0; i < 4; i++) d[8*i +: 8] = wbuf[t.addr - A_WBUF + i];
                    RG_ABUF: for (int i = 0; i < 4; i++) d[8*i +: 8] = abuf[t.addr - A_ABUF + i];
                    default: d = 0;
                endcase
                if (check_data)
                    expect_ok(t.rdata == d, t, $sformatf("data %08h, want %08h", t.rdata, d));
            end
        endfunction

        function void report_phase(uvm_phase phase);
            `uvm_info("SB", $sformatf("%0d checks, %0d errors, %0d jobs", n_checked, n_errors,
                                      n_jobs), UVM_NONE)
            // Saturated outputs hide requantization bugs (rounding, shift), so
            // most results must land inside the int8 range.
            `uvm_info("SB", $sformatf("%0d of %0d int8 results saturated", n_sat, n_out), UVM_NONE)
            if (n_out > 0 && n_sat * 4 > n_out)
                `uvm_error("SB", "over a quarter of the results saturated: weak stimulus")
        endfunction
    endclass

    // ======================================================================
    // Functional coverage
    // ======================================================================
    class accel_coverage extends uvm_subscriber #(axil_item);
        `uvm_component_utils(accel_coverage)

        axil_item tr;
        bit [31:0] mrows = 1, ktiles = 1, quant = 1;
        bit        cov_job;

        covergroup cg_bus;
            cp_dir:    coverpoint tr.write;
            cp_region: coverpoint region_of(tr.addr);
            cp_resp:   coverpoint tr.resp { bins okay = {0}; bins slverr = {2}; bins decerr = {3};
                                           illegal_bins exokay = {1}; }
            cp_strb:   coverpoint tr.strb iff (tr.write) { bins full = {4'hF}; bins partial = default; }
            x_dir_region_resp: cross cp_dir, cp_region, cp_resp {
                // reads never get SLVERR; mapped regions never get DECERR
                ignore_bins rd_slverr = binsof(cp_dir) intersect {0} && binsof(cp_resp.slverr);
                ignore_bins mapped_decerr = !binsof(cp_region) intersect {RG_NONE} &&
                                            binsof(cp_resp.decerr);
                ignore_bins none_ok = binsof(cp_region) intersect {RG_NONE} &&
                                      !binsof(cp_resp.decerr);
                ignore_bins ro_ok = binsof(cp_dir) intersect {1} &&
                                    binsof(cp_region) intersect {RG_STATUS, RG_CYCLES, RG_ID,
                                                                 RG_OUT8, RG_ACC} &&
                                    binsof(cp_resp.okay);
            }
        endgroup

        covergroup cg_job;
            cp_m:     coverpoint mrows  { bins one = {1}; bins few = {[2:8]}; bins many = {[9:15]};
                                          bins max = {16}; }
            cp_kt:    coverpoint ktiles { bins one = {1}; bins two = {2}; bins odd = {3, 5, 7};
                                          bins mid = {[4:16]}; bins long = {[17:128]}; }
            cp_shift: coverpoint quant[21:16] { bins zero = {0}; bins low = {[1:7]};
                                                bins mid = {[8:20]}; bins high = {[21:63]}; }
            cp_relu:  coverpoint quant[24];
            x_m_kt:   cross cp_m, cp_kt;
        endgroup

        function new(string name, uvm_component parent);
            super.new(name, parent);
            cg_bus = new();
            cg_job = new();
        endfunction

        function void write(axil_item t);
            tr = t;
            cg_bus.sample();
            if (!tr.write || tr.resp != OKAY) return;
            case (region_of(tr.addr))
                RG_MROWS:  mrows  = accel_scoreboard::merge(mrows, tr.data, tr.strb) & 'h1F;
                RG_KTILES: ktiles = accel_scoreboard::merge(ktiles, tr.data, tr.strb) & 'hFF;
                RG_QUANT:  quant  = accel_scoreboard::merge(quant, tr.data, tr.strb) & 'h013F_FFFF;
                RG_CTRL:   if (tr.strb[0] && tr.data[0]) cg_job.sample();
                default: ;
            endcase
        endfunction

        function void report_phase(uvm_phase phase);
            `uvm_info("COV", $sformatf("bus coverage %0.1f%%, job coverage %0.1f%%",
                                       cg_bus.get_coverage(), cg_job.get_coverage()), UVM_NONE)
        endfunction
    endclass

    class accel_env extends uvm_env;
        `uvm_component_utils(accel_env)
        axil_agent       agent;
        accel_scoreboard sb;
        accel_coverage   cov;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            agent = axil_agent::type_id::create("agent", this);
            sb    = accel_scoreboard::type_id::create("sb", this);
            cov   = accel_coverage::type_id::create("cov", this);
        endfunction

        function void connect_phase(uvm_phase phase);
            agent.mon.ap.connect(sb.analysis_export);
            agent.mon.ap.connect(cov.analysis_export);
        endfunction
    endclass

    // ======================================================================
    // Sequences
    // ======================================================================
    class base_seq extends uvm_sequence #(axil_item);
        `uvm_object_utils(base_seq)
        function new(string name = "base_seq");
            super.new(name);
        endfunction

        task wr(int unsigned addr, bit [31:0] data, bit [3:0] strb = 4'hF);
            axil_item it = axil_item::type_id::create("it");
            start_item(it);
            if (!it.randomize() with { write == 1; addr == local::addr[14:0];
                                       data == local::data; strb == local::strb; })
                `uvm_fatal("RAND", "write")
            finish_item(it);
        endtask

        task rd(int unsigned addr, output bit [31:0] data);
            axil_item it = axil_item::type_id::create("it");
            start_item(it);
            if (!it.randomize() with { write == 0; addr == local::addr[14:0]; })
                `uvm_fatal("RAND", "read")
            finish_item(it);
            data = it.rdata;
        endtask

        task wait_done();
            bit [31:0] st;
            do rd(A_STATUS, st); while (st[0]);
        endtask
    endclass

    // One random job: operands, config, start, wait, read every result.
    class job_seq extends base_seq;
        `uvm_object_utils(job_seq)
        rand int unsigned m, kt, mult, shift;
        rand bit relu;
        constraint c_shape { m inside {[1:16]}; kt dist { [1:3] := 4, [4:16] := 4, [17:128] := 1 }; }
        // Most jobs get a "realistic" scale (mult / 2^shift chosen so results
        // spread over the int8 range, as a real layer's would); the rest are
        // free, to hit the extremes (shift 0, huge shifts, saturation).
        rand bit realistic;
        constraint c_real  { realistic dist { 1 := 4, 0 := 1 }; }
        constraint c_quant { mult inside {[1:65535]};
                             shift dist { 0 := 1, [1:7] := 2, [8:20] := 6, [21:63] := 1 }; }

        function void post_randomize();
            real typ, scale;
            if (!realistic) return;
            typ   = 5000.0 * $sqrt(8.0 * kt) + 2000.0;   // typical |acc|: products ~ +-5000 each
            scale = 60.0 / typ * (0.5 + $urandom_range(0, 100) / 100.0);
            if (shift < 16 || shift > 30) shift = 24;   // keep a usable shift
            mult  = int'(scale * (1 << 24));
            if (mult < 1) mult = 1;
            if (mult > 65535) mult = 65535;
        endfunction

        function new(string name = "job_seq");
            super.new(name);
        endfunction

        task body();
            bit [31:0] d;
            int K = 8 * kt;
            for (int a = 0; a < 8 * K; a += 4) wr(A_WBUF + a, $urandom());
            for (int a = 0; a < m * K; a += 4) wr(A_ABUF + a, $urandom());
            for (int n = 0; n < 8; n++) wr(A_BIAS + 4 * n, $urandom_range(0, 1 << 13) - (1 << 12));
            wr(A_MROWS, m);
            wr(A_KTILES, kt);
            wr(A_QUANT, mult | shift << 16 | relu << 24);
            wr(A_CTRL, 1);
            wait_done();
            for (int r = 0; r < m; r++) begin
                rd(A_OUT8 + 8 * r, d);
                rd(A_OUT8 + 8 * r + 4, d);
                for (int n = 0; n < 8; n++) rd(A_ACC + 32 * r + 4 * n, d);
            end
            rd(A_CYCLES, d);
        endtask
    endclass

    // Random register/buffer traffic, including unmapped and read-only
    // addresses and partial strobes.
    class reg_seq extends base_seq;
        `uvm_object_utils(reg_seq)
        int n = 200;
        function new(string name = "reg_seq");
            super.new(name);
        endfunction

        task body();
            repeat (n) begin
                axil_item it = axil_item::type_id::create("it");
                start_item(it);
                if (!it.randomize() with {
                        addr dist { [0:'h3C] := 6, ['h40:'hFC] := 1, ['h100:'h17C] := 2,
                                    ['h180:'h1FC] := 1, ['h200:'h3FC] := 2, ['h400:'h1FFC] := 1,
                                    ['h2000:'h3FFC] := 2, ['h4000:'h7FFC] := 2 };
                        // don't start jobs here (job_seq does that)
                        (write && addr == A_CTRL) -> data[0] == 0; })
                    `uvm_fatal("RAND", "reg")
                finish_item(it);
            end
        endtask
    endclass

    // A long job, then writes that must all be refused while it runs.
    class busy_seq extends base_seq;
        `uvm_object_utils(busy_seq)
        function new(string name = "busy_seq");
            super.new(name);
        endfunction

        task body();
            bit [31:0] d;
            wr(A_MROWS, 16);
            wr(A_KTILES, 128);                 // about 2000 cycles
            wr(A_QUANT, 1000 | 32 << 16);      // tiny scale: results near 0, not saturated
            wr(A_CTRL, 1);
            wr(A_MROWS, 3);
            wr(A_KTILES, 5);
            wr(A_QUANT, 7);
            wr(A_BIAS, 99);
            wr(A_WBUF + 8, 'hDEAD);
            wr(A_ABUF + 64, 'hBEEF);
            wr(A_CTRL, 1);
            wr('h1C, 0);                       // DECERR wins over busy
            rd(A_MROWS, d);
            wait_done();
        endtask
    endclass

    // ======================================================================
    // Tests
    // ======================================================================
    class base_test extends uvm_test;
        `uvm_component_utils(base_test)
        accel_env env;

        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction

        function void build_phase(uvm_phase phase);
            env = accel_env::type_id::create("env", this);
            uvm_root::get().set_timeout(50ms, 1);   // a hung handshake fails, not hangs
        endfunction

        virtual task stimulus();
        endtask

        task run_phase(uvm_phase phase);
            phase.raise_objection(this);
            stimulus();
            phase.drop_objection(this);
        endtask

        function void report_phase(uvm_phase phase);
            uvm_report_server rs = uvm_report_server::get_server();
            int errs = rs.get_severity_count(UVM_ERROR) + rs.get_severity_count(UVM_FATAL);
            if (errs == 0 && env.sb.n_checked > 0) `uvm_info("TEST", "*** PASSED ***", UVM_NONE)
            else `uvm_info("TEST", "*** FAILED ***", UVM_NONE)
        endfunction
    endclass

    class smoke_test extends base_test;
        `uvm_component_utils(smoke_test)
        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction
        task stimulus();
            job_seq j = job_seq::type_id::create("j");
            if (!j.randomize() with { m == 4; kt == 2; }) `uvm_fatal("RAND", "job")
            j.start(env.agent.sqr);
        endtask
    endclass

    class random_test extends base_test;
        `uvm_component_utils(random_test)
        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction
        task stimulus();
            reg_seq  r;
            job_seq  j;
            busy_seq b;
            for (int i = 0; i < 40; i++) begin
                case (i % 8)
                    0: begin r = reg_seq::type_id::create("r"); r.n = 100; r.start(env.agent.sqr); end
                    5: begin b = busy_seq::type_id::create("b"); b.start(env.agent.sqr); end
                    default: begin
                        j = job_seq::type_id::create("j");
                        if (!j.randomize()) `uvm_fatal("RAND", "job")
                        j.start(env.agent.sqr);
                    end
                endcase
            end
        endtask
    endclass

    // Directed sweep over the job-coverage cross (one job per M bin x KT
    // bin, alternating ReLU) and every shift bin, on top of the random test.
    class cover_test extends random_test;
        `uvm_component_utils(cover_test)
        function new(string name, uvm_component parent);
            super.new(name, parent);
        endfunction
        task stimulus();
            int ms[4]  = '{1, 5, 12, 16};
            int kts[5] = '{1, 2, 3, 8, 20};
            int shs[4] = '{0, 4, 12, 30};
            int i = 0;
            job_seq j;
            super.stimulus();
            foreach (ms[a]) foreach (kts[b]) begin
                j = job_seq::type_id::create("j");
                if (!j.randomize() with { m == ms[a]; kt == kts[b]; realistic == 1;
                                          relu == i[0]; })
                    `uvm_fatal("RAND", "job")
                j.start(env.agent.sqr);
                i++;
            end
            // every shift bin, on 1-row jobs (these mostly saturate, so keep them small)
            foreach (shs[s]) begin
                j = job_seq::type_id::create("j");
                if (!j.randomize() with { m == 1; kt == 1; realistic == 0; shift == shs[s]; })
                    `uvm_fatal("RAND", "job")
                j.start(env.agent.sqr);
            end
        endtask
    endclass

endpackage
