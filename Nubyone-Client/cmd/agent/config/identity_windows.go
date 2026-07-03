//go:build windows

package config

// platformMachineID intentionally returns an empty string on Windows.
//
// Reading HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid is the canonical
// "victim fingerprinting" pattern used by commodity RAT families, and AV /
// SmartScreen heuristics flag any unsigned binary that performs this read.
//
// The identity layer falls back to the HWID-only derivation (hostname +
// username + GOOS + GOARCH) when this returns "", which is sufficient for
// the agent's enrollment signature.
func platformMachineID() string {
	return ""
}
