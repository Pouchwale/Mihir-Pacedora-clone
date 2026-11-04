# Optional HTTPS for the office network: makes a self-signed certificate for this PC's name and IP address
# in backend\certs (cert.pem, key.pem) with the openssl that ships with Git for Windows.
# Then set in backend\.env:   SSL_CERTFILE=certs\cert.pem   SSL_KEYFILE=certs\key.pem   COOKIE_SECURE=true
# and restart. Address: https://<IP>:8765. Each browser warns once about the self-signed certificate until
# certs\cert.pem is imported on that device (Windows: double-click cert.pem -> Install -> Local Machine ->
# "Trusted Root Certification Authorities"); do that only on the office's own devices.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$openssl = @("C:\Program Files\Git\usr\bin\openssl.exe", "C:\Program Files\Git\mingw64\bin\openssl.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $openssl) { throw "openssl not found (it ships with Git for Windows)" }
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in "Dhcp", "Manual" } | Select-Object -First 1).IPAddress
New-Item -ItemType Directory -Force certs | Out-Null
& $openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs\key.pem -out certs\cert.pem `
    -subj "/CN=$env:COMPUTERNAME" -addext "subjectAltName=DNS:$env:COMPUTERNAME,DNS:localhost,IP:$ip,IP:127.0.0.1"
Write-Host "Made certs\cert.pem for $env:COMPUTERNAME / $ip. Now set SSL_CERTFILE, SSL_KEYFILE and COOKIE_SECURE in backend\.env and restart."
