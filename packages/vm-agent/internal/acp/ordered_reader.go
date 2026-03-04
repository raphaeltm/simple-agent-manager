package acp

import (
	"bufio"
	"bytes"
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
// SDK one at a time through an io.Pipe. Between consecutive JSON-RPC
// notifications (messages with a "method" field and no "id"), it waits for the
// previous notification's handler to signal completion before delivering the
// next line. This prevents the SDK's concurrent goroutine dispatch
// (go c.handleInbound) from reordering session/update notifications.
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

// run reads lines from the real stdout and writes them to the pipe one at a
// time, serializing notification processing.
func (op *orderedPipe) run(processedCh <-chan struct{}, done <-chan struct{}) {
	defer op.pw.Close()

	const maxBufSize = 10 * 1024 * 1024 // Match SDK's max buffer
	scanner := bufio.NewScanner(op.reader)
	scanner.Buffer(make([]byte, 0, 1024*1024), maxBufSize)

	pendingNotification := false

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}

		// Determine if this line is a notification (method present, no id).
		var env jsonRPCEnvelope
		isNotification := false
		if err := json.Unmarshal(line, &env); err == nil {
			isNotification = env.Method != "" && env.ID == nil
		}

		// If a notification is pending and this is also a notification,
		// wait for the previous notification's handler to complete.
		// This ensures session/update chunks are broadcast in order.
		if pendingNotification && isNotification {
			select {
			case <-processedCh:
				// Previous notification handler completed.
			case <-time.After(op.timeout):
				slog.Warn("orderedPipe: timeout waiting for notification processing, proceeding",
					"timeout", op.timeout)
			case <-done:
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

		if isNotification {
			pendingNotification = true
		}
		// Intentionally do NOT clear pendingNotification for non-notifications.
		// We track notification-to-notification ordering even across
		// intervening requests. Example: notif A → request R → notif B
		// must wait for A's handler before delivering B.
	}
}
