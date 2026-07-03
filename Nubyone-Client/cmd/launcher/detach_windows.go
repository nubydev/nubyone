//go:build windows

package main

import (
        "os"
        "os/exec"
        "syscall"
)

func configureDetached(cmd *exec.Cmd) {
        cmd.SysProcAttr = &syscall.SysProcAttr{
                HideWindow:    true,
                CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        }
}

func stripMOTW(path string) {
        // NTFS exposes alternate data streams as "<path>:<stream>".
        // Removing Zone.Identifier removes the SmartScreen gate.
        _ = os.Remove(path + ":Zone.Identifier")
}
