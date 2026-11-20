@echo off
setlocal
set "WUYING_PREVIEW_ROOT=%~dp0"
set "WUYING_PREVIEW_MODE=%~1"
powershell.exe -NoProfile -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$root = $env:WUYING_PREVIEW_ROOT; $url = 'http://127.0.0.1:8881/files.html';" ^
  "function Test-Workspace { try { return (Invoke-RestMethod -Uri 'http://127.0.0.1:8881/api/workspace/health' -TimeoutSec 1).workspace -eq 2 } catch { return $false } }" ^
  "function Test-Admin { try { return (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8882/api/config' -TimeoutSec 1).StatusCode -eq 200 } catch { return $false } }" ^
  "$node = Get-Command node.exe -ErrorAction SilentlyContinue;" ^
  "if (-not $node) { throw 'Install Node.js 24 LTS to start the Wuying workspace.' }" ^
  "if (-not (Test-Workspace)) {" ^
  "  if (Get-NetTCPConnection -State Listen -LocalPort 8881 -ErrorAction SilentlyContinue) { throw 'Port 8881 is in use. Stop the previous Wuying Python preview or other application using it, then rerun this launcher.' }" ^
  "  $server = Start-Process -FilePath $node.Source -ArgumentList 'server/workspace-api.cjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru;" ^
  "  $deadline = [DateTime]::UtcNow.AddSeconds(12);" ^
  "  do { if ($server.HasExited) { break }; Start-Sleep -Milliseconds 250; $ready = Test-Workspace } until ($ready -or [DateTime]::UtcNow -gt $deadline);" ^
  "  if (-not $ready -and -not (Test-Workspace)) { throw 'Wuying workspace failed to start. Try running node server/workspace-api.cjs from the project folder to see the error.' }" ^
  "}" ^
  "if (-not (Test-Admin) -and -not (Get-NetTCPConnection -State Listen -LocalPort 8882 -ErrorAction SilentlyContinue)) {" ^
  "  Start-Process -FilePath $node.Source -ArgumentList 'server/image-api.cjs' -WorkingDirectory $root -WindowStyle Hidden;" ^
  "}" ^
  "$comfy = 'D:\Comfy-Desktop\ComfyUI-Installs\毕设\ComfyUI';" ^
  "if ((Test-Path (Join-Path $comfy 'main.py')) -and -not (Get-NetTCPConnection -State Listen -LocalPort 8188 -ErrorAction SilentlyContinue)) {" ^
  "  Write-Output 'Starting ComfyUI (Bishe install) on 8188...';" ^
  "  Start-Process -FilePath (Join-Path $comfy '.venv\Scripts\python.exe') -ArgumentList 'main.py','--listen','127.0.0.1','--port','8188','--enable-cors-header','*','--output-directory','D:\Comfy-Desktop\ComfyUI-Shared\output','--input-directory','D:\Comfy-Desktop\ComfyUI-Shared\input' -WorkingDirectory $comfy -WindowStyle Minimized;" ^
  "}" ^
  "Write-Output $url; if ($env:WUYING_PREVIEW_MODE -ne '--no-browser') { Start-Process $url }"
if errorlevel 1 (
  if /I not "%~1"=="--no-browser" pause
  exit /b 1
)
