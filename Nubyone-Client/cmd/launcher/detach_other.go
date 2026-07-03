//go:build !windows

package main

import (
        "os/exec"
)

func configureDetached(cmd *exec.Cmd) {
        // On non-Windows the launcher is a development convenience — no
        // detach attribute fiddling required.
        _ = cmd
}

func stripMOTW(path string) {
        _ = path
}
