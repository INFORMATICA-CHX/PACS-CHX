@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "REPO=INFORMATICA-CHX/PACS-CHX"

where npm >nul 2>nul || goto missing_npm
where git >nul 2>nul || goto missing_git
where gh >nul 2>nul || goto missing_gh

for /f "delims=" %%V in ('npm pkg get version') do set "CURRENT_VERSION=%%~V"
if not defined CURRENT_VERSION goto bad_version
for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if not defined BRANCH goto detached_head

for /f "delims=" %%S in ('git status --porcelain') do set "DIRTY=%%S"
if defined DIRTY goto dirty_tree

gh auth status >nul 2>nul || goto gh_not_authenticated

echo.
echo Repositorio: %REPO%
echo Versao instalada no projeto: %CURRENT_VERSION%
echo A nova versao sera o proximo incremento patch.
echo Branch: %BRANCH%
echo.
echo O processo vai construir o instalador, criar um commit com o incremento de versao,
echo enviar a branch ao GitHub e publicar uma GitHub Release.
choice /C SN /N /M "Confirma a publicacao? [S/N] "
if errorlevel 2 goto cancelled

call npm version patch --no-git-tag-version
if errorlevel 1 goto failed
for /f "delims=" %%V in ('npm pkg get version') do set "VERSION=%%~V"
if not defined VERSION goto bad_version
set "TAG=v%VERSION%"
set "INSTALLER=release\PACS CHX Setup %VERSION%.exe"
set "LATEST=release\latest.yml"
set "BLOCKMAP=release\PACS CHX Setup %VERSION%.exe.blockmap"

gh release view "%TAG%" --repo "%REPO%" >nul 2>nul && goto tag_exists

call npm run dist:win
if errorlevel 1 goto failed
if not exist "%INSTALLER%" goto missing_installer
if not exist "%LATEST%" goto missing_latest

git add package.json package-lock.json
if errorlevel 1 goto failed
git commit -m "chore: release %TAG%"
if errorlevel 1 goto failed
for /f "delims=" %%C in ('git rev-parse HEAD') do set "COMMIT=%%C"

git push origin "%BRANCH%"
if errorlevel 1 goto failed

if exist "%BLOCKMAP%" (
  gh release create "%TAG%" "%INSTALLER%" "%LATEST%" "%BLOCKMAP%" --repo "%REPO%" --target "%COMMIT%" --title "PACS CHX %TAG%" --generate-notes
) else (
  gh release create "%TAG%" "%INSTALLER%" "%LATEST%" --repo "%REPO%" --target "%COMMIT%" --title "PACS CHX %TAG%" --generate-notes
)
if errorlevel 1 goto failed

echo.
echo Release %TAG% publicada com sucesso.
echo https://github.com/%REPO%/releases/tag/%TAG%
pause
exit /b 0

:missing_npm
echo ERRO: npm nao encontrado no PATH.
goto failed_pause
:missing_git
echo ERRO: Git nao encontrado no PATH.
goto failed_pause
:missing_gh
echo ERRO: GitHub CLI (gh) nao encontrado. Instale: https://cli.github.com/
goto failed_pause
:gh_not_authenticated
echo ERRO: GitHub CLI sem autenticacao. Execute: gh auth login
goto failed_pause
:bad_version
echo ERRO: nao foi possivel ler uma versao semver valida do package.json.
goto failed_pause
:detached_head
echo ERRO: checkout sem branch ativo. Troque para uma branch antes de publicar.
goto failed_pause
:dirty_tree
echo ERRO: existem alteracoes locais. Faca commit ou descarte-as antes de publicar.
echo Isso garante que a release corresponda ao codigo enviado ao GitHub.
goto failed_pause
:tag_exists
echo ERRO: a tag ou release %TAG% ja existe no GitHub. Confira package.json antes de tentar novamente.
goto failed_pause
:missing_installer
echo ERRO: instalador esperado nao foi gerado: %INSTALLER%
goto failed_pause
:missing_latest
echo ERRO: latest.yml nao foi gerado em release\.
goto failed_pause
:cancelled
echo Publicacao cancelada.
pause
exit /b 1
:failed
echo.
echo ERRO: uma etapa falhou. Confira a mensagem acima.
:failed_pause
pause
exit /b 1