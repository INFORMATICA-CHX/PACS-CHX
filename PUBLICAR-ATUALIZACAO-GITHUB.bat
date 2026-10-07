@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

set "REPO=INFORMATICA-CHX/PACS-CHX"
set "PUBLISH_CURRENT=0"
if /I "%~1"=="--current" set "PUBLISH_CURRENT=1"

where npm >nul 2>nul || goto missing_npm
where git >nul 2>nul || goto missing_git
where gh >nul 2>nul || goto missing_gh

call :ensure_github_auth
if errorlevel 1 goto gh_not_authenticated

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH goto detached_head
for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "ORIGIN=%%R"
if not defined ORIGIN goto missing_origin
echo %ORIGIN% | findstr /I /C:"INFORMATICA-CHX/PACS-CHX" >nul || goto wrong_repo

for /f "delims=" %%V in ('npm pkg get version 2^>nul') do set "CURRENT_VERSION=%%~V"
if not defined CURRENT_VERSION goto bad_version
if "%PUBLISH_CURRENT%"=="1" goto current_release

set "NEXT_VERSION="
for /f "delims=" %%V in ('node -e "const p=require('./package.json'); const a=p.version.split('.').map(Number); if(a.length!==3||a.some(Number.isNaN))process.exit(1); a[2]++; console.log(a.join('.'))" 2^>nul') do set "NEXT_VERSION=%%V"
if not defined NEXT_VERSION goto bad_version
set "TAG=v%NEXT_VERSION%"
gh release view "%TAG%" --repo "%REPO%" >nul 2>nul
if not errorlevel 1 goto tag_exists

echo.
echo Repositorio: %REPO%
echo Branch: %BRANCH%
echo Versao atual: %CURRENT_VERSION%
echo Nova versao: %NEXT_VERSION%
echo.
echo Mudancas locais candidatas ao commit:
git status --short
echo.
echo O arquivo local main.cjs sera ignorado. Arquivos ignorados pelo Git,
echo como configuracoes locais e dados, nao serao adicionados.
echo O script incrementara a versao, criara o commit, compilara o instalador,
echo enviara a branch e publicara uma GitHub Release.
echo.
choice /C SN /N /M "Confirma o fluxo completo? [S/N] "
if errorlevel 2 goto cancelled

git diff --quiet -- package.json package-lock.json
if errorlevel 1 goto version_files_dirty

set "VERSION=%NEXT_VERSION%"
set "TAG=v%VERSION%"
set "INSTALLER=release\PACS-CHX-Setup-%VERSION%.exe"
set "LATEST=release\latest.yml"
set "BLOCKMAP=release\PACS-CHX-Setup-%VERSION%.exe.blockmap"

node -e "const fs=require('fs'); for (const f of ['package.json','package-lock.json']) { const p=JSON.parse(fs.readFileSync(f,'utf8')); p.version='%VERSION%'; fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n'); }"
if errorlevel 1 goto version_failed

git add -A -- . ":(exclude)**/main.cjs" ":(exclude)**/config.json" ":(exclude)**/license.json" ":(exclude)cd (33)/**"
if errorlevel 1 goto commit_failed

git diff --cached --check
if errorlevel 1 goto staged_check_failed

echo.
echo Arquivos incluidos no commit:
git diff --cached --stat
echo.
git commit -m "chore: release %TAG%"
if errorlevel 1 goto commit_failed

call npm run dist:win
if errorlevel 1 goto build_failed
if not exist "%INSTALLER%" goto missing_installer
if not exist "%LATEST%" goto missing_latest

git -c credential.helper= -c "credential.https://github.com.helper=!gh auth git-credential" push origin "%BRANCH%"
if errorlevel 1 goto push_failed

if exist "%BLOCKMAP%" (
  gh release create "%TAG%" "%INSTALLER%" "%LATEST%" "%BLOCKMAP%" --repo "%REPO%" --target "%BRANCH%" --title "PACS CHX %TAG%" --generate-notes
) else (
  gh release create "%TAG%" "%INSTALLER%" "%LATEST%" --repo "%REPO%" --target "%BRANCH%" --title "PACS CHX %TAG%" --generate-notes
)
if errorlevel 1 goto release_failed

