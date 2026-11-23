param([string]$AppDirectory="$env:LOCALAPPDATA\Programs\TermBridge Native")
$ErrorActionPreference='Stop'
$setup=& "$AppDirectory\tb.exe" browser install | ConvertFrom-Json
if(!$setup.ok){throw 'Native registration failed'}
$psi=New-Object Diagnostics.ProcessStartInfo
$psi.FileName="$AppDirectory\tb.exe";$psi.Arguments="chrome-extension://$($setup.extensionId)/";$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
$native=[Diagnostics.Process]::Start($psi)
function ReadBytes([int]$length){$buffer=New-Object byte[] $length;$offset=0;while($offset -lt $length){$task=$native.StandardOutput.BaseStream.ReadAsync($buffer,$offset,$length-$offset);if(!$task.Wait(5000)){throw 'Native frame read timeout'};$count=$task.Result;if(!$count){throw 'Native host closed unexpectedly'};$offset+=$count};return ,$buffer}
function ReadFrame {$header=ReadBytes 4;$length=[BitConverter]::ToInt32($header,0);if($length -lt 0 -or $length -gt 1048576){throw 'Invalid frame length'};return ([Text.Encoding]::UTF8.GetString((ReadBytes $length)) | ConvertFrom-Json)}
function SendFrame($value){$data=[Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress -Depth 8));$header=[BitConverter]::GetBytes([int]$data.Length);$native.StandardInput.BaseStream.Write($header,0,4);$native.StandardInput.BaseStream.Write($data,0,$data.Length);$native.StandardInput.BaseStream.Flush()}
try {
 $ready=ReadFrame;if($ready.event -ne 'connected'){throw 'Native handshake failed'}
 SendFrame @{event='permission';enabled=$true}
 Start-Sleep -Milliseconds 100
 $status=& "$AppDirectory\tb.exe" browser status | ConvertFrom-Json
 if(!$status.connected -or !$status.enabled){throw 'Consent did not reach native host'}
 SendFrame @{event='permission';enabled=$false}
 Start-Sleep -Milliseconds 100
 $status=& "$AppDirectory\tb.exe" browser status | ConvertFrom-Json
 if($status.enabled){throw 'Revocation failed'}
 'PASS Windows native binary framing, registration, connection, enable and revoke'
} finally {$native.StandardInput.Close();if(!$native.WaitForExit(5000)){$native.Kill()};$native.Dispose()}
