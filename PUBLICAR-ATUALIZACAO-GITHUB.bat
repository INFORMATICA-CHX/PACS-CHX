@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

set "REPO=INFORMATICA-CHX/PACS-CHX"
set "PUBLISH_CURRENT=0"
if /I "%~1"=="--current" set "PUBLISH_CURRENT=1"

where npm >nul 2>nul || goto missing_npm
where git >nul 2>nul || goto missing_git
where gh >nul 2>nul || goto missing_gh

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH goto detached_head
for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "ORIGIN=%%R"
if not defined ORIGIN goto missing_origin
echo %ORIGIN% | findstr /I /C:"INFORMATICA-CHX/PACS-CHX" >nul || goto wrong_repo

for /f "delims=" %%V in ('npm pkg get version 2^>nul') do set "CURRENT_VERSION=%%~V"
if not defined CURRENT_VERSION goto bad_version
for /f "delims=" %%S in ('git status --porcelain --untracked-files^=all -- . ":(exclude).gitignore" ":(exclude)PUBLICAR-ATUALIZACAO-GITHUB.bat" ":(exclude)README.md" ":(exclude)package.json" ":(exclude)package-lock.json" ":(exclude)server/src/config.js" ":(exclude)src/data/sampleData.ts" ":(exclude)server/config.json" ":(exclude)cd (33)/**" ":(exclude)main.cjs"') do set "DIRTY=%%S"
if defined DIRTY goto dirty_tree

gh auth status >nul 2>nul
if errorlevel 1 call :authenticate_github
if errorlevel 1 goto gh_not_authenticated

if "%PUBLISH_CURRENT%"=="1" goto current_release

set "NEXT_VERSION="
for /f "delims=" %%V in ('node -e "const v=require('./package.json').version.split('.').map(Number); v[2]++; console.log(v.join('.'))" 2^>nul') do set "NEXT_VERSION=%%V"
if not defined NEXT_VERSION goto bad_version
set "TAG=v%NEXT_VERSION%"
gh release view "%TAG%" --repo "%REPO%" >nul 2>nul
if not errorlevel 1 goto tag_exists

echo.
echo Repositorio: %REPO%
echo Branch: %BRANCH%
echo Versao atual: %CURRENT_VERSION%
echo Proxima versao: %NEXT_VERSION%
echo.
echo O script vai incrementar a versao, compilar, criar um commit dos arquivos
echo revisados, enviar a branch e publicar o instalador e os metadados.
echo server/config.json local e cd (33) sao ignorados e excluidos do instalador.
echo.
choice /C SN /N /M "Confirma a publicacao? [S/N] "
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

git add -- .gitignore PUBLICAR-ATUALIZACAO-GITHUB.bat README.md package.json package-lock.json server/src/config.js src/data/sampleData.ts
if errorlevel 1 goto commit_failed
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

:missing_npm
echo ERRO: npm nao encontrado no PATH. Instale Node.js e abra um terminal novo.
goto failed_pause
:missing_git
echo ERRO: Git nao encontrado no PATH.
goto failed_pause
:missing_gh
echo ERRO: GitHub CLI (gh) nao encontrado. Instale-o e abra um terminal novo.
goto failed_pause
:gh_not_authenticated
echo ERRO: GitHub CLI sem autenticacao. Execute: gh auth login
goto failed_pause
:missing_origin
echo ERRO: remote origin nao configurado.
goto failed_pause
:wrong_repo
echo ERRO: o remote origin nao aponta para %REPO%.
goto failed_pause
:bad_version
echo ERRO: nao foi possivel ler a versao de package.json.
goto failed_pause
:bad_version_after_increment
echo ERRO: versao nao foi lida depois do incremento. package.json pode ter sido alterado.
goto failed_pause
:detached_head
echo ERRO: checkout sem branch ativo. Troque para uma branch antes de publicar.
goto failed_pause
:dirty_tree
echo ERRO: existem alteracoes locais ou arquivos nao rastreados.
echo Ha alteracoes fora da lista explicitamente revisada pelo publicador.
echo Revise-as e faca commit manual antes de continuar.
goto failed_pause
:version_files_dirty
echo ERRO: package.json ou package-lock.json ja tinham alteracoes antes do incremento de versao.
echo Reverta ou commit essas alteracoes antes de publicar.
goto failed_pause
:tag_exists
echo ERRO: a release %TAG% ja existe no GitHub. Confira package.json.
goto failed_pause
:version_failed
echo ERRO: nao foi possivel atualizar a versao nos manifests.
goto failed_pause
:build_failed
echo ERRO: o build falhou. O commit %TAG% ja foi criado localmente.
echo Corrija o erro, gere o instalador e publique a release manualmente.
goto failed_pause
:missing_installer
echo ERRO: instalador esperado nao foi gerado: %INSTALLER%
goto failed_pause
:missing_latest
echo ERRO: latest.yml nao foi gerado em release\.
goto failed_pause
:commit_failed
echo ERRO: nao foi possivel criar o commit da versao %TAG%.
goto failed_pause
:push_failed
echo ERRO: nao foi possivel enviar a branch usando as credenciais do GitHub CLI.
echo Execute gh auth login e tente sincronizar a branch novamente.
goto failed_pause
:release_failed
echo ERRO: o commit foi enviado, mas a release %TAG% nao foi criada.
echo Corrija a tag/permissao e publique os assets manualmente.
goto failed_pause
:cancelled
echo Publicacao cancelada; nenhuma versao foi alterada.
pause
exit /b 1
:authenticate_github
echo.
echo Autenticacao do GitHub necessaria. O navegador abrira para voce autorizar o gh.
call gh auth login -h github.com -p https -w
if errorlevel 1 exit /b 1
gh auth status >nul 2>nul
exit /b %errorlevel%
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
echo Publicar release existente: %TAG%
echo Assets: %INSTALLER%, %LATEST% e .blockmap (se disponivel)
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
:failed_pause
pause
exit /b 1
