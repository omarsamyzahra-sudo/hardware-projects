// written by simt-gpu/openlane/make_gpu_die.py
export const GPU_DIE = [
  {
    "tab": "GPU core",
    "src": "assets/gpu_die.jpg",
    "alt": "Layout of one SIMT core of the GPU on SKY130",
    "title": "One SIMT core (an “SM”), flat",
    "specs": [
      [
        "die",
        "2.39 × 2.40 mm"
      ],
      [
        "standard cells",
        "361,714"
      ],
      [
        "flip-flops",
        "37,875 (32,768 are registers)"
      ],
      [
        "stage",
        "placed + clock tree, not routed"
      ]
    ],
    "desc": "The whole of simt_core.sv: warp scheduler, fetch and decode, 8 lane ALUs with 32-bit multipliers, the register file for 32 threads (built from flip-flops, since the open PDK flow has no SRAM compiler) and the coalescing load/store unit. Instruction and global memory stay off-core, as SRAM macros would be. Shown placed, with the clock tree and power grid: global routing didn’t converge (the flip-flop register file plus timing-repair buffers left met2 99% used), so there are no signal wires yet."
  },
  {
    "tab": "GPU floorplan",
    "src": "assets/gpu_floorplan.jpg",
    "alt": "The SIMT core layout colored by functional unit",
    "title": "Where the placer put each unit",
    "specs": [
      [
        "die",
        "2.39 × 2.40 mm"
      ],
      [
        "standard cells",
        "361,714"
      ],
      [
        "flip-flops",
        "37,875 (32,768 are registers)"
      ]
    ],
    "labels": [
      {
        "t": "lane 0",
        "x": 38.3,
        "y": 84.6,
        "c": "rgb(61,127,224)"
      },
      {
        "t": "lane 1",
        "x": 17.0,
        "y": 11.6,
        "c": "rgb(79,209,232)"
      },
      {
        "t": "lane 2",
        "x": 13.4,
        "y": 79.0,
        "c": "rgb(79,191,106)"
      },
      {
        "t": "lane 3",
        "x": 12.7,
        "y": 44.5,
        "c": "rgb(166,214,79)"
      },
      {
        "t": "lane 4",
        "x": 38.5,
        "y": 31.1,
        "c": "rgb(232,197,71)"
      },
      {
        "t": "lane 5",
        "x": 57.7,
        "y": 11.8,
        "c": "rgb(232,135,58)"
      },
      {
        "t": "lane 6",
        "x": 44.3,
        "y": 54.4,
        "c": "rgb(224,93,138)"
      },
      {
        "t": "lane 7",
        "x": 67.2,
        "y": 86.0,
        "c": "rgb(155,89,208)"
      },
      {
        "t": "thread state",
        "x": 86.0,
        "y": 15.1,
        "c": "rgb(235,238,245)"
      },
      {
        "t": "load/store unit",
        "x": 81.2,
        "y": 54.7,
        "c": "rgb(255,120,60)"
      },
      {
        "t": "front end",
        "x": 81.8,
        "y": 28.1,
        "c": "rgb(120,140,170)"
      }
    ],
    "desc": "Every flip-flop labeled by the register it holds (from its net name), labels spread through the netlist to the logic around them, then painted over the layout. Each lane’s registers and ALU form their own region: the 8-way SIMD structure is visible in the layout. The regions are uneven because placement is flat: the placer only minimizes wire length and knows nothing about lanes, and every lane also wires to the shared fetch, scheduler and load/store unit, which pulls its edges inward. Equal tiles would take a hierarchical flow: one lane hardened as a macro and placed on a grid, as in the tiled systolic array."
  },
  {
    "tab": "GPU 250 µm",
    "src": "assets/gpu_mid.jpg",
    "alt": "250 micrometer window of the SIMT core layout",
    "title": "Zoom: the register-file sea",
    "specs": [
      [
        "window",
        "250 µm"
      ],
      [
        "metal",
        "cells + power grid"
      ]
    ],
    "desc": "A 250 µm window in the middle of the core: dense rows of flip-flops and the read multiplexers that pick one of 128 registers for each lane, every cycle."
  }
];
