param([switch]$LicenseOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $projectRoot 'server'

function Invoke-Npm {
  param([string[]]$Arguments, [string]$WorkingDirectory = $projectRoot)
  Push-Location $WorkingDirectory
  try {
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm falhou com codigo $LASTEXITCODE" }
  } finally { Pop-Location }
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'Node.js nao encontrado. Instale o Node.js LTS antes de iniciar o PACS CHX.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw 'npm nao encontrado. Reinstale o Node.js com o npm habilitado.'
}

$electronExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExe)) {
  $electronPackage = Join-Path $projectRoot 'node_modules\electron'
  if (Test-Path -LiteralPath $electronPackage) {
    $resolvedElectron = (Resolve-Path -LiteralPath $electronPackage).Path
    if (-not $resolvedElectron.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Pasta Electron fora do projeto; reparo cancelado.'
    }
    Remove-Item -LiteralPath $resolvedElectron -Recurse -Force
  }
  Invoke-Npm -Arguments @('install')
  # O npm pode restaurar apenas o pacote JS sem repetir o download do binario
  # (por exemplo, apos antivirus/quarentena ou cache incompleto).
  if (-not (Test-Path -LiteralPath $electronExe)) {
    $electronInstaller = Join-Path $projectRoot 'node_modules\electron\install.js'
    if (Test-Path -LiteralPath $electronInstaller) {
      Push-Location $projectRoot
      try {
        & node.exe $electronInstaller
        if ($LASTEXITCODE -ne 0) { throw "Download do Electron falhou com codigo $LASTEXITCODE" }
      } finally { Pop-Location }
    }
  }
  if (-not (Test-Path -LiteralPath $electronExe)) {
    throw 'Electron nao foi instalado. Verifique a internet/antivirus e tente novamente.'
  }
}

if ($LicenseOnly) { exit 0 }

Add-Type -AssemblyName System.Security
$secretDir = Join-Path $serverRoot 'secrets'
$keyPath = Join-Path $secretDir 'pacs-db-key.dpapi'
$keyWorksHere = $false

if (Test-Path -LiteralPath $keyPath) {
  try {
    $protected = [IO.File]::ReadAllBytes($keyPath)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $keyWorksHere = $plain.Length -eq 32
  } catch { $keyWorksHere = $false }
}

if (-not $keyWorksHere) {
  $runtimeItems = @(
    (Join-Path $projectRoot 'pacs.db'),
    (Join-Path $projectRoot 'pacs.db-wal'),
    (Join-Path $projectRoot 'pacs.db-shm'),
    (Join-Path $projectRoot 'storage'),
    (Join-Path $projectRoot 'logs'),
    (Join-Path $serverRoot 'config.json'),
    (Join-Path $serverRoot 'service-auth.json'),
    $keyPath
  ) | Where-Object { Test-Path -LiteralPath $_ }

  if ($runtimeItems.Count -gt 0) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupRoot = Join-Path $serverRoot "portable-backups\foreign-runtime-$stamp"
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    foreach ($item in $runtimeItems) {
      $resolved = (Resolve-Path -LiteralPath $item).Path
      if (-not $resolved.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Item fora do projeto; transferencia cancelada: $resolved"
      }
      Move-Item -LiteralPath $resolved -Destination $backupRoot
    }
    Write-Host "Dados da outra maquina preservados em: $backupRoot" -ForegroundColor Yellow
  }

  New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
  $key = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($key) } finally { $rng.Dispose() }
  $protected = [Security.Cryptography.ProtectedData]::Protect($key, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($keyPath, $protected)
  Write-Host 'Nova chave de desenvolvimento criada para este computador.' -ForegroundColor Green
}

$serverDriver = Join-Path $serverRoot 'node_modules\better-sqlite3-multiple-ciphers'
if (-not (Test-Path -LiteralPath $serverDriver)) {
  Invoke-Npm -Arguments @('install') -WorkingDirectory $serverRoot
} else {
  Push-Location $serverRoot
  try {
    & node -e "require('better-sqlite3-multiple-ciphers')"
    if ($LASTEXITCODE -ne 0) { Invoke-Npm -Arguments @('install') -WorkingDirectory $serverRoot }
  } finally { Pop-Location }
}

exit 0
