//go:build !windows

package bootstrap

// Run is a no-op on non-Windows platforms. The agent simply runs in
// foreground mode wherever it is launched. Self-install is a Windows-
// only concept tied to the SmartScreen / Scheduled Task / SYSTEM
// account model.
func Run() (installed bool) { return false }

// PersistInstall, PersistRemove, and Uninstall are no-ops on non-Windows
// platforms. Persistence management is a Windows-only concept.
func PersistInstall() error { return nil }
func PersistRemove() error  { return nil }
func Uninstall() error      { return nil }
