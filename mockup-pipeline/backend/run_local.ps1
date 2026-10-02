# Local all-in-one: API + background jobs (thread mode, no Redis) + built UI on http://127.0.0.1:8765
# Usage:  powershell -ExecutionPolicy Bypass -File run_local.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$env:PYTHONPATH = "."
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = "sqlite:///./.work/dev.db" }
if (-not $env:POPPLER_BIN) { $env:POPPLER_BIN = (Resolve-Path ..\.tools\poppler-26.09.0\Library\bin).Path }
if (-not $env:TESSERACT_CMD) { $env:TESSERACT_CMD = "C:\Program Files\Tesseract-OCR\tesseract.exe" }
# Per-user conda-forge install (used where GitHub downloads are blocked); its language data is in share\tessdata.
$userTess = "$env:LOCALAPPDATA\Programs\Tesseract-OCR"
if (-not (Test-Path $env:TESSERACT_CMD) -and (Test-Path "$userTess\Library\bin\tesseract.exe")) {
    $env:TESSERACT_CMD = "$userTess\Library\bin\tesseract.exe"
    if (-not $env:TESSDATA_PREFIX) { $env:TESSDATA_PREFIX = "$userTess\share\tessdata" }
}
if (-not $env:ADMIN_EMAIL) { $env:ADMIN_EMAIL = "admin@example.com" }
if (-not $env:ADMIN_PASSWORD) { $env:ADMIN_PASSWORD = "change-me-please-1" }
if (-not (Test-Path ..\frontend\dist\index.html)) { Push-Location ..\frontend; npm install; npm run build; Pop-Location }
& .venv\Scripts\python.exe -m alembic upgrade head
& .venv\Scripts\python.exe -m app.cli bootstrap
Write-Host "Open http://127.0.0.1:8765  (sign in: $env:ADMIN_EMAIL)"
& .venv\Scripts\python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8765
