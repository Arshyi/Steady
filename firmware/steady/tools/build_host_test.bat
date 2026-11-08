@echo off
rem Builds and runs the host tests for the portable firmware logic using MSVC.
rem Avoids %ProgramFiles(x86)%, whose parentheses break cmd parsing, and any
rem multi-line if blocks.
setlocal enabledelayedexpansion
set "VSPATH="

for %%y in (18 2026 2022 2019) do @for %%e in (Community Professional Enterprise BuildTools) do @if exist "%ProgramFiles%\Microsoft Visual Studio\%%y\%%e\VC\Auxiliary\Build\vcvars64.bat" set "VSPATH=%ProgramFiles%\Microsoft Visual Studio\%%y\%%e"

if not defined VSPATH goto :tryw6432
goto :build

:tryw6432
for %%y in (18 2026 2022 2019) do @for %%e in (Community Professional Enterprise BuildTools) do @if exist "%ProgramW6432%\Microsoft Visual Studio\%%y\%%e\VC\Auxiliary\Build\vcvars64.bat" set "VSPATH=%ProgramW6432%\Microsoft Visual Studio\%%y\%%e"

:build
if not defined VSPATH goto :notfound

call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 goto :vcvarsfailed

pushd "%~dp0\.."
if not exist build mkdir build
cl /nologo /EHsc /std:c++17 /W4 /I sketch tools\host_test.cpp sketch\fall_detector.cpp sketch\orientation.cpp /Fe:build\host_test.exe
if errorlevel 1 goto :buildfailed
build\host_test.exe
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%

:buildfailed
popd
exit /b 1

:notfound
echo [host_test] No MSVC C++ toolchain found. Install the "Desktop development with C++" workload.
exit /b 1

:vcvarsfailed
echo [host_test] vcvars64.bat failed under "%VSPATH%".
exit /b 1
