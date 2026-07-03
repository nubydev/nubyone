package runtime

import (
        "context"
        "fmt"
        "io"
        "os"
        "os/exec"
        "runtime"
        "sync"
        "syscall"

        "core/cmd/agent/wire"
)

type ConsoleHub struct {
        env      *Env
        mu       sync.Mutex
        sessions map[string]*ConsoleSession
}

type ConsoleSession struct {
        id     string
        cmd    *exec.Cmd
        pty    *os.File      // non-nil in PTY mode
        stdin  io.WriteCloser // non-nil in pipe mode
        cancel context.CancelFunc
        once   sync.Once
}

type ConsoleStartRequest struct {
        SessionID string
        Cols      int
        Rows      int
}

func NewConsoleHub(env *Env) *ConsoleHub {
        return &ConsoleHub{env: env, sessions: make(map[string]*ConsoleSession)}
}

func (h *ConsoleHub) Start(ctx context.Context, req ConsoleStartRequest) error {
        if req.SessionID == "" {
                return fmt.Errorf("missing session id")
        }

        cols := uint16(req.Cols)
        rows := uint16(req.Rows)
        if cols == 0 {
                cols = 120
        }
        if rows == 0 {
                rows = 36
        }

        h.mu.Lock()
        if existing, ok := h.sessions[req.SessionID]; ok {
                existing.close()
                delete(h.sessions, req.SessionID)
        }
        h.mu.Unlock()

        shell := detectShell()
        sessionCtx, cancel := context.WithCancel(ctx)
        cmd := exec.CommandContext(sessionCtx, shell[0], shell[1:]...)
        cmd.Env = os.Environ()

        if attr := platformConsoleSysProcAttr(); attr != nil {
                cmd.SysProcAttr = attr
        }

        ptmx, err := tryStartPTY(cmd, cols, rows)
        if err == nil {
                sess := &ConsoleSession{id: req.SessionID, cmd: cmd, pty: ptmx, cancel: cancel}
                h.mu.Lock()
                h.sessions[req.SessionID] = sess
                h.mu.Unlock()
                go h.forwardPTY(sessionCtx, sess)
                return nil
        }

        // PTY not available (Windows, headless, etc.) — fall back to pipe-based I/O.
        stdin, err2 := cmd.StdinPipe()
        if err2 != nil {
                cancel()
                h.emitError(ctx, req.SessionID, fmt.Errorf("console unavailable: %v", err))
                return err2
        }
        stdout, err2 := cmd.StdoutPipe()
        if err2 != nil {
                cancel()
                h.emitError(ctx, req.SessionID, fmt.Errorf("console unavailable: %v", err))
                return err2
        }
        stderr, err2 := cmd.StderrPipe()
        if err2 != nil {
                cancel()
                h.emitError(ctx, req.SessionID, fmt.Errorf("console unavailable: %v", err))
                return err2
        }
        if err2 = cmd.Start(); err2 != nil {
                cancel()
                h.emitError(ctx, req.SessionID, fmt.Errorf("console start failed: %v", err2))
                return err2
        }

        sess := &ConsoleSession{id: req.SessionID, cmd: cmd, stdin: stdin, cancel: cancel}
        h.mu.Lock()
        h.sessions[req.SessionID] = sess
        h.mu.Unlock()

        go h.forwardPipe(sessionCtx, sess, stdout)
        go h.forwardPipe(sessionCtx, sess, stderr)
        go h.waitPipeExit(sessionCtx, sess)
        return nil
}

func (h *ConsoleHub) Write(ctx context.Context, sessionID string, data string) error {
        sess := h.get(sessionID)
        if sess == nil {
                return fmt.Errorf("session not found")
        }
        if sess.pty != nil {
                _, err := sess.pty.Write([]byte(data))
                return err
        }
        if sess.stdin != nil {
                _, err := sess.stdin.Write([]byte(data))
                return err
        }
        return fmt.Errorf("no writable handle for session")
}

func (h *ConsoleHub) Resize(sessionID string, cols, rows int) error {
        sess := h.get(sessionID)
        if sess == nil {
                return fmt.Errorf("session not found")
        }
        if sess.pty == nil {
                return nil // resize is a no-op in pipe mode
        }
        if cols <= 0 {
                cols = 120
        }
        if rows <= 0 {
                rows = 36
        }
        return tryResizePTY(sess.pty, uint16(cols), uint16(rows))
}

