using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

// Windows-only bridge for existing desktop releases. Keep the signed Node runtime.
// The source fix in main.rs removes the need for this bridge in a rebuilt app.
internal static class DesktopNodeHost
{
    internal static string NormalizePath(string path)
    {
        if (path == null) return null;
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            return @"\\" + path.Substring(8);
        if (path.Length >= 7 && path.StartsWith(@"\\?\") &&
            Char.IsLetter(path[4]) && path[5] == ':' && path[6] == '\\')
            return path.Substring(4);
        return path;
    }
    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static void Check(bool condition, string label)
    { if (!condition) throw new Exception("Desktop Windows repair test failed: " + label); }
    private static int SelfTest()
    {
        Check(NormalizePath(@"\\?\C:\Users\Carlos Silva\server.ts") == @"C:\Users\Carlos Silva\server.ts", "local");
        Check(NormalizePath(@"\\?\UNC\server\share\arquivo") == @"\\server\share\arquivo", "UNC");
        foreach (var value in new[] { @"C:\normal", @"\\server\share", @"\\?\Volume{1234}\arquivo", @"\\.\pipe\test", "relative/path", "/Users/carlos/Library" })
            Check(NormalizePath(value) == value, "unchanged");
        Check(Quote("a\"b") == "\"a\\\"b\"", "embedded quote");
        Check(Quote(@"C:\space path\") == "\"C:\\space path\\\\\"", "trailing slash");
        Check(Quote("") == "\"\"", "empty");
        return 0;
    }
    private static void Report(string error)
    {
        try
        {
            var profile = NormalizePath(Environment.GetEnvironmentVariable("WHATMCP_HOME"));
            if (String.IsNullOrEmpty(profile) || !Directory.Exists(profile)) return;
            File.WriteAllText(Path.Combine(profile, "desktop-bootstrap-error.log"),
                DateTime.UtcNow.ToString("o") + Environment.NewLine +
                Regex.Replace(error, @"sk-[A-Za-z0-9_-]+", "[credential]"));
        }
        catch { }
    }
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            string directory = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            var info = new ProcessStartInfo(Path.Combine(directory, "node.original.exe"));
            var command = new StringBuilder();
            foreach (var arg in args) command.Append(Quote(NormalizePath(arg))).Append(' ');
            info.Arguments = command.ToString();
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            // Inherit stdin/stdout unchanged: they carry the app's private JSON protocol.
            info.RedirectStandardError = true;
            string profile = info.EnvironmentVariables["WHATMCP_HOME"];
            if (profile != null) info.EnvironmentVariables["WHATMCP_HOME"] = NormalizePath(profile);
            using (var child = Process.Start(info))
            {
                string error = child.StandardError.ReadToEnd();
                child.WaitForExit();
                if (child.ExitCode != 0) Report(error);
                return child.ExitCode;
            }
        }
        catch (Exception error) { Report(error.ToString()); return 1; }
    }
}