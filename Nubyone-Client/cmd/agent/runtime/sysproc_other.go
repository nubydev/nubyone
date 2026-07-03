//go:build !windows

package runtime

import "syscall"

func platformConsoleSysProcAttr() *syscall.SysProcAttr {
	return nil
}
