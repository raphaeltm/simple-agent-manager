package idle

import (
	"testing"
	"time"
)

func TestDetector_DoesNotAutonomouslyShutdown(t *testing.T) {
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           50 * time.Millisecond,
		HeartbeatInterval: 10 * time.Millisecond,
		IdleCheckInterval: 10 * time.Millisecond,
	})

	go d.Start()
	defer d.Stop()

	time.Sleep(200 * time.Millisecond)

	select {
	case <-d.ShutdownChannel():
		t.Fatal("shutdown channel should not close for idle timeout")
	default:
	}
}

func TestDetector_RecordActivityUpdatesDeadline(t *testing.T) {
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           1 * time.Minute,
		HeartbeatInterval: 1 * time.Minute,
	})

	before := d.GetDeadline()
	time.Sleep(5 * time.Millisecond)
	d.RecordActivity()
	after := d.GetDeadline()

	if !after.After(before) {
		t.Fatalf("expected deadline to move forward: before=%v after=%v", before, after)
	}
}

func TestDetector_DoneChannelClosesOnStop(t *testing.T) {
	d := NewDetectorWithConfig(DetectorConfig{
		Timeout:           1 * time.Minute,
		HeartbeatInterval: 1 * time.Minute,
	})

	d.Stop()

	select {
	case <-d.Done():
		// expected
	case <-time.After(100 * time.Millisecond):
		t.Fatal("done channel did not close")
	}
}
