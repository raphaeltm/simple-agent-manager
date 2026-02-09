package pty

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

func TestOutputBuffering_CapturesDuringDisconnect(t *testing.T) {
	// Create a session with a real PTY
	session, err := NewSession(SessionConfig{
		ID:               "sess-buf-test",
		UserID:           "user1",
		Shell:            "/bin/sh",
		Rows:             24,
		Cols:             80,
		OutputBufferSize: 4096,
	})
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer session.Close()

	// Track output received by the attached writer
	var writerBuf bytes.Buffer
	var writerMu sync.Mutex
	writer := &testWriter{buf: &writerBuf, mu: &writerMu}

	// Start the output reader with a writer attached (simulates connected state)
	session.SetAttachedWriter(writer)
	var outputReceived bool
	session.StartOutputReader(
		func(sessionID string, data []byte) {
			outputReceived = true
			// Forward to attached writer (mirrors websocket.go behavior)
			w := session.GetAttachedWriter()
			if w != nil {
				w.Write(data)
			}
		},
		nil,
	)

	// Send input to produce output while connected
	_, err = session.Write([]byte("echo connected-output\n"))
	if err != nil {
		t.Fatalf("write error: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	// Verify output was captured in ring buffer while connected
	bufContent := session.OutputBuffer.ReadAll()
	if len(bufContent) == 0 {
		t.Fatal("expected ring buffer to have content while connected")
	}
	if !bytes.Contains(bufContent, []byte("connected-output")) {
		t.Fatalf("expected ring buffer to contain 'connected-output', got: %s", string(bufContent))
	}

	// Verify attached writer also received the output
	writerMu.Lock()
	writerContent := writerBuf.String()
	writerMu.Unlock()
	if !bytes.Contains([]byte(writerContent), []byte("connected-output")) {
		t.Fatalf("expected writer to contain 'connected-output', got: %s", writerContent)
	}

	// --- Simulate disconnect: clear attached writer ---
	session.SetAttachedWriter(nil)
	writerMu.Lock()
	writerBuf.Reset()
	writerMu.Unlock()

	// Send input while disconnected
	_, err = session.Write([]byte("echo disconnected-output\n"))
	if err != nil {
		t.Fatalf("write error during disconnect: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	// Verify ring buffer captured the disconnected output
	bufContent = session.OutputBuffer.ReadAll()
	if !bytes.Contains(bufContent, []byte("disconnected-output")) {
		t.Fatalf("expected ring buffer to contain 'disconnected-output', got: %s", string(bufContent))
	}

	// Verify writer did NOT receive disconnected output (it was cleared)
	writerMu.Lock()
	writerContent = writerBuf.String()
	writerMu.Unlock()
	if bytes.Contains([]byte(writerContent), []byte("disconnected-output")) {
		t.Fatal("expected writer to NOT receive output during disconnect")
	}

	// --- Simulate reconnect: set a new attached writer ---
	var reconnectBuf bytes.Buffer
	reconnectWriter := &testWriter{buf: &reconnectBuf, mu: &writerMu}
	session.SetAttachedWriter(reconnectWriter)

	// ReadAll returns the buffered content that was captured during disconnect
	scrollback := session.OutputBuffer.ReadAll()
	if !bytes.Contains(scrollback, []byte("disconnected-output")) {
		t.Fatalf("expected scrollback to contain 'disconnected-output', got: %s", string(scrollback))
	}

	_ = outputReceived // suppress unused warning
}

func TestStartOutputReader_SetsProcessExitedOnExit(t *testing.T) {
	session, err := NewSession(SessionConfig{
		ID:               "sess-exit-test",
		UserID:           "user1",
		Shell:            "/bin/sh",
		Rows:             24,
		Cols:             80,
		OutputBufferSize: 1024,
	})
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	exitCh := make(chan string, 1)
	session.StartOutputReader(nil, func(sessionID string) {
		exitCh <- sessionID
	})

	// Tell the shell to exit
	_, _ = session.Write([]byte("exit\n"))

	select {
	case id := <-exitCh:
		if id != "sess-exit-test" {
			t.Fatalf("expected session ID sess-exit-test, got %s", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for process exit callback")
	}

	session.mu.RLock()
	exited := session.ProcessExited
	session.mu.RUnlock()

	if !exited {
		t.Fatal("expected ProcessExited to be true after process exits")
	}
}

// testWriter is a simple io.Writer for testing that captures written data.
type testWriter struct {
	buf *bytes.Buffer
	mu  *sync.Mutex
}

func (w *testWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}
