package handlers

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func executeScript(ctx context.Context, script, scriptType string, timeout time.Duration) (string, string, int) {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var cmd *exec.Cmd
	switch strings.ToLower(scriptType) {
	case "powershell":
		// -WindowStyle Hidden prevents a console window from appearing on the target machine.
		// CREATE_NO_WINDOW (sysproc) hides the powershell.exe process window itself.
		cmd = exec.CommandContext(execCtx, "powershell",
			"-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script)
	case "cmd":
		// cmd /c with a multi-line string is unreliable — Windows cmd.exe treats the
		// argument as a single command expression, not a batch file.  Write to a
		// temporary .bat file so every line executes and batch directives work correctly.
		tmp, ferr := os.CreateTemp("", "zc-*.bat")
		if ferr == nil {
			_, _ = io.WriteString(tmp, script)
			_ = tmp.Close()
			batPath := tmp.Name()
			defer os.Remove(batPath)
			cmd = exec.CommandContext(execCtx, "cmd", "/c", batPath)
		} else {
			// Fallback: single-line scripts or systems where TMP is unavailable
			cmd = exec.CommandContext(execCtx, "cmd", "/c", script)
		}
	case "bash":
		cmd = exec.CommandContext(execCtx, "bash", "-c", script)
	case "sh":
		cmd = exec.CommandContext(execCtx, "sh", "-c", script)
	case "python", "python3":
		py := "python3"
		if runtime.GOOS == "windows" {
			py = "python"
		}
		cmd = exec.CommandContext(execCtx, py, "-c", script)
	default:
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(execCtx, "powershell",
				"-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script)
		} else {
			cmd = exec.CommandContext(execCtx, "bash", "-c", script)
		}
	}

	// Suppress any console window the child process might create.
	// On Windows this sets CREATE_NO_WINDOW; on other platforms it is a no-op.
	if attr := scriptExecSysProcAttr(); attr != nil {
		cmd.SysProcAttr = attr
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	exitCode := 0
	errStr := ""
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
		if stderrBuf.Len() == 0 {
			errStr = err.Error()
		}
	}

	combined := stdoutBuf.String()
	if stderrBuf.Len() > 0 {
		if combined != "" {
			combined += "\n--- stderr ---\n"
		}
		combined += stderrBuf.String()
	}
	if len(combined) > 200_000 {
		combined = combined[:200_000] + "\n…(truncated)"
	}

	return combined, errStr, exitCode
}
