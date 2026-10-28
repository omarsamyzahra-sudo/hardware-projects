# profile.ps1 — Nsight Compute reports for the main kernels -> results\ncu\*.txt
#
# Windows only lets administrators read the GPU's performance counters
# (ERR_NVGPUCTRPERM otherwise), so start this elevated:
#   Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File', "$PWD\profile.ps1"
# (or allow counter access for all users in the NVIDIA Control Panel:
#  Desktop > Enable Developer Settings, then Developer > Manage GPU Performance Counters).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$ncu = "C:\Program Files\NVIDIA Corporation\Nsight Compute 2026.3.1\ncu.bat"
New-Item -ItemType Directory -Force results\ncu | Out-Null

$runs = @(
    @("tiled_dp4a", "k_tiled_dp4a", "2048 2048 2048"),
    @("wmma",       "k_wmma",       "2048 2048 2048"),
    @("wmma_big",   "k_wmma_big",   "2048 2048 2048"),
    @("skinny_dp4a","k_skinny",     "16 11008 4096"),
    @("skinny_cb",  "k_skinny",     "16 11008 4096"),
    @("fused_cb",   "k_fused_cb",   "16 11008 4096")
)
foreach ($r in $runs) {
    $name, $kern, $shape = $r
    $out = "results\ncu\$name.txt"
    Write-Host "profiling $name ($shape)"
    & $ncu --kernel-name regex:$kern --launch-count 1 `
        --section SpeedOfLight --section MemoryWorkloadAnalysis --section Occupancy `
        --section ComputeWorkloadAnalysis `
        build\gemm.exe --kernel $name $shape.Split(" ") *> $out
}
Write-Host "done: results\ncu"
