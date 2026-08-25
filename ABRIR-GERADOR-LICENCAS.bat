@echo off
setlocal
pushd "%~dp0"
title PACS CHX License Manager
echo Preparando o License Manager...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1" -LicenseOnly
if errorlevel 1 goto :error
call npm.cmd run license-manager
popd
exit /b 0
:error
echo Nao foi possivel abrir o License Manager.
pause
popd
exit /b 1
