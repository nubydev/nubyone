//go:build !windows

package handlers

import "syscall"

func scriptExecSysProcAttr() *syscall.SysProcAttr {
	return nil
}
