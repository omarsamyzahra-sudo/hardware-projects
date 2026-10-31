@echo off
rem Build build\gemm.exe with nvcc. MSVC's environment comes from vcvars64.
cd /d "%~dp0"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist build mkdir build
nvcc -O3 -std=c++17 -arch=sm_86 -lineinfo -o build\gemm.exe src\main.cu -lcublas || exit /b 1
echo built build\gemm.exe
