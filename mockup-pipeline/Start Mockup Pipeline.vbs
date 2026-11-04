' Put this file in the Startup folder (Win+R, shell:startup): starts the mockup pipeline hidden at every
' sign-in; it restarts itself if the server stops. The path is absolute so the file works from anywhere.
script = "C:\INTERN\MIHIR\Mihir-Pacedora-clone-main\mockup-pipeline\backend\autostart.ps1"
CreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """", 0, False
