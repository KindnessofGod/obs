' Starts the Church Presenter server with no visible command-prompt window,
' then opens the control panel in the default browser. Safe to double-click
' even if the server is already running (it won't start a second copy).

Option Explicit

Dim shell, fso, scriptDir, http, isRunning

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

isRunning = False
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://localhost:3210/control/", False
http.Send
If Err.Number = 0 And http.Status = 200 Then
    isRunning = True
End If
On Error Goto 0

If Not isRunning Then
    shell.CurrentDirectory = scriptDir
    shell.Run "cmd /c npm start >> ""backend.log"" 2>&1", 0, False
    WScript.Sleep 3000
End If

shell.Run "http://localhost:3210/control/"
