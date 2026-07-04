package handoff

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Save writes the handoff packet as indented JSON.
func Save(path string, packet Packet) error {
	if path == "" {
		return fmt.Errorf("handoff: path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("handoff: create directory: %w", err)
	}
	data, err := json.MarshalIndent(packet, "", "  ")
	if err != nil {
		return fmt.Errorf("handoff: marshal packet: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("handoff: write packet: %w", err)
	}
	return nil
}
