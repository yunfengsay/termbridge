param([Parameter(Mandatory=$true)][string]$InstallDirectory,[switch]$Remove)
$ErrorActionPreference='Stop'
if(!$Remove){
 $guid='{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
 $keys=@("HKCU:\Software\Microsoft\EdgeUpdate\Clients\$guid","HKLM:\Software\Microsoft\EdgeUpdate\Clients\$guid","HKLM:\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid")
 $installed=@($keys | ForEach-Object {(Get-ItemProperty $_ -Name pv -ErrorAction SilentlyContinue).pv} | Where-Object {$_ -and $_ -ne '0.0.0.0'}).Count -gt 0
 if(!$installed){
  $bootstrap=Join-Path $env:TEMP ('TermBridge-WebView2-'+[Guid]::NewGuid().ToString()+'.exe')
  try {
   [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
   Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrap -UseBasicParsing
   $signature=Get-AuthenticodeSignature $bootstrap
   if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'WebView2 installer signature is invalid'}
   $setup=Start-Process $bootstrap -ArgumentList '/silent','/install' -Wait -PassThru
   if($setup.ExitCode -ne 0){throw 'WebView2 Runtime installation failed'}
  } finally {Remove-Item $bootstrap -ErrorAction SilentlyContinue}
 }
}
$target=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$parts=@(([Environment]::GetEnvironmentVariable('Path','User') -split ';') | Where-Object { $_ -and $_.TrimEnd('\') -ine $target })
# Remove only the obsolete TB-owned shim; preserve unrelated PATH entries.
$old=Join-Path $env:LOCALAPPDATA 'TermBridge\bin'
if(!$Remove){$parts=@($parts | Where-Object {$_.TrimEnd('\') -ine $old});$parts+=$target}
[Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User')

if(!$Remove){
 & "$target\tb.exe" browser install
 if($LASTEXITCODE -ne 0){throw 'Chrome connection component registration failed'}
}

if($Remove){
 $key='HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.termbridge.browser'
 $manifest=(Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)'
 if($manifest -and (Test-Path $manifest)){
  $owner=Get-Content $manifest -Raw | ConvertFrom-Json
  if($owner.path -ieq "$target\tb.exe"){Remove-Item $key -Recurse;Remove-Item $manifest}
 }
}
