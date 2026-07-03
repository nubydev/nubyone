//go:build windows

package runtime

import "syscall"

// platformConsoleSysProcAttr hides the shell window on Windows.
// We use CREATE_NO_WINDOW (a process creation flag) rather than the
// STARTUPINFO STARTF_USESHOWWINDOW+SW_HIDE pair — the latter is a classic
// malware indicator flagged by AV heuristics, while CREATE_NO_WINDOW is
// routine for any background service or database process.
func platformConsoleSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
