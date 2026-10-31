// Every SKY130 layout on the page, one row each. Numbers come from each run's metrics.json
// (see the repo paths); a row with `pending` is a layout still running.
export const LAYOUTS = [
  { design: "decoder", block: "Weight decoder", note: " ew-decoder/openlane/decoder", clean: true,
    cells: "7,208", die: "370 × 381 µm", fmax: "~84 / ~53 MHz", checks: "0 / 0 / 0" },
  { design: "engine", block: "Decoder engine", note: " decoder + GEMV core + AXI streams + control, KMAX = 896, 30 ns target",
    pending: "routed with 0 routing errors; final DRC/LVS in progress" },
  { design: "cpu", block: "RISC-V CPU", note: " riscv-core/openlane", clean: true,
    cells: "18,188", die: "569 × 580 µm", fmax: "~71 / ~44 MHz", checks: "0 / 0 / 0" },
  { design: "array", block: "Systolic array, tiled", note: " 64 PE macros on a grid", clean: true,
    cells: "64 macros + 22,832", die: "1.96 × 1.96 mm", fmax: "~102 / ~60 MHz", checks: "0 / 0 / 0" },
  { design: "array", block: "Systolic array, flat", note: " same RTL, flat placement",
    cells: "108,707", die: "1.37 × 1.38 mm", fmax: "~84 / ~43 MHz", checks: "0 / 0 / 1" },
  { design: "gpu", block: "SIMT GPU core", note: " one core, 25% utilization",
    pending: "globally routed; detailed routing in progress" },
];
