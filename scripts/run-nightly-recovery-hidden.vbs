Option Explicit
Dim shell, files, project, checkout, node, command, exitCode, retryCount
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
checkout = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
project = files.GetParentFolderName(checkout)
shell.Environment("PROCESS")("WHATMCP_HOME") = files.BuildPath(project, "data")
shell.Environment("PROCESS")("WHATMCP_NIGHTLY_RECOVERY") = "1"
node = files.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
command = """" & node & """ --experimental-sqlite --experimental-strip-types --no-warnings """ & files.BuildPath(checkout, "src\cli.ts") & """ sync --scheduled"
retryCount = 0
Do
    exitCode = shell.Run(command, 0, True)
    If exitCode <> 75 Or retryCount >= 40 Then Exit Do
    WScript.Sleep 30000
    retryCount = retryCount + 1
Loop
WScript.Quit exitCode
