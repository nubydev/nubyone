//go:build !windows

package remote

import (
        "context"
        "fmt"
)

// SendFn is the callback used by StartCapture to send frames to the agent.
type SendFn func(msg map[string]interface{}) error

// StartCapture is a no-op on non-Windows platforms; sends a single error frame then blocks.
func StartCapture(ctx context.Context, send SendFn, quality, fps int) {
        _ = send(map[string]interface{}{
                "type":  "remote_frame",
                "error": "Remote desktop is only supported on Windows agents.",
        })
        <-ctx.Done()
}

// HandleInput is a no-op on non-Windows platforms.
func HandleInput(envelope map[string]interface{}) {}

// TakeScreenshot is not supported on non-Windows platforms.
func TakeScreenshot(quality int) ([]byte, int, int, error) {
        return nil, 0, 0, fmt.Errorf("screenshot not supported on this platform")
}
