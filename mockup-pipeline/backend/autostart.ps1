# Keeps the app running for every device on the network (http://<this PC's IP>:8765).
# Started at sign-in by "Start Mockup Pipeline.vbs" in the Startup folder; restarts the server if it stops.
Set-Location $PSScriptRoot
$env:HOST = "0.0.0.0"
$env:PUBLIC_URL = "https://gujprintpack.mockup.ngrok.app"  # share links keep working after a restart
$log = Join-Path (Resolve-Path ..\..\..).Path "MockupData\logs"
New-Item -ItemType Directory -Force $log | Out-Null
while ($true) {
    # a copy already serving (started by hand) is left alone
    if (-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) {
        $started = Get-Date
        # one UTF-8 log a day (the server writes its own lines to logs\server too; this one holds the start-up output and crashes)
        powershell -NoProfile -ExecutionPolicy Bypass -File run_local.ps1 2>&1 | Out-File -Append -Encoding utf8 (Join-Path $log ("autostart-{0:yyyy-MM-dd}.log" -f (Get-Date)))
        if (((Get-Date) - $started).TotalSeconds -lt 60) {
            # it died at once (a missing .venv, a failed migration, the port taken): do not spin, give the log a minute
            Start-Sleep 60
        }
    }
    Start-Sleep 15
}
