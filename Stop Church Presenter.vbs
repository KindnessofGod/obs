' Stops the Church Presenter server (whatever process is listening on port
' 3210), with no visible command-prompt window. Only needed if you want to
' fully shut it down between services -- otherwise it's fine to leave running.

Option Explicit

Dim shell
Set shell = CreateObject("WScript.Shell")

shell.Run "powershell -NoProfile -WindowStyle Hidden -Command " & _
    """Get-NetTCPConnection -LocalPort 3210 -ErrorAction SilentlyContinue | " & _
    "Select-Object -ExpandProperty OwningProcess -Unique | " & _
    "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }""", 0, True

MsgBox "Church Presenter has been stopped.", 64, "Church Presenter"
