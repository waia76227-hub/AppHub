Option Explicit
Dim fso, sh, base, nodeExe, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then
    nodeExe = "node.exe"
    If sh.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
        MsgBox "AppHub needs Node.js. Please install it from nodejs.org, then try again.", 48, "AppHub"
        WScript.Quit
    End If
End If

cmd = """" & nodeExe & """ """ & base & "\server\server.js"" --open"
On Error Resume Next
sh.Run cmd, 0, False
If Err.Number <> 0 Then
    MsgBox "Could not start AppHub: " & Err.Description, 16, "AppHub"
End If
