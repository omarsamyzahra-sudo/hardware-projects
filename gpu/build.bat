@echo off
rem Build gpu\build\ewgemv.exe with nvcc. MSVC's environment comes from vcvars64
rem (edit the path for your Visual Studio). sm_86 = RTX 30-series (3060 Laptop, 3080).
cd /d "%~dp0"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist build mkdir build
nvcc -O3 -std=c++17 -arch=sm_86 -lineinfo -o build\ewgemv.exe ewgemv.cu -lcublas || exit /b 1
echo built build\ewgemv.exe
