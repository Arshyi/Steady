@echo off
setlocal
rem Use the installed MSVC compiler without relying on the IDE's architecture.
set "STEADY_VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%STEADY_VSWHERE%" goto :missing
for /f "usebackq tokens=*" %%i in (`"%STEADY_VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "STEADY_VS=%%i"
if not defined STEADY_VS goto :missing
call "%STEADY_VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
rem Put generated binaries in the existing ignored build directory.
pushd "%~dp0\..\..\..\firmware\steady"
if not exist build mkdir build
cl /nologo /EHsc /std:c++17 /W4 /Fo:build\unoq_detector_test.obj /Fe:build\unoq_detector_test.exe ..\..\hardware\steady_unoq\tools\fall_detector_test.cpp
if errorlevel 1 goto :failed
build\unoq_detector_test.exe
set "STEADY_RC=%ERRORLEVEL%"
popd
exit /b %STEADY_RC%
:failed
popd
exit /b 1
:missing
echo MSVC C++ tools not found. The test can also be built with g++ or clang++.
exit /b 1
