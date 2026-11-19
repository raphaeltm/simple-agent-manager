package server

import (
	"errors"
	"strings"
	"time"
)

func validateDeletionVolumeOwnership(value string, id workspaceDeletionIdentity) error {
	fields := strings.Split(value, "|")
	if len(fields) != 7 || fields[3] != id.WorkspaceID || fields[4] != id.NodeID || fields[5] != id.NodeRuntimeIncarnationID || fields[6] != id.UserID {
		return errors.New("workspace volume ownership is unproven; preserving it")
	}
	return nil
}

func validateDeletionAuthority(mode, expires string) error {
	if mode == "explicit" {
		return nil
	}
	if mode != "automatic" {
		return errors.New("deletion authority mode is required")
	}
	expiry, err := time.Parse(time.RFC3339Nano, expires)
	if err != nil || !expiry.After(time.Now()) {
		return errors.New("automatic deletion preservation expired; fresh control-plane authorization required")
	}
	return nil
}
