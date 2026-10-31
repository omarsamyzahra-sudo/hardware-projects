// written by riscv-core/openlane/make_die.py
export const CPU_DIE = [
 {
  "tab": "RISC-V CPU",
  "src": "assets/cpu_die.jpg",
  "alt": "Layout of the 5-stage RV32I pipeline on SKY130",
  "title": "5-stage RV32I pipeline",
  "desc": "The CPU from the first section, hardened on its own: register file, forwarding network, CSRs and the pipeline registers, placed and routed. The same core drives the systolic array in its SoC, and a copy extended with a custom-0 coprocessor port drives the weight decoder.",
  "specs": [
   [
    "die",
    "569 × 580 µm"
   ],
   [
    "cells",
    "18,188"
   ],
   [
    "fmax (tt / ss)",
    "~71 / ~44 MHz"
   ],
   [
    "DRC · LVS · antenna",
    "0 · 0 · 0"
   ]
  ]
 }
];
