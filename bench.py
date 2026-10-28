"""Run the benchmark several times, log the GPU's clocks meanwhile, summarize, plot.

    python bench.py [runs]          (default 3; needs build/gemm.exe)

This is a laptop GPU: its clock moves with power and temperature (the
driver reports power capping and thermal slowdown during long runs), so a
single run can be off by 2x. Each kernel/shape gets the best and the median
of the runs, and results/clocks.csv records the SM clock, power and
temperature every 200 ms so the numbers can be read against the clock.

Outputs: results/summary.csv, results/clocks.csv, results/roofline.png
"""

import csv
import io
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RES = ROOT / "results"

# GA106 (RTX 3060 Laptop): 30 SMs, 192-bit GDDR6 at 14 Gbps
SMS = 30
DRAM_GBS = 336.0
DP4A_OPS_PER_CLK_SM = 64 * 8        # 64 INT32 lanes, dp4a = 4 multiply-adds = 8 ops
TC_OPS_PER_CLK_SM = 1024 * 2        # dense int8 tensor-core MACs per clock per SM (GA10x)


def main(runs: int):
    RES.mkdir(exist_ok=True)
    log = open(RES / "clocks.csv", "w")
    smi = subprocess.Popen(["nvidia-smi", "--query-gpu=timestamp,clocks.sm,clocks.mem,power.draw,"
                            "temperature.gpu", "--format=csv,nounits", "-lms", "200"],
                           stdout=log, stderr=subprocess.DEVNULL)
    rows = defaultdict(list)
    try:
        for r in range(runs):
            out = subprocess.run([str(ROOT / "build" / "gemm.exe")], capture_output=True, text=True)
            print(out.stderr.strip())
            if out.returncode != 0:
                sys.exit(f"run {r}: gemm.exe failed")
            for row in csv.DictReader(io.StringIO(out.stdout)):
                rows[(row["kernel"], int(row["M"]), int(row["N"]), int(row["K"]))].append(row)
    finally:
        smi.terminate()
        log.close()

    clocks = [float(l.split(",")[1]) for l in open(RES / "clocks.csv").read().splitlines()[1:]
              if l.count(",") >= 4 and l.split(",")[1].strip().replace(".", "").isdigit()]
    busy = [c for c in clocks if c > 1000]                     # samples while a kernel ran
    clk = statistics.median(busy) if busy else 2100.0
    print(f"SM clock under load: median {clk:.0f} MHz, range {min(busy, default=0):.0f}-"
          f"{max(busy, default=0):.0f} MHz over {len(busy)} samples")

    with open(RES / "summary.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["kernel", "M", "N", "K", "best_ms", "median_ms", "best_tops", "median_tops",
                    "min_bytes_mb", "intensity_ops_per_byte", "wrong"])
        for (k, M, N, K), rs in rows.items():
            ms = [float(r["ms"]) for r in rs]
            ops = 2.0 * M * N * K
            gbs = float(rs[0]["gbs_min"]) * float(rs[0]["ms"]) / 1e3   # GB moved (min traffic)
            w.writerow([k, M, N, K, f"{min(ms):.4f}", f"{statistics.median(ms):.4f}",
                        f"{ops / min(ms) / 1e9:.2f}", f"{ops / statistics.median(ms) / 1e9:.2f}",
                        f"{gbs * 1e3:.1f}", f"{ops / (gbs * 1e9):.1f}",
                        max(int(r["wrong"]) for r in rs)])
    print((RES / "summary.csv").read_text())
    roofline(clk)


def roofline(clk_mhz: float):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    peak_dp4a = SMS * DP4A_OPS_PER_CLK_SM * clk_mhz * 1e6 / 1e12
    peak_tc = SMS * TC_OPS_PER_CLK_SM * clk_mhz * 1e6 / 1e12
    data = list(csv.DictReader(open(RES / "summary.csv")))
    fig, ax = plt.subplots(figsize=(8, 5.5))
    x = [0.5, 3000]
    xs = [0.5 * 1.02**i for i in range(450)]                 # log-spaced, 0.5 .. ~3700
    for peak, name in ((peak_tc, "int8 tensor cores"), (peak_dp4a, "dp4a (CUDA cores)")):
        ax.plot(xs, [min(peak, DRAM_GBS * i / 1e3) for i in xs], color="0.5", lw=1)
        ax.text(2500, peak * 1.1, f"{name}: {peak:.0f} TOPS", ha="right", fontsize=8, color="0.3")
    ax.text(0.7, DRAM_GBS * 0.7 / 1e3 * 1.5, f"DRAM {DRAM_GBS:.0f} GB/s", fontsize=8, color="0.3", rotation=31)
    markers = {"naive": "x", "warp_dp4a": "v", "tiled_dp4a": "s", "wmma": "D", "wmma_big": "P",
               "cublas": "*", "dequant+tiled": "^", "fused_cb": "o", "skinny_dp4a": "<",
               "skinny_cb": ">"}
    for k, mk in markers.items():
        pts = [(float(r["intensity_ops_per_byte"]), float(r["best_tops"])) for r in data if r["kernel"] == k]
        if pts:
            ax.scatter(*zip(*pts), marker=mk, s=40, label=k)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(*x)
    ax.set_ylim(0.03, peak_tc * 2)
    ax.set_xlabel("arithmetic intensity (int8 ops per byte of minimum DRAM traffic)")
    ax.set_ylabel("achieved TOPS (best of runs)")
    ax.set_title(f"int8 GEMM on RTX 3060 Laptop (roofs at the measured {clk_mhz:.0f} MHz SM clock)")
    ax.legend(fontsize=8, loc="lower right")
    ax.grid(True, which="both", alpha=0.2)
    fig.tight_layout()
    fig.savefig(RES / "roofline.png", dpi=150)
    print("wrote", RES / "roofline.png")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 3)
