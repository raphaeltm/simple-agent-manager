package idle

import "testing"

func TestRequestShutdown_Disabled(t *testing.T) {
	err := RequestShutdown(ShutdownConfig{
		ControlPlaneURL: "https://api.example.com",
		WorkspaceID:     "ws-123",
		CallbackToken:   "token",
	})

	if err == nil {
		t.Fatal("expected idle shutdown request to be disabled")
	}
}
