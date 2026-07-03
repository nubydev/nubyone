package handlers

import (
        "context"
        "errors"
        "fmt"
        "log"
        "sync"
        "time"

        "core/cmd/agent/bootstrap"
        "core/cmd/agent/remote"
        rt "core/cmd/agent/runtime"
        "core/cmd/agent/wire"
)

// ErrReconnect signals that the agent should reconnect immediately.
var ErrReconnect = errors.New("reconnect requested")

// HandleHelloAck processes the hello_ack message from the server.
//
// Currently a no-op: the server's hello_ack carries no fields the
// agent needs to act on. Kept as an extension point for future
// session-scoped configuration (e.g. heartbeat tuning).
func HandleHelloAck(ctx context.Context, env *rt.Env, envelope map[string]interface{}) error {
        _ = ctx
        _ = env
        _ = envelope
        return nil
}

// Dispatcher routes incoming server commands to the correct handler.
type Dispatcher struct {
        env          *rt.Env
        remoteMu     sync.Mutex
        remoteCancel context.CancelFunc
}

// NewDispatcher creates a new Dispatcher.
func NewDispatcher(env *rt.Env) *Dispatcher {
        return &Dispatcher{env: env}
}

// Dispatch handles a decoded msgpack envelope from the server.
func (d *Dispatcher) Dispatch(ctx context.Context, envelope map[string]interface{}) error {
        msgType, _ := envelope["type"].(string)

        switch msgType {
        case "ping":
                ts, _ := envelope["ts"].(int64)
                return wire.WriteMsg(ctx, d.env.Conn, wire.Ping{Type: "pong", TS: ts})

        case "pong":
                if ts, ok := envelope["ts"].(int64); ok {
                        d.env.SetLastPong(ts)
                } else {
                        d.env.SetLastPong(0)
                }

        case "console_start":
                sessionID, _ := envelope["sessionId"].(string)
                if sessionID == "" {
                        sessionID = "default"
                }
                cols := intFromEnvelope(envelope, "cols")
                rows := intFromEnvelope(envelope, "rows")
                if cols == 0 {
                        cols = 120
                }
                if rows == 0 {
                        rows = 36
                }
                go func() {
                        if err := d.env.Console.Start(ctx, rt.ConsoleStartRequest{
                                SessionID: sessionID,
                                Cols:      cols,
                                Rows:      rows,
                        }); err != nil {
                                log.Printf("[console] start error: %v", err)
                        }
                }()

        case "hello_ack":
                // Server acknowledgement of our hello — no action needed.

        case "console_input":
                sessionID, _ := envelope["sessionId"].(string)
                if sessionID == "" {
                        sessionID = "default"
                }
                var inputData string
                switch v := envelope["data"].(type) {
                case string:
                        inputData = v
                case []byte:
                        inputData = string(v)
                case []interface{}:
                        // msgpack may decode binary blobs as []interface{} containing uint64 values
                        b := make([]byte, len(v))
                        for i, elem := range v {
                                switch n := elem.(type) {
                                case uint64:
                                        b[i] = byte(n)
                                case int64:
                                        b[i] = byte(n)
                                case float64:
                                        b[i] = byte(n)
                                }
                        }
                        inputData = string(b)
                }
                if inputData != "" {
                        if err := d.env.Console.Write(ctx, sessionID, inputData); err != nil {
                                log.Printf("[console] write error: %v", err)
                        }
                }

        case "console_stop":
                sessionID, _ := envelope["sessionId"].(string)
                if sessionID == "" {
                        sessionID = "default"
                }
                d.env.Console.Stop(sessionID)

        case "console_resize":
                sessionID, _ := envelope["sessionId"].(string)
                if sessionID == "" {
                        sessionID = "default"
                }
                cols := intFromEnvelope(envelope, "cols")
                rows := intFromEnvelope(envelope, "rows")
                _ = d.env.Console.Resize(sessionID, cols, rows)

        case "script_exec":
                reqId, _ := envelope["reqId"].(string)
                script, _ := envelope["script"].(string)
                scriptTypeStr, _ := envelope["scriptType"].(string)
                timeoutSecs := intFromEnvelope(envelope, "timeoutSecs")
                if timeoutSecs <= 0 {
                        timeoutSecs = 60
                }
                go func() {
                        output, errStr, exitCode := executeScript(ctx, script, scriptTypeStr, time.Duration(timeoutSecs)*time.Second)
                        resp := map[string]interface{}{
                                "type":     "script_result",
                                "reqId":    reqId,
                                "output":   output,
                                "exitCode": exitCode,
                        }
                        if errStr != "" {
                                resp["error"] = errStr
                        }
                        if err := wire.WriteMsg(ctx, d.env.Conn, resp); err != nil {
                                log.Printf("[script_exec] send result error: %v", err)
                        }
                }()

        case "agent_action":
                action, _ := envelope["action"].(string)
                reqId, _ := envelope["reqId"].(string)
                go func() {
                        var actionErr error
                        switch action {
                        case "persist_install":
                                actionErr = bootstrap.PersistInstall()
                        case "persist_remove":
                                actionErr = bootstrap.PersistRemove()
                        case "uninstall":
                                actionErr = bootstrap.Uninstall()
                        default:
                                actionErr = fmt.Errorf("unknown action: %s", action)
                        }
                        result := "ok"
                        resp := map[string]interface{}{
                                "type":   "agent_action_result",
                                "reqId":  reqId,
                                "action": action,
                                "result": result,
                        }
                        if actionErr != nil {
                                resp["result"] = "error"
                                resp["error"] = actionErr.Error()
                        }
                        if err := wire.WriteMsg(ctx, d.env.Conn, resp); err != nil {
                                log.Printf("[agent_action] send result error: %v", err)
                        }
                        // For uninstall: cancel the agent session so the process exits
                        // and the scheduled self-deletion can proceed.
                        if action == "uninstall" && actionErr == nil {
                                d.env.Cancel()
                        }
                }()

        case "screenshot":
                reqId, _ := envelope["reqId"].(string)
                quality := intFromEnvelope(envelope, "quality")
                if quality <= 0 || quality > 100 {
                        quality = 50
                }
                go func() {
                        imgData, w, h, capErr := remote.TakeScreenshot(quality)
                        resp := map[string]interface{}{
                                "type":  "screenshot_result",
                                "reqId": reqId,
                        }
                        if capErr != nil {
                                resp["ok"] = false
                                resp["error"] = capErr.Error()
                        } else {
                                resp["ok"]     = true
                                resp["data"]   = imgData
                                resp["width"]  = w
                                resp["height"] = h
                        }
                        if werr := wire.WriteMsg(ctx, d.env.Conn, resp); werr != nil {
                                log.Printf("[screenshot] send result error: %v", werr)
                        }
                }()

        case "remote_start":
                quality := intFromEnvelope(envelope, "quality")
                fps := intFromEnvelope(envelope, "fps")
                if quality <= 0 { quality = 35 }
                if fps <= 0 || fps > 30 { fps = 8 }

                d.remoteMu.Lock()
                if d.remoteCancel != nil {
                        d.remoteCancel()
                }
                remoteCtx, cancel := context.WithCancel(ctx)
                d.remoteCancel = cancel
                d.remoteMu.Unlock()

                go remote.StartCapture(remoteCtx, func(msg map[string]interface{}) error {
                        return wire.WriteMsg(remoteCtx, d.env.Conn, msg)
                }, quality, fps)

        case "remote_stop":
                d.remoteMu.Lock()
                if d.remoteCancel != nil {
                        d.remoteCancel()
                        d.remoteCancel = nil
                }
                d.remoteMu.Unlock()

        case "remote_input":
                go remote.HandleInput(envelope)

        case "file_push":
                go handleFilePush(ctx, d.env, envelope)

        case "file_pull":
                go handleFilePull(ctx, d.env, envelope)

        case "proc_list":
                go handleProcList(ctx, d.env, envelope)

        case "proc_kill":
                go handleProcKill(ctx, d.env, envelope)

        case "disconnect":
                d.env.Cancel()
                return ErrReconnect

        default:
                log.Printf("[dispatcher] unknown message type: %q", msgType)
        }
        return nil
}

func intFromEnvelope(envelope map[string]interface{}, key string) int {
        switch v := envelope[key].(type) {
        case int64:
                return int(v)
        case uint64:
                return int(v)
        case float64:
                return int(v)
        }
        return 0
}
