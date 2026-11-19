$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$keyFile = Join-Path $env:APPDATA 'pacs-chx-license-manager\issuer-keys\private.pem'
$publicFile = Join-Path $PSScriptRoot '..\server\license-public.pem'
if (-not (Test-Path -LiteralPath $keyFile)) { throw "Chave protegida nao encontrada em $keyFile" }
if (-not (Test-Path -LiteralPath $publicFile)) { throw "Chave publica de verificacao nao encontrada em $publicFile" }

$secureOne = Read-Host 'Crie uma senha longa para criptografar a chave de importacao' -AsSecureString
$secureTwo = Read-Host 'Digite a mesma senha novamente' -AsSecureString
$ptrOne = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureOne)
$ptrTwo = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureTwo)
$plainText = $null
$derived = $null
$privateBytes = $null
try {
  $passOne = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptrOne)
  $passTwo = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptrTwo)
  if ($passOne -ne $passTwo -or $passOne.Length -lt 20) { throw 'As senhas precisam ser iguais e ter no minimo 20 caracteres.' }

  $protected = [Convert]::FromBase64String((Get-Content -LiteralPath $keyFile -Raw).Trim())
  $privateBytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $plainText = [Text.Encoding]::UTF8.GetString($privateBytes)
  if (-not $plainText.Contains('-----BEGIN PRIVATE KEY-----')) { throw 'O arquivo local nao contem uma chave Ed25519 PKCS8 reconhecida.' }

  $salt = New-Object byte[] 16
  $iv = New-Object byte[] 16
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($salt)
  $rng.GetBytes($iv)
  $iterations = 600000
  $kdf = [Security.Cryptography.Rfc2898DeriveBytes]::new($passOne, $salt, $iterations)
  $derived = $kdf.GetBytes(64)
  $aes = [Security.Cryptography.Aes]::Create()
  $aes.KeySize = 256
  $aes.Mode = [Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $derived[0..31]
  $aes.IV = $iv
  $encryptor = $aes.CreateEncryptor()
  $plain = [Text.Encoding]::UTF8.GetBytes($plainText)
  $ciphertext = $encryptor.TransformFinalBlock($plain, 0, $plain.Length)
  $authenticated = New-Object byte[] ($salt.Length + $iv.Length + $ciphertext.Length)
  [Buffer]::BlockCopy($salt, 0, $authenticated, 0, $salt.Length)
  [Buffer]::BlockCopy($iv, 0, $authenticated, $salt.Length, $iv.Length)
  [Buffer]::BlockCopy($ciphertext, 0, $authenticated, $salt.Length + $iv.Length, $ciphertext.Length)
  $macKey = [byte[]]$derived[32..63]
  $hmac = [Security.Cryptography.HMACSHA256]::new($macKey)
  $mac = $hmac.ComputeHash($authenticated)
  $publicKey = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $publicFile)).Trim() + "`n"
  $bundle = [ordered]@{
    version = 1
    iterations = $iterations
    publicKey = $publicKey
    salt = [Convert]::ToBase64String($salt)
    iv = [Convert]::ToBase64String($iv)
    ciphertext = [Convert]::ToBase64String($ciphertext)
    mac = [Convert]::ToBase64String($mac)
  } | ConvertTo-Json -Compress
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bundle))
  Write-Host ''
  Write-Host 'Copie a linha Base64 acima para LICENSE_KEY_BUNDLE na Hostinger.'
  Write-Host 'Configure a senha digitada acima em LICENSE_KEY_PASSPHRASE. Nunca coloque a chave no HTML.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptrOne)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptrTwo)
  $secureOne.Dispose()
  $secureTwo.Dispose()
  if ($privateBytes) { [Array]::Clear($privateBytes, 0, $privateBytes.Length) }
  if ($derived) { [Array]::Clear($derived, 0, $derived.Length) }
  if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
  $plainText = $null
  $passOne = $null
  $passTwo = $null
}
