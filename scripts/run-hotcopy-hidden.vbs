Option Explicit
Dim shell, files, project, checkout, node, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
checkout = files.GetParentFolderName(files.GetParentFolderName(WScript.ScriptFullName))
project = files.GetParentFolderName(checkout)
shell.Environment("PROCESS")("WHATMCP_HOME") = files.BuildPath(project, "data")
node = files.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
command = """" & node & """ --experimental-sqlite --experimental-strip-types --no-warnings """ & files.BuildPath(checkout, "src\cli.ts") & """ sync --scheduled"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
