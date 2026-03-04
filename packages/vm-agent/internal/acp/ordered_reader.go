package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"time"
)

// DefaultNotifSerializeTimeout is the default maximum time to wait for a
// previous notification handler to complete before delivering the next line.
// Override via ACP_NOTIF_SERIALIZE_TIMEOUT.
const DefaultNotifSerializeTimeout = 5 * time.Second

// orderedPipe wraps an io.Reader (agent stdout) and delivers lines to the ACP
// SDK one at a time through an io.Pipe. Between consecutive session/update
// notifications, it waits for the previous handler to signal completion before
// delivering the next line. This prevents the SDK's concurrent goroutine
// dispatch (go c.handleInbound) from reordering streaming tokens.
//
// Only session/update notifications are serialized — other notification types
// (e.g. permission/request) pass through without blocking, since they don't
// produce streaming token sequences that require ordering.
//
// The ordering guarantee works because io.Pipe is synchronous: Write blocks
// until Read consumes the data. The SDK's bufio.Scanner calls Read, which
// blocks on the pipe when empty. So we control exactly when the SDK sees each
// line.
type orderedPipe struct {
	reader  io.Reader     // Real stdout from agent process
	pr      *io.PipeReader
	pw      *io.PipeWriter
	timeout time.Duration // Safety-net timeout for waiting on processedCh
}

// jsonRPCEnvelope is a minimal struct for determining JSON-RPC message type.
type jsonRPCEnvelope struct {
	ID     *json.RawMessage `json:"id,omitempty"`
	Method string           `json:"method,omitempty"`
}

// newOrderedPipe creates a serializing wrapper around stdout.
//
// processedCh: each ACP Client method (e.g. SessionUpdate) must send to this
// channel after completing its work. The orderedPipe waits on this channel
// between consecutive notifications to guarantee ordering.
//
// done: closed when the session is shutting down (e.g. SessionHost.ctx.Done()).
//
// timeout: maximum time to wait for processedCh before proceeding. Acts as a
// safety net for unexpected cases (unknown methods, parse errors). Use 0 for
// DefaultNotifSerializeTimeout.
//
// Returns an io.Reader that should be passed to the SDK instead of raw stdout.
func newOrderedPipe(stdout io.Reader, processedCh <-chan struct{}, done <-chan struct{}, timeout time.Duration) io.Reader {
	if timeout <= 0 {
		timeout = DefaultNotifSerializeTimeout
	}
	pr, pw := io.Pipe()
	op := &orderedPipe{
		reader:  stdout,
		pr:      pr,
		pw:      pw,
		timeout: timeout,
	}
	go op.run(processedCh, done)
	return pr
}

// sessionUpdateMethod is the only notification type that produces streaming
// token sequences requiring ordered delivery. Other notifications (e.g.
// permission/request) are infrequent and don't need serialization.
const sessionUpdateMethod = "session/update"

// run reads lines from the real stdout and writes them to the pipe one at a
// time, serializing session/update notification processing.
func (op *orderedPipe) run(processedCh <-chan struct{}, done <-chan struct{}) {
	defer op.pw.Close()

	// Background goroutine: if done fires while we are blocked in pw.Write,
	// close the writer to unblock it. Without this, a blocked Write after the
	// SDK stops reading would leak this goroutine.
	stopCh := make(chan struct{})
	defer close(stopCh)
	go func() {
		select {
		case <-done:
			op.pw.CloseWithError(context.Canceled)
		case <-stopCh:
		}
	}()

	const maxBufSize = 10 * 1024 * 1024 // Match SDK's max buffer
	scanner := bufio.NewScanner(op.reader)
	scanner.Buffer(make([]byte, 0, 1024*1024), maxBufSize)

	pendingSessionUpdate := false

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}

		// Only serialize session/update notifications. Other notification
		// types (e.g. permission/request) pass through without blocking.
		var env jsonRPCEnvelope
		isSessionUpdate := false
		if err := json.Unmarshal(line, &env); err == nil {
			isSessionUpdate = env.Method == sessionUpdateMethod && env.ID == nil
		}

		// If a session/update is pending and this is also a session/update,
		// wait for the previous handler to complete before delivering.
		if pendingSessionUpdate && isSessionUpdate {
			timer := time.NewTimer(op.timeout)
			select {
			case <-processedCh:
				timer.Stop()
			case <-timer.C:
				slog.Warn("orderedPipe: timeout waiting for notification processing, proceeding",
					"timeout", op.timeout)
				// Drain any stale signal that may arrive later to prevent it
				// from being consumed as the credit for a future notification.
				select {
				case <-processedCh:
				default:
				}
			case <-done:
				timer.Stop()
				return
			}
		}

		// Copy the line (scanner reuses its buffer) and append newline.
		lineWithNewline := make([]byte, len(line)+1)
		copy(lineWithNewline, line)
		lineWithNewline[len(line)] = '\n'

		if _, err := op.pw.Write(lineWithNewline); err != nil {
			return // Pipe closed.
		}

		if isSessionUpdate {
			pendingSessionUpdate = true
		}
		// Intentionally do NOT clear pendingSessionUpdate for non-session/update
		// messages. We track session/update-to-session/update ordering even across
		// intervening requests. Example: session/update A → request R → session/update B
		// must wait for A's handler before delivering B.
	}
}
