@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git nao foi encontrado no PATH.
  pause
  exit /b 1
)

git diff --cached --quiet
if errorlevel 1 (
  echo Ha alteracoes ja preparadas no stage. Revise-as antes de continuar.
  git diff --cached --stat
  pause
  exit /b 1
)

git add -- COMMITAR-ALTERACOES-MANUALMENTE.bat README.md build/installer.nsh electron/main.cjs electron/preload.cjs package.json package-lock.json server/src/index.js service/PacsChxServiceHost.cs src/components/ManagerPanel.tsx src/vite-env.d.ts "CRIAR NOVO INSTALADOR.bat"
if errorlevel 1 (
  echo Nao foi possivel preparar os arquivos revisados.
  pause
  exit /b 1
)

echo.
echo Arquivos que serao incluidos:
git diff --cached --stat
echo.
choice /C SN /N /M "Criar o commit manual agora? [S/N] "
if errorlevel 2 (
  git reset -- COMMITAR-ALTERACOES-MANUALMENTE.bat README.md build/installer.nsh electron/main.cjs electron/preload.cjs package.json package-lock.json server/src/index.js service/PacsChxServiceHost.cs src/components/ManagerPanel.tsx src/vite-env.d.ts "CRIAR NOVO INSTALADOR.bat" >nul
  echo Commit cancelado. Os arquivos voltaram a ficar fora do stage.
  exit /b 1
)

git commit -m "chore: commit reviewed local changes"
if errorlevel 1 (
  echo O Git nao conseguiu criar o commit.
  pause
  exit /b 1
)

echo.
echo Commit criado.
git log -1 --oneline
pause
endlocal
