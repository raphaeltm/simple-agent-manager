package idle

import (
	"testing"
	"time"
)

func TestDetector_StartStopLifecycle(t *testing.T) {
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           30 * time.Minute,
		HeartbeatInterval: 10 * time.Millisecond,
		ControlPlaneURL:   "",
		WorkspaceID:       "",
	})

	done := make(chan struct{})
	go func() {
		d.Start()
		close(done)
	}()

	time.Sleep(30 * time.Millisecond)
	d.Stop()

	select {
	case <-done:
		// expected
	case <-time.After(500 * time.Millisecond):
		t.Fatal("detector did not stop")
	}
}
