' Stops the Church Presenter server (whatever process is listening on port
' 3210), with no visible command-prompt window. Only needed if you want to
' fully shut it down between services -- otherwise it's fine to leave running.
' Don't run this while a service is live -- it drops whatever's on screen.

Option Explicit

Dim shell

Function ServerIsUp()
    Dim h
    ServerIsUp = False
    On Error Resume Next
    Set h = CreateObject("MSXML2.XMLHTTP")
    h.Open "GET", "http://localhost:3210/control/", False
    h.Send
    If Err.Number = 0 And h.Status = 200 Then
        ServerIsUp = True
    End If
    Err.Clear
    On Error Goto 0
End Function

Set shell = CreateObject("WScript.Shell")

If Not ServerIsUp() Then
    MsgBox "Church Presenter isn't running.", vbInformation, "Church Presenter"
    WScript.Quit
End If

shell.Run "powershell -NoProfile -WindowStyle Hidden -Command " & _
    """Get-NetTCPConnection -LocalPort 3210 -ErrorAction SilentlyContinue | " & _
    "Select-Object -ExpandProperty OwningProcess -Unique | " & _
    "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }""", 0, True

MsgBox "Church Presenter has been stopped.", vbInformation, "Church Presenter"