echo.
echo Release %TAG% publicada com sucesso.
echo https://github.com/%REPO%/releases/tag/%TAG%
pause
exit /b 0

:current_release
set "VERSION=%CURRENT_VERSION%"
set "TAG=v%VERSION%"
set "INSTALLER=release\PACS-CHX-Setup-%VERSION%.exe"
set "LATEST=release\latest.yml"
set "BLOCKMAP=release\PACS-CHX-Setup-%VERSION%.exe.blockmap"
if not exist "%INSTALLER%" goto missing_installer
if not exist "%LATEST%" goto missing_latest
gh release view "%TAG%" --repo "%REPO%" >nul 2>nul
if not errorlevel 1 goto tag_exists
echo.
echo Publicar assets existentes para %TAG%.
choice /C SN /N /M "Confirma o upload? [S/N] "
if errorlevel 2 goto cancelled
git -c credential.helper= -c "credential.https://github.com.helper=!gh auth git-credential" push origin "%BRANCH%"
if errorlevel 1 goto push_failed
if exist "%BLOCKMAP%" (
  gh release create "%TAG%" "%INSTALLER%" "%LATEST%" "%BLOCKMAP%" --repo "%REPO%" --target "%BRANCH%" --title "PACS CHX %TAG%" --generate-notes
) else (
  gh release create "%TAG%" "%INSTALLER%" "%LATEST%" --repo "%REPO%" --target "%BRANCH%" --title "PACS CHX %TAG%" --generate-notes
)
if errorlevel 1 goto release_failed
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
echo ERRO: GitHub CLI (gh) nao encontrado no PATH.
goto failed_pause
:gh_not_authenticated
echo ERRO: autenticacao do GitHub CLI nao concluida. Execute gh auth login e tente novamente.
goto failed_pause
:missing_origin
echo ERRO: remote origin nao configurado.
goto failed_pause
:wrong_repo
echo ERRO: o remote origin nao aponta para %REPO%.
goto failed_pause
:bad_version
echo ERRO: nao foi possivel ler ou incrementar a versao semver em package.json.
goto failed_pause
:detached_head
echo ERRO: checkout sem branch ativo. Troque para uma branch antes de publicar.
goto failed_pause
:version_files_dirty
echo ERRO: package.json ou package-lock.json ja estavam alterados antes do incremento.
echo Revise esses arquivos antes de publicar.
goto failed_pause
:tag_exists
echo ERRO: a release %TAG% ja existe no GitHub.
goto failed_pause
:version_failed
echo ERRO: nao foi possivel atualizar a versao nos manifests.
goto failed_pause
:staged_check_failed
echo ERRO: git diff --cached --check encontrou erros de espacos ou finais de linha.
goto failed_pause
:build_failed
echo ERRO: o build falhou. O commit %TAG% esta local; corrija e tente novamente.
goto failed_pause
:missing_installer
echo ERRO: instalador esperado nao encontrado: %INSTALLER%
goto failed_pause
:missing_latest
echo ERRO: latest.yml nao encontrado em release\.
goto failed_pause
:commit_failed
echo ERRO: nao foi possivel criar o commit. Revise o stage e tente novamente.
goto failed_pause
:push_failed
echo ERRO: nao foi possivel enviar a branch. Verifique a autenticacao e tente novamente.
goto failed_pause
:release_failed
echo ERRO: o commit foi enviado, mas a GitHub Release falhou. Publique os assets manualmente ou tente novamente.
goto failed_pause
:cancelled
echo Publicacao cancelada.
exit /b 1
:authenticate_github
echo.
echo Autenticacao do GitHub necessaria. O navegador abrira para autorizacao.
call gh auth login -h github.com -p https --web
if errorlevel 1 exit /b 1
exit /b 0
:ensure_github_auth
gh auth status >nul 2>nul
if not errorlevel 1 exit /b 0
call :authenticate_github
if errorlevel 1 exit /b 1
gh auth status >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0
:failed_pause
pause
exit /b 1
