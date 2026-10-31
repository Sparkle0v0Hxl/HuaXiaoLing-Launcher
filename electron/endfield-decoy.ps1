param(
  [string]$ParentExe = "",
  [string]$GameExe = "",
  [string]$WorkDir = "",
  [string]$GameArgs = "",
  [string]$TempDir = "",
  [string]$PidFile = "",
  # prebuilt assembly: skips the C# compile (a few hundred ms instead of several seconds)
  [string]$Assembly = "",
  # compile the C# source into an assembly and exit (called once by the launcher)
  [string]$CompileOnly = ""
)

$ErrorActionPreference = "Stop"

$TypeSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

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
'@

function Write-Fail($message) {
  Write-Output ("ERROR:" + $message)
  if ($PidFile) { Set-Content -LiteralPath $PidFile -Value ("ERROR:" + $message) -Encoding ASCII }
  exit 1
}

try {
  # compile-only mode: the launcher calls this once, then loads the assembly
  if ($CompileOnly) {
    Add-Type -TypeDefinition $TypeSource -OutputAssembly $CompileOnly
    if (-not (Test-Path -LiteralPath $CompileOnly)) { exit 3 }
    exit 0
  }

  if (-not $ParentExe) { Write-Fail "missing parent exe" }
  if (-not $GameExe) { Write-Fail "missing game exe" }

  $signature = Get-AuthenticodeSignature -FilePath $ParentExe
  if ($signature.Status -ne "Valid") {
    Write-Fail ("invalid official launcher signature (" + $signature.Status + ") on " + $ParentExe)
  }

  if ($Assembly -and (Test-Path -LiteralPath $Assembly)) {
    Add-Type -Path $Assembly
  } else {
    Add-Type -TypeDefinition $TypeSource
  }

  # hold the file handle between validation and process creation so the image cannot be swapped
  $imageLock = $null
  try {
    $imageLock = [System.IO.File]::Open($ParentExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  } catch {
    $imageLock = $null
  }

  $parent = [VelaEndfield]::StartSuspended($ParentExe)
  try {
    $game = [VelaEndfield]::StartChild($parent, $GameExe, $WorkDir, $GameArgs)
    Write-Output ("PID:" + $game.Id)
    if ($PidFile) { Set-Content -LiteralPath $PidFile -Value ("PID:" + $game.Id) -Encoding ASCII }
    $game.WaitForExit()
  }
  finally {
    [VelaEndfield]::Terminate($parent)
    if ($imageLock) { $imageLock.Dispose() }
    if ($TempDir) { Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
catch {
  $message = $_.Exception.Message.Replace("`r", " ").Replace("`n", " ")
  Write-Output ("ERROR:" + $message)
  if ($PidFile) { Set-Content -LiteralPath $PidFile -Value ("ERROR:" + $message) -Encoding ASCII }
  exit 1
}

exit 0
