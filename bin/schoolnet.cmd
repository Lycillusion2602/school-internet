@echo off
REM ============================================================
REM  schoolnet 便捷入口（Windows 命令行包装器）
REM  用法: bin\schoolnet.cmd status|login|logout|once|daemon|ip
REM ============================================================
setlocal
set "ROOT=%~dp0.."
node "%ROOT%\src\cli.js" %*
endlocal
