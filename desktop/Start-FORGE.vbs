' FORGE desktop launcher (hidden console).
' 1. Verifies Node.js is on PATH.
' 2. Starts desktop\forge.js invisibly (it writes launch.json when ready).
' 3. Waits for launch.json, reads the port + server pid.
' 4. Opens an Edge/Chrome "app mode" window with a dedicated profile and
'    WAITS until that window process exits.
' 5. Terminates the FORGE server by pid and removes launch.json.
Option Explicit

Dim sh, fs, here, appDir, launchFile, nodeCheck
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")

here = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName))
appDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\FORGE"
launchFile = appDir & "\launch.json"

If fs.FileExists(launchFile) Then fs.DeleteFile(launchFile)

' Exit code 0 from "node -v" means Node.js is on PATH.
nodeCheck = sh.Run("cmd /c node -v > nul 2>&1", 0, True)
If nodeCheck <> 0 Then
  MsgBox "FORGE needs Node.js on PATH, but ""node"" was not found." & vbCrLf & _
         "Install the LTS build from https://nodejs.org and try again.", _
         vbCritical, "FORGE"
  WScript.Quit 1
End If

' Start the server bootstrap (hidden, do not wait).
sh.Run "node """ & here & "\desktop\forge.js""", 0, False

' Wait up to 20 seconds for launch.json (server is up).
Dim waited, info
waited = 0
Do While Not fs.FileExists(launchFile)
  If waited >= 20000 Then
    MsgBox "FORGE server did not start within 20 seconds." & vbCrLf & _
           "See " & appDir & "\forge.log for details.", vbCritical, "FORGE"
    WScript.Quit 1
  End If
  WScript.Sleep 200
  waited = waited + 200
Loop

' Extract "port" and "pid" numbers from launch.json.
Dim text, portNum, pidNum, rxPort, rxPid, mPort, mPid
Set rxPort = New RegExp
rxPort.Pattern = """port""\s*:\s*(\d+)"
Set rxPid = New RegExp
rxPid.Pattern = """pid""\s*:\s*(-?\d+)"
text = fs.OpenTextFile(launchFile, 1).ReadAll()
Set mPort = rxPort.Execute(text)
Set mPid = rxPid.Execute(text)
If mPort.Count = 0 Or mPid.Count = 0 Then
  MsgBox "launch.json is malformed: " & text, vbCritical, "FORGE"
  WScript.Quit 1
End If
portNum = mPort(0).SubMatches(0)
pidNum = mPid(0).SubMatches(0)

' Locate a Chromium browser (Edge ships with Windows).
Dim browser, candidates, c
candidates = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%LocalAppData%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe" _
)
browser = ""
For Each c In candidates
  If fs.FileExists(c) Then
    browser = c
    Exit For
  End If
Next

If browser = "" Then
  MsgBox "FORGE needs Microsoft Edge or Google Chrome." & vbCrLf & _
         "The server is running at http://127.0.0.1:" & portNum & "/ meanwhile.", _
         vbExclamation, "FORGE"
  WScript.Quit 0
End If

' Open the app window and WAIT until it closes (dedicated profile keeps the
' process alive exactly as long as this window exists).
Dim profileDir, appUrl, cmdline
profileDir = appDir & "\profile"
If Not fs.FolderExists(profileDir) Then fs.CreateFolder(profileDir)
appUrl = "http://127.0.0.1:" & portNum & "/"
cmdline = """" & browser & """ --app=" & appUrl & _
  " --user-data-dir=""" & profileDir & """ --no-first-run --no-default-browser-check --window-size=1440,900"
sh.Run cmdline, 1, True

' Window closed: stop the server and clean up.
sh.Run "cmd /c taskkill /PID " & pidNum & " /F > nul 2>&1", 0, True
If fs.FileExists(launchFile) Then fs.DeleteFile(launchFile)
