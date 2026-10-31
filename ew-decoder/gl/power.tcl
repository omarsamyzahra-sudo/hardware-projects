# power.tcl — decoder power from real switching (OpenSTA, inside the LibreLane shell)
#
#   LIB=<sky130_fd_sc_hd__tt_025C_1v80.lib> sta -exit gl/power.tcl     (from ew-decoder/)
#
# The routed netlist, the layout's SDC (20 ns clock) and its extracted
# parasitics (nominal corner), first with the tool's default switching
# activity (what the layout run's metrics report), then with the activity
# recorded by tb/test_dec.py::test_dec_gl_power: the gate-level netlist
# decoding 128 rows of real Qwen weights at one chunk per cycle.
read_liberty $::env(LIB)
read_verilog gl/weight_decoder.nl.v
link_design weight_decoder
read_sdc gl/weight_decoder.sdc
read_spef gl/weight_decoder.nom.spef

puts "=== default activity ==="
report_power

read_vcd -scope tb_dec/dut sim_build/dec_gl_pwr/dec.vcd
puts "=== activity from the real-weight gate-level run ==="
report_power
