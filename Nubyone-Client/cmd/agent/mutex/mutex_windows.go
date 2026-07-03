//go:build windows

package mutex

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// Acquire takes a single-instance lock for the agent on Windows by holding
// an exclusive byte-range lock on a file in %TEMP%.
//
// We deliberately do NOT use a named kernel mutex (CreateMutex with a
// "Local\..." name): named mutexes are the single most common single-instance
// primitive in commodity malware, and AV / SmartScreen vendors ship YARA rules
// that match on suspicious mutex name patterns. Holding a file lock is the
// pattern used by virtually every legitimate desktop application (databases,
// editors, browsers) and carries no malware reputation signal.
func Acquire(name string) (func(), bool, error) {
	if name == "" {
		return func() {}, true, nil
	}

	sanitized, err := sanitizeName(name)
	if err != nil {
		return nil, false, err
	}

	lockPath := filepath.Join(os.TempDir(), fmt.Sprintf("nubyone-%s.lock", sanitized))
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false, fmt.Errorf("open lock file: %w", err)
	}

	handle := windows.Handle(file.Fd())
	overlapped := &windows.Overlapped{}
	err = windows.LockFileEx(
		handle,
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0,
		overlapped,
	)
	if err != nil {
		_ = file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return func() {}, false, nil
		}
		return func() {}, false, nil
	}

	release := func() {
		_ = windows.UnlockFileEx(handle, 0, 1, 0, overlapped)
		_ = file.Close()
	}

	return release, true, nil
}
