using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

/*
 * VelaEndfield —— 终末地 / 明日方舟「官方签名父进程」伪造核心。
 *
 * 终末地会校验自己的直接父进程：父进程文件必须带鹰角官方 Authenticode 签名。
 * 直接双击游戏本体会被官方拦下（10100）。做法是：以挂起状态创建一个签名有效的
 * 官方进程（Games.exe / PlatformProcess.exe / Arknights.exe…）并永不恢复，再用
 * PROC_THREAD_ATTRIBUTE_PARENT_PROCESS 把它指定为游戏本体进程的父进程。
 *
 * 旧实现靠 PowerShell 跑一段内联 C#（Add-Type），但 PowerShell 是原生进程、读不了
 * Electron 打包进 app.asar 的虚拟路径，导致「下载安装包的新用户」启动必失败。
 * 这里把整套逻辑预编译成 VelaEndfield.exe，启动器直接调，彻底不再依赖 PowerShell。
 */

public static class VelaEndfield
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList, int attributeCount, uint flags, ref UIntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, UIntPtr attribute,
        IntPtr value, UIntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private static readonly UIntPtr PARENT_ATTRIBUTE = (UIntPtr)0x00020000;

    public static IntPtr StartSuspended(string executable)
    {
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        var command = new StringBuilder("\"" + executable + "\"");
        PROCESS_INFORMATION info;
        if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, Path.GetDirectoryName(executable),
                ref startup, out info))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "failed to create parent process");
        CloseHandle(info.hThread);
        return info.hProcess;
    }

    public static Process StartChild(IntPtr parent, string executable, string workingDirectory, string arguments)
    {
        IntPtr list = IntPtr.Zero;
        IntPtr value = IntPtr.Zero;
        bool listReady = false;
        try
        {
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            list = Marshal.AllocHGlobal((int)size);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            listReady = true;
            value = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(value, parent);
            if (!UpdateProcThreadAttribute(list, 0, PARENT_ATTRIBUTE, value, (UIntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = list;
            var command = new StringBuilder("\"" + executable + "\"");
            if (!string.IsNullOrWhiteSpace(arguments)) command.Append(" ").Append(arguments);
            PROCESS_INFORMATION info;
            if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, workingDirectory,
                    ref startup, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "failed to create game process (" + Marshal.GetLastWin32Error() + ")");
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            return Process.GetProcessById(info.dwProcessId);
        }
        finally
        {
            if (listReady) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
        }
    }

    public static void Terminate(IntPtr process)
    {
        if (process == IntPtr.Zero) return;
        TerminateProcess(process, 0);
        CloseHandle(process);
    }
}

public class Program
{
    // 官方鹰角启动器 / 游戏本体都是独立分发的 exe，带「内嵌」Authenticode 签名。这里用
    // X509Certificate.CreateFromSignedFile 读内嵌签名（注意：system32 里的系统文件是 catalog
    // 签名，签名不在文件内嵌，这个方法读不到，属正常现象；游戏启动器不走 catalog）。
    // 目的是确认父进程是「带签名的官方文件」，防止有人在同名文件里塞未签名的冒牌货。
    // 能读到签名即视为有效；真正的父进程签名校验由游戏本体自己完成，这里只是预检闸门。
    private static bool IsAuthenticodeValid(string filePath)
    {
        try
        {
            var cert = System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(filePath);
            return cert != null && !string.IsNullOrEmpty(cert.Subject);
        }
        catch
        {
            return false;
        }
    }

    private static int WriteFail(string pidFile, string message)
    {
        Console.WriteLine("ERROR:" + message);
        if (!string.IsNullOrWhiteSpace(pidFile))
        {
            try { File.WriteAllText(pidFile, "ERROR:" + message, Encoding.ASCII); }
            catch { /* ignore */ }
        }
        return 1;
    }

    private static void WritePid(string pidFile, int pid)
    {
        if (!string.IsNullOrWhiteSpace(pidFile))
        {
            try { File.WriteAllText(pidFile, "PID:" + pid, Encoding.ASCII); }
            catch { /* ignore */ }
        }
    }

    private static int RunDecoy(string parentExe, string gameExe, string workDir, string gameArgs, string tempDir, string pidFile)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(parentExe)) return WriteFail(pidFile, "missing parent exe");
            if (string.IsNullOrWhiteSpace(gameExe)) return WriteFail(pidFile, "missing game exe");
            if (!IsAuthenticodeValid(parentExe))
                return WriteFail(pidFile, "invalid official launcher signature (" + parentExe + ")");

            FileStream imageLock = null;
            try
            {
                imageLock = new FileStream(parentExe, FileMode.Open, FileAccess.Read, FileShare.Read);
            }
            catch
            {
                imageLock = null;
            }

            IntPtr parent = VelaEndfield.StartSuspended(parentExe);
            try
            {
                Process game = VelaEndfield.StartChild(parent, gameExe, workDir, gameArgs);
                WritePid(pidFile, game.Id);
                Console.WriteLine("PID:" + game.Id);
                game.WaitForExit();
            }
            finally
            {
                VelaEndfield.Terminate(parent);
                if (imageLock != null) imageLock.Dispose();
                if (!string.IsNullOrWhiteSpace(tempDir))
                {
                    try { Directory.Delete(tempDir, true); }
                    catch { /* ignore */ }
                }
            }
            return 0;
        }
        catch (Exception ex)
        {
            return WriteFail(pidFile, ex.Message.Replace("\r", " ").Replace("\n", " "));
        }
    }

    static int Main(string[] args)
    {
        string parentExe = null, gameExe = null, workDir = null, gameArgs = null, tempDir = null, pidFile = null;
        bool elevate = false;
        for (int i = 0; i < args.Length; i++)
        {
            string al = args[i].ToLowerInvariant();
            if (al == "-elevate") { elevate = true; continue; }
            if (i + 1 >= args.Length) continue;
            string v = args[i + 1];
            if (al == "-parentexe") parentExe = v;
            else if (al == "-gameexe") gameExe = v;
            else if (al == "-workdir") workDir = v;
            else if (al == "-gameargs") gameArgs = v;
            else if (al == "-tempdir") tempDir = v;
            else if (al == "-pidfile") pidFile = v;
        }

        if (elevate)
        {
            // 自己用 ShellExecute 的 runas 动词提权，不再借 PowerShell 的 Start-Process -Verb RunAs
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = Assembly.GetExecutingAssembly().Location;
                var sb = new StringBuilder();
                foreach (var a in args)
                {
                    if (a.Equals("-Elevate", StringComparison.OrdinalIgnoreCase)) continue;
                    sb.Append(' ');
                    sb.Append('"');
                    sb.Append(a.Replace("\"", "\"\""));
                    sb.Append('"');
                }
                psi.Arguments = sb.ToString().Trim();
                psi.Verb = "runas";
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                using (var p = Process.Start(psi))
                {
                    p.WaitForExit();
                    return p.ExitCode;
                }
            }
            catch (Exception ex)
            {
                return WriteFail(pidFile, "管理员授权失败：" + ex.Message.Replace("\r", " ").Replace("\n", " "));
            }
        }

        return RunDecoy(parentExe, gameExe, workDir, gameArgs, tempDir, pidFile);
    }
}
