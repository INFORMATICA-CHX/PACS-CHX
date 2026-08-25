@echo off
setlocal
pushd "%~dp0"
title Inicializador PACS CHX Web
echo Preparando esta instalacao...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1"
if errorlevel 1 goto :error
if not defined PACS_DB_KEY for /f "usebackq delims=" %%K in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Security; $p=[IO.File]::ReadAllBytes('%~dp0server\secrets\pacs-db-key.dpapi'); $k=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ([BitConverter]::ToString($k)).Replace('-','')"`) do set "PACS_DB_KEY=%%K"
if not defined PACS_DB_KEY goto :key_error
call npm.cmd run build
if errorlevel 1 goto :error
start "PACS CHX Server" cmd /k "cd /d ""%~dp0server"" && npm.cmd start"
timeout /t 3 /nobreak >nul
start "" "https://127.0.0.1:4443/viewer"
popd
exit /b 0
:key_error
echo PACS_DB_KEY nao esta configurada para este usuario.
pause
popd
exit /b 1
:error
echo Nao foi possivel iniciar o servidor.
pause
popd
exit /b 1
