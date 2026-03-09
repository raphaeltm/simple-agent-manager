package server

import (
	"testing"
)

// TestNilBootLogBroadcasterBroadcast verifies that calling Broadcast on a nil
// *BootLogBroadcaster does not panic. This is the exact crash scenario from
// the production SIGSEGV: a nil *BootLogBroadcaster stored in a non-nil
// Broadcaster interface value.
func TestNilBootLogBroadcasterBroadcast(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster // nil pointer
	// Must not panic
	b.Broadcast("agent_install", "error", "install failed", "ENOTEMPTY")
}

// TestNilBootLogBroadcasterAddClient verifies that AddClient is nil-safe.
func TestNilBootLogBroadcasterAddClient(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster
	// Must not panic (conn is nil too, but we never dereference it)
	b.AddClient(nil)
}

// TestNilBootLogBroadcasterRemoveClient verifies that RemoveClient is nil-safe.
func TestNilBootLogBroadcasterRemoveClient(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster
	b.RemoveClient(nil)
}

// TestNilBootLogBroadcasterMarkComplete verifies that MarkComplete is nil-safe.
func TestNilBootLogBroadcasterMarkComplete(t *testing.T) {
	t.Parallel()
	var b *BootLogBroadcaster
	b.MarkComplete()
}

// TestNilBroadcasterViaInterface verifies the exact production crash path:
// a nil *BootLogBroadcaster stored inside a non-nil interface value.
// In Go, an interface holding a nil concrete pointer is itself non-nil,
// so the method dispatch reaches the receiver — which must handle nil.
func TestNilBroadcasterViaInterface(t *testing.T) {
	t.Parallel()

	var concrete *BootLogBroadcaster // nil
	// Store in a non-nil interface — this is how the Reporter holds it.
	type broadcaster interface {
		Broadcast(step, status, message string, detail ...string)
	}
	var iface broadcaster = concrete // non-nil interface, nil concrete

	// Must not panic
	iface.Broadcast("agent_install", "error", "install failed")
}
