' Starts the Church Presenter server with no visible command-prompt window,
' then opens the control panel in the default browser. Designed so anyone can
' double-click it -- no typing, no terminal. Safe to run again if it's
' already running (it just opens the control panel, no second copy started).

Option Explicit

Dim shell, fso, scriptDir
Dim npmCheck, installResult, i, ready

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
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

If Not ServerIsUp() Then

    ' Make sure Node.js is installed before trying anything else
    npmCheck = shell.Run("cmd /c where npm >nul 2>nul", 0, True)
    If npmCheck <> 0 Then
        MsgBox "Church Presenter needs Node.js, which isn't installed on " & _
            "this computer yet." & vbCrLf & vbCrLf & _
            "Go to https://nodejs.org, download the LTS version, install " & _
            "it, then double-click this icon again.", vbExclamation, "Church Presenter"
        WScript.Quit
    End If

    ' First run only: install the app's components
    If Not fso.FolderExists(scriptDir & "\node_modules") Then
        MsgBox "Setting up Church Presenter for the first time. This can " & _
            "take a minute or two -- click OK, then wait.", vbInformation, "Church Presenter"
        installResult = shell.Run("cmd /c npm install >> ""setup.log"" 2>&1", 0, True)
        If installResult <> 0 Then
            MsgBox "Setup didn't finish correctly. Open the 'setup.log' " & _
                "file in this folder for details, or ask for help.", vbCritical, "Church Presenter"
            WScript.Quit
        End If
    End If

    ' Start the server in the background (no visible window)
    shell.Run "cmd /c npm start >> ""backend.log"" 2>&1", 0, False

    ' Wait for it to actually be ready (up to ~20 seconds) instead of guessing
    ready = False
    For i = 1 To 40
        WScript.Sleep 500
        If ServerIsUp() Then
            ready = True
            Exit For
        End If
    Next

    If Not ready Then
        MsgBox "Church Presenter is taking longer than usual to start. " & _
            "Opening the control panel anyway -- if the page looks broken, " & _
            "wait a few seconds and refresh it.", vbInformation, "Church Presenter"
    End If

End If

shell.Run "http://localhost:3210/control/"
