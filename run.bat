@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "HSTAR_EDITION=development"
if not defined HSTAR_DATA_DIR (
    if exist "E:\" (
        set "HSTAR_DATA_DIR=E:\Hstar缓存"
    ) else (
        set "HSTAR_DATA_DIR=%USERPROFILE%\Documents\Hstar缓存"
    )
)
set "HSTAR_PROGRAM_DIR=%~dp0"
set "HSTAR_PORT=3000"

set "PYEXE=%~dp0python\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"

echo Starting ComfyUI-API-Modelscope...
echo Visit: http://127.0.0.1:3000/
echo Press Ctrl+C to stop.
echo.

start /b cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:3000/"
"%PYEXE%" main.py

echo.
echo Server stopped.
pause
