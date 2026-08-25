@echo off
setlocal
pushd "%~dp0"
title PACS CHX
echo Preparando esta instalacao...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1"
if errorlevel 1 goto :error
if not defined PACS_DB_KEY for /f "usebackq delims=" %%K in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Security; $p=[IO.File]::ReadAllBytes('%~dp0server\secrets\pacs-db-key.dpapi'); $k=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ([BitConverter]::ToString($k)).Replace('-','')"`) do set "PACS_DB_KEY=%%K"
if not defined PACS_DB_KEY (
  echo PACS_DB_KEY nao esta configurada para este usuario.
  goto :error
)
echo Atualizando interface do PACS CHX...
call npm.cmd run build
if errorlevel 1 goto :error
echo Abrindo PACS CHX Manager...
start "PACS CHX Manager" cmd /k "cd /d ""%~dp0"" && npm.cmd run desktop"
echo Abrindo PACS CHX Web Viewer...
timeout /t 5 /nobreak >nul
start "" "https://127.0.0.1:4443/viewer"
popd
exit /b 0
:error
echo.
echo Nao foi possivel iniciar o PACS CHX.
pause
popd
exit /b 1
