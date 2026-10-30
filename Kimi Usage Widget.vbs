' Launch the Kimi Usage Widget completely hidden (no console window).
' Double-click this file, or point a shortcut at it.
Set shell = CreateObject("WScript.Shell")
proj = "C:\KomarovLocal\Kimi Code\KimiUsageWidget"
shell.CurrentDirectory = proj
shell.Run """" & proj & "\node_modules\.bin\electron.cmd"" .", 0, False
Set shell = Nothing