func (h *ConsoleHub) Stop(sessionID string) {
        h.mu.Lock()
        sess := h.sessions[sessionID]
        delete(h.sessions, sessionID)
        h.mu.Unlock()
        if sess != nil {
                sess.close()
        }
}

func (h *ConsoleHub) StopAll() {
        if h == nil {
                return
        }
        h.mu.Lock()
        ids := make([]string, 0, len(h.sessions))
        for id := range h.sessions {
                ids = append(ids, id)
        }
        h.mu.Unlock()
        for _, id := range ids {
                h.Stop(id)
        }
}

// forwardPTY handles output for PTY-mode sessions.
func (h *ConsoleHub) forwardPTY(ctx context.Context, sess *ConsoleSession) {
        buf := make([]byte, 4096)
        for {
                n, err := sess.pty.Read(buf)
                if n > 0 {
                        chunk := make([]byte, n)
                        copy(chunk, buf[:n])
                        _ = wire.WriteMsg(ctx, h.env.Conn, wire.ConsoleOutput{Type: "console_output", SessionID: sess.id, Data: chunk})
                }
                if err != nil {
                        if err != io.EOF {
                                h.emitError(ctx, sess.id, err)
                        }
                        break
                }
        }

        if sess.cmd != nil {
                _ = sess.cmd.Wait()
        }
        exitCode := extractExitCode(sess.cmd)
        _ = wire.WriteMsg(ctx, h.env.Conn, wire.ConsoleOutput{Type: "console_output", SessionID: sess.id, ExitCode: &exitCode})

        h.mu.Lock()
        delete(h.sessions, sess.id)
        h.mu.Unlock()
        sess.close()
}

// forwardPipe reads from a single reader (stdout or stderr) and forwards output.
func (h *ConsoleHub) forwardPipe(ctx context.Context, sess *ConsoleSession, r io.Reader) {
        buf := make([]byte, 4096)
        for {
                n, err := r.Read(buf)
                if n > 0 {
                        chunk := make([]byte, n)
                        copy(chunk, buf[:n])
                        _ = wire.WriteMsg(ctx, h.env.Conn, wire.ConsoleOutput{Type: "console_output", SessionID: sess.id, Data: chunk})
                }
                if err != nil {
                        return
                }
        }
}

// waitPipeExit waits for the process to exit and sends the exit code.
func (h *ConsoleHub) waitPipeExit(ctx context.Context, sess *ConsoleSession) {
        _ = sess.cmd.Wait()
        exitCode := extractExitCode(sess.cmd)
        _ = wire.WriteMsg(ctx, h.env.Conn, wire.ConsoleOutput{Type: "console_output", SessionID: sess.id, ExitCode: &exitCode})
        h.mu.Lock()
        delete(h.sessions, sess.id)
        h.mu.Unlock()
        sess.close()
}

func (h *ConsoleHub) emitError(ctx context.Context, sessionID string, err error) {
        _ = wire.WriteMsg(ctx, h.env.Conn, wire.ConsoleOutput{Type: "console_output", SessionID: sessionID, Error: err.Error()})
}

func (h *ConsoleHub) get(sessionID string) *ConsoleSession {
        h.mu.Lock()
        defer h.mu.Unlock()
        return h.sessions[sessionID]
}

func (sess *ConsoleSession) close() {
        sess.once.Do(func() {
                if sess.cancel != nil {
                        sess.cancel()
                }
                if sess.stdin != nil {
                        _ = sess.stdin.Close()
                }
                if sess.cmd != nil && sess.cmd.Process != nil {
                        _ = sess.cmd.Process.Kill()
                }
                if sess.pty != nil {
                        _ = sess.pty.Close()
                }
        })
}

func detectShell() []string {
        if runtime.GOOS == "windows" {
                if c := os.Getenv("COMSPEC"); c != "" {
                        return []string{c}
                }
                return []string{"cmd.exe"}
        }
        if sh := os.Getenv("SHELL"); sh != "" {
                return []string{sh, "-l"}
        }
        if runtime.GOOS == "darwin" {
                return []string{"/bin/zsh", "-l"}
        }
        return []string{"/bin/bash", "-l"}
}

func extractExitCode(cmd *exec.Cmd) int {
        if cmd == nil || cmd.ProcessState == nil {
                return -1
        }
        if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
                return status.ExitStatus()
        }
        return -1
}

