@echo off
rem Build gpu\build\ewlib.dll (the GEMV kernels for gpu\e2e_demo.py). Same toolchain as build.bat.
cd /d "%~dp0"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist build mkdir build
nvcc -O3 -std=c++17 -arch=sm_86 -lineinfo -shared -o build\ewlib.dll ewlib.cu || exit /b 1
echo built build\ewlib.dll
