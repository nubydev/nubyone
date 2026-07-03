//go:build windows

package runtime

import (
	"errors"
	"os"
	"os/exec"
)

func tryStartPTY(_ *exec.Cmd, _, _ uint16) (*os.File, error) {
	return nil, errors.New("pty not supported on Windows")
}

func tryResizePTY(_ *os.File, _, _ uint16) error {
	return nil // resize is a no-op; Windows uses pipe mode
}
