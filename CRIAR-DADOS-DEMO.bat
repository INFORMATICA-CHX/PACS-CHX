@echo off
setlocal
pushd "%~dp0"
title PACS CHX Dados Demo
call npm.cmd run seed:demo
if errorlevel 1 goto :error
echo.
echo Dados demonstrativos criados com sucesso.
pause
popd
exit /b 0
:error
echo Falha ao criar os dados demonstrativos.
pause
popd
exit /b 1
