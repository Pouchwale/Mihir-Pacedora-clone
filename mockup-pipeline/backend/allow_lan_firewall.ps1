#Requires -RunAsAdministrator
# Run once as administrator: lets devices on this PC's own network (not the internet) reach port 8765.
Remove-NetFirewallRule -DisplayName "Mockup Pipeline (LAN)" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Mockup Pipeline (LAN)" -Direction Inbound -Protocol TCP -LocalPort 8765 `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
