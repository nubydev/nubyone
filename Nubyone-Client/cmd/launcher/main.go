// Package main is the Nubyone agent stub launcher.
//
// This binary exists for one reason: to be byte-identical across
// every download in your fleet so SmartScreen download reputation
// accumulates rapidly across thousands of installs. The per-customer
// agent EXE has a unique SHA-256 (server URL is baked in via
// -ldflags), so it never accumulates reputation. The launcher does.
//
// At build time exactly ONE value is baked in: BootstrapURL — the
// public HTTPS URL of your Nubyone server. Every operator in your
// company downloads the same launcher, so its hash is constant.
//
// At run time the launcher:
//   1. Downloads the latest agent EXE from
//      <BootstrapURL>/api/agent/latest into %TEMP%. Crucially, the
//      Go stdlib http client does NOT tag downloaded files with the
//      Mark-of-the-Web alternate data stream, so the agent EXE
//      written to disk is invisible to SmartScreen.
//   2. Strips its own MOTW (in case it was downloaded by a browser)
//      and the MOTW of the agent EXE (defence-in-depth).
//   3. Execs the agent. The agent's bootstrap then handles install
//      (machine-wide if elevated, per-user otherwise — see
//      cmd/agent/bootstrap/bootstrap_windows.go).
//
// The launcher itself is intentionally tiny (a few hundred KB) and
// has no per-customer state, so the same compiled binary serves
// every PC in your company.
package main

import (
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// BootstrapURL is the only build-time variable. It is set via
// -ldflags "-X main.BootstrapURL=https://your.server.tld" when the
// launcher is compiled. The default below is a loopback placeholder
// used only by `go run` during local development.
var BootstrapURL = "https://127.0.0.1:5000"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Nubyone launcher failed:", err)
		os.Exit(1)
	}
}

func run() error {
	base := strings.TrimRight(BootstrapURL, "/")
	platform := fmt.Sprintf("%s-%s", runtime.GOOS, runtime.GOARCH)
	fetchURL := base + "/api/agent/latest?platform=" + platform

	// Pick a stable temp path so re-running the launcher reuses the
	// same file (cheap update path).
	exeName := "zc-agent"
	if runtime.GOOS == "windows" {
		exeName += ".exe"
	}
	target := filepath.Join(os.TempDir(), "nubyone-launcher", exeName)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}

	if err := download(fetchURL, target); err != nil {
		return fmt.Errorf("download agent: %w", err)
	}

	// Strip Mark-of-the-Web on both ourselves and the downloaded
	// agent. On non-Windows this is a no-op (NTFS-only feature).
	stripMOTW(target)
	if self, err := os.Executable(); err == nil {
		stripMOTW(self)
	}

	cmd := exec.Command(target)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	configureDetached(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start agent: %w", err)
	}
	// Hand off and exit. The agent's bootstrap takes over from here.
	return cmd.Process.Release()
}

func download(url, target string) error {
	tr := &http.Transport{
		// Allow self-signed certs because operators commonly point
		// the launcher at internal hosts during pilots. In production
		// a proper cert is expected.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: tr}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("server returned %s", resp.Status)
	}

	tmp := target + ".new"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(target)
		if err := os.Rename(tmp, target); err != nil {
			return err
		}
	}
	return nil
}
