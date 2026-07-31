@echo off
REM VITALS setup for Windows. Double-click this file.
REM
REM It prefers the runtime that shipped in the box (runtime\node.exe) and falls back to a system
REM Node, which is the same order every other launcher here uses - see pshost.js for why sharing
REM that order matters.
REM
REM %~dp0 is this file's own folder, so the install can live anywhere, including a USB stick.

setlocal
set "DIR=%~dp0"

if exist "%DIR%runtime\node.exe" (
  set "NODE=%DIR%runtime\node.exe"
) else (
  where node >nul 2>&1 || goto :nonode
  set "NODE=node"
)

"%NODE%" "%DIR%setup.js" %*
if errorlevel 1 pause
exit /b %errorlevel%

:nonode
echo.
echo   VITALS needs Node 18 or newer, and this copy did not come with one.
echo.
echo   Either install Node:      winget install OpenJS.NodeJS.LTS
echo   or download the bundle that includes it, which needs nothing installed.
echo.
pause
exit /b 1
