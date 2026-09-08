@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
set "helper_exit=%errorlevel%"
if not "%helper_exit%"=="0" (
  echo.
  echo USB helper stopped. See the message above.
  pause
)
exit /b %helper_exit%
