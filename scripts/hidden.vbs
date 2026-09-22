' Startet ein PowerShell-Skript ohne sichtbares Fenster (kein kurzes Aufblitzen der Konsole).
' Aufruf: wscript.exe hidden.vbs <skript.ps1> [weitere Argumente]
Option Explicit
Dim sh, args, i
Set sh = CreateObject("WScript.Shell")
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & WScript.Arguments(i) & """"
Next
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File" & args, 0, False
