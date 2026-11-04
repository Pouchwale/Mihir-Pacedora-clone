# Local all-in-one: API + background jobs (thread mode, no Redis) + built UI on http://127.0.0.1:8765
# (or the next free port when another program already uses 8765; $env:PORT picks the first port to try).
# Usage:  powershell -ExecutionPolicy Bypass -File run_local.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$env:PYTHONPATH = "."

# ---- port
# The port the app gets is written to .work\port: the phase-1 runner and the Vite dev server read it
# there, and INTERNAL_BASE_URL (where the ngrok share tunnel forwards) is set to it below.
$PortFile = ".work\port"
$FirstPort = if ($env:PORT) { [int]$env:PORT } else { 8765 }

function Test-OurApp([int]$p) {
    # this app answers there (its API title), not just any program
    try { (Invoke-RestMethod "http://127.0.0.1:$p/api/openapi.json" -TimeoutSec 3).info.title -eq "Pouch mockup pipeline" } catch { $false }
}
function Get-PortOwner([int]$p) {
    try {
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
        $name = (Get-Process -Id $c.OwningProcess -ErrorAction Stop).ProcessName
        return "$name (PID $($c.OwningProcess))"
    } catch { return $null }
}
function Test-PortFree([int]$p) {
    if (Get-PortOwner $p) { return $false }  # someone listens there, on any address
    # Also catches ports Windows reserves (Hyper-V / WSL excluded ranges) that nobody "listens" on
    try { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); return $true } catch { return $false }
}

# Already running (on 8765, or where the last start put it)? Then do not start a second copy: two
# servers on one database would both pick up the same queued jobs and run them twice.
$known = @($FirstPort)
if (Test-Path $PortFile) {
    $saved = 0
    if ([int]::TryParse("$(Get-Content $PortFile -Raw)".Trim(), [ref]$saved)) { $known += $saved }
}
foreach ($p in ($known | Select-Object -Unique)) {
    if (Test-OurApp $p) {
        Write-Host "The app is already running: open http://127.0.0.1:$p  (close that window first to restart it)"
        exit 0
    }
}

if (-not $env:DATABASE_URL) { $env:DATABASE_URL = "sqlite:///./.work/dev.db" }
if (-not $env:POPPLER_BIN) { $env:POPPLER_BIN = (Resolve-Path ..\.tools\poppler-26.09.0\Library\bin).Path }
if (-not $env:TESSERACT_CMD) { $env:TESSERACT_CMD = "C:\Program Files\Tesseract-OCR\tesseract.exe" }
# Per-user conda-forge install (used where GitHub downloads are blocked); its language data is in share\tessdata.
$userTess = "$env:LOCALAPPDATA\Programs\Tesseract-OCR"
if (-not (Test-Path $env:TESSERACT_CMD) -and (Test-Path "$userTess\Library\bin\tesseract.exe")) {
    $env:TESSERACT_CMD = "$userTess\Library\bin\tesseract.exe"
    if (-not $env:TESSDATA_PREFIX) { $env:TESSDATA_PREFIX = "$userTess\share\tessdata" }
}
# The users' data folder (upload copies, activity and server logs), outside the code so updates never touch it.
if (-not $env:DATA_DIR) { $env:DATA_DIR = Join-Path (Resolve-Path ..\..\..).Path "MockupData" }
# The first administrator comes from ADMIN_EMAIL / ADMIN_PASSWORD (environment or backend\.env); there is
# no built-in default: the server listens on the whole network, and a password printed in a README is none.
# The UI is rebuilt whenever its source is newer than the build: an old build kept serving fixed bugs
# (FGPO7700's butterfly drawn as a second V notch after the fix was in the source).
$built = Get-Item ..\frontend\dist\index.html -ErrorAction SilentlyContinue
$newer = if ($built) { Get-ChildItem ..\frontend\src, ..\frontend\index.html, ..\frontend\vite.config.ts, ..\frontend\package.json -Recurse -File | Where-Object { $_.LastWriteTime -gt $built.LastWriteTime } | Select-Object -First 1 } else { $true }
if ($newer) {
    Push-Location ..\frontend
    if (-not (Test-Path node_modules)) { npm install }
    npm run build
    $ok = $LASTEXITCODE -eq 0
    Pop-Location
    if (-not $ok -and -not $built) { throw "the UI did not build and there is no earlier build to serve" }
    if (-not $ok) { Write-Warning "the UI did not build; serving the previous build" }
}
& .venv\Scripts\python.exe -m alembic upgrade head
& .venv\Scripts\python.exe -m app.cli bootstrap
# Chosen last, right before the server starts, so nothing else takes the port in between.
$Port = $null
for ($p = $FirstPort; $p -lt $FirstPort + 50; $p++) {
    if (Test-PortFree $p) { $Port = $p; break }
    $owner = Get-PortOwner $p
    if ($owner) { Write-Host "Port $p is in use by $owner; trying $($p + 1)" } else { Write-Host "Port $p is reserved by Windows; trying $($p + 1)" }
}
if (-not $Port) { throw "No free port between $FirstPort and $($FirstPort + 49). Free one, or set `$env:PORT to another starting port." }
New-Item -ItemType Directory -Force .work | Out-Null
Set-Content -Path $PortFile -Value $Port -Encoding ascii
$env:INTERNAL_BASE_URL = "http://127.0.0.1:$Port"  # the share tunnel forwards here (app.api.tunnel)

# Listens on the whole network (other PCs in the office open it by this PC's address; allow_lan_firewall.ps1
# opens the port); $env:HOST = "127.0.0.1" keeps it to this PC.
if (-not $env:HOST) { $env:HOST = "0.0.0.0" }
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -in "Dhcp", "Manual" } | Select-Object -First 1).IPAddress
if ($ip -and $env:HOST -ne "127.0.0.1") { Write-Host "Open http://$ip`:$Port or http://127.0.0.1:$Port" } else { Write-Host "Open http://127.0.0.1:$Port" }
Write-Host "Uploads and logs are kept in $env:DATA_DIR"
& .venv\Scripts\python.exe -m uvicorn app.api.main:app --host $env:HOST --port $Port
