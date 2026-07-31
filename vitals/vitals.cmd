@echo off
REM VITALS launcher for Windows (command line). VITALS.exe is the pinnable equivalent - it exists so
REM the taskbar shows the VITALS icon instead of the PowerShell one, which is the only reason it is a
REM compiled stub rather than a shortcut.
REM
REM   vitals.cmd                start the bridge and open the native panel
REM   vitals.cmd --no-window    bridge only (headless, for MCP)
REM
REM %~dp0 is this file's own folder, so the install can live anywhere.

setlocal
set "DIR=%~dp0"

if exist "%DIR%runtime\node.exe" (
  set "NODE=%DIR%runtime\node.exe"
) else (
  where node >nul 2>&1 || goto :nonode
  set "NODE=node"
)

"%NODE%" "%DIR%start.js" %*
exit /b %errorlevel%

:nonode
echo VITALS needs Node 18 or newer, and none was found on PATH.
echo.
echo   winget install OpenJS.NodeJS.LTS
echo   or: https://nodejs.org
echo.
echo Alternatively drop node.exe at %DIR%runtime\ and this script will use it.
exit /b 1
