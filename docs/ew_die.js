// written by ew-decoder/openlane/make_die.py
export const EW_DIE = [
 {
  "tab": "LLM weight decoder",
  "src": "assets/ew_decoder_die.jpg",
  "alt": "Layout of the exponent-window weight decoder on SKY130",
  "title": "Exponent-window weight decoder",
  "desc": "The decoder alone: double-buffered tiles of 3-bit code planes and sign/mantissa bytes, the escape window that routes escaped exponents to their lanes with a prefix popcount, and 8 lanes that rebuild one BF16 weight each per cycle. Its routed netlist was simulated gate by gate on real Qwen2.5 weights: 14,336/14,336 chunks bit-exact, 4.27 mW at 50 MHz from that run's switching.",
  "specs": [
   [
    "die",
    "370 × 381 µm"
   ],
   [
    "cells",
    "7,208"
   ],
   [
    "fmax (tt / ss)",
    "~84 / ~53 MHz"
   ],
   [
    "DRC · LVS · antenna",
    "0 · 0 · 0"
   ]
  ]
 },
 {
  "tab": "Decoder 60 µm",
  "src": "assets/ew_decoder_closeup.jpg",
  "alt": "60 micrometer close-up of the decoder's standard cells",
  "title": "Zoom: the decoder's cells",
  "desc": "60 µm at the center of the decoder in SkyWater layer colors: rows of standard cells, poly gates, local interconnect and the first metal layers.",
  "specs": [
   [
    "power @ 50 MHz",
    "4.27 mW (real weights)"
   ],
   [
    "energy",
    "10.7 pJ / weight"
   ]
  ]
 }
];
