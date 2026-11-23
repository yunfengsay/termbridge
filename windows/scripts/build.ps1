param([string]$Dotnet='dotnet',[string]$Architecture='x64')
$ErrorActionPreference='Continue'
$root=Split-Path $PSScriptRoot
$output=Join-Path $root 'dist\app'
& $Dotnet publish "$root\TermBridge.App\TermBridge.App.csproj" -c Release -r "win-$Architecture" -p:Platform=$Architecture --self-contained true -o $output
if($LASTEXITCODE -ne 0){throw 'WinUI build failed'}
& $Dotnet publish "$root\TermBridge.Cli\TermBridge.Cli.csproj" -c Release -r "win-$Architecture" --self-contained true -o $output
if($LASTEXITCODE -ne 0){throw 'CLI shim build failed'}
if(Test-Path "$root\.cache\runtime"){New-Item "$output\runtime" -ItemType Directory -Force | Out-Null;Copy-Item "$root\.cache\runtime\*" "$output\runtime" -Recurse -Force}
Write-Output "Built native TermBridge: $output"

Copy-Item "$root\THIRD_PARTY_NOTICES.md" $output -Force

$browser=if(Test-Path "$root\browser-extension"){"$root\browser-extension"}else{Join-Path (Split-Path $root) 'browser-extension'}
New-Item "$output\browser-extension" -ItemType Directory -Force | Out-Null
Copy-Item "$browser\bridge.mjs" "$output\browser-extension" -Force
Copy-Item "$browser\extension" "$output\browser-extension" -Recurse -Force
