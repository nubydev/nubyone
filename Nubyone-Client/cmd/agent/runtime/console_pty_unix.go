//go:build !windows

package runtime

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

func tryStartPTY(cmd *exec.Cmd, cols, rows uint16) (*os.File, error) {
	return pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
}

func tryResizePTY(f *os.File, cols, rows uint16) error {
	return pty.Setsize(f, &pty.Winsize{Cols: cols, Rows: rows})
}
