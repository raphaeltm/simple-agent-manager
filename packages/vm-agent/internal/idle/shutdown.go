package idle

import "fmt"

// ShutdownConfig is retained for compatibility but idle-triggered shutdown requests
// are disabled in node-scoped explicit lifecycle mode.
type ShutdownConfig struct {
	ControlPlaneURL string
	WorkspaceID     string
	CallbackToken   string
}

// RequestShutdown is intentionally disabled.
func RequestShutdown(_ ShutdownConfig) error {
	return fmt.Errorf("idle-triggered shutdown is disabled")
}
