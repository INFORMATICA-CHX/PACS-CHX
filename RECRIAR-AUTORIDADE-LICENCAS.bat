@echo off
setlocal
pushd "%~dp0"
title Recriar Autoridade de Licencas PACS CHX
echo Recriando autoridade local de licencas...
echo.
echo Este procedimento deve ser usado somente quando a chave privada do emissor
echo foi perdida neste computador e ainda nao existem clientes licenciados com
echo esta autoridade.
echo.
set "BACKUP_DIR=%~dp0license-manager\keys\backup-%DATE:~-4%%DATE:~3,2%%DATE:~0,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%"
set "BACKUP_DIR=%BACKUP_DIR: =0%"
mkdir "%BACKUP_DIR%" >nul 2>nul
if exist "%~dp0server\license-public.pem" move /Y "%~dp0server\license-public.pem" "%BACKUP_DIR%\server-license-public.pem" >nul
if exist "%~dp0license-manager\keys\public.pem" move /Y "%~dp0license-manager\keys\public.pem" "%BACKUP_DIR%\license-manager-public.pem" >nul
if exist "%APPDATA%\pacs-chx-license-manager\issuer-keys\private.pem" move /Y "%APPDATA%\pacs-chx-license-manager\issuer-keys\private.pem" "%BACKUP_DIR%\appdata-private.pem" >nul
if exist "%APPDATA%\pacs-chx-license-manager\issuer-keys\public.pem" move /Y "%APPDATA%\pacs-chx-license-manager\issuer-keys\public.pem" "%BACKUP_DIR%\appdata-public.pem" >nul
echo Chaves publicas antigas salvas em:
echo %BACKUP_DIR%
echo.
echo Abrindo o License Manager para gerar nova autoridade...
call "%~dp0ABRIR-GERADOR-LICENCAS.bat"
popd
exit /b %ERRORLEVEL%
