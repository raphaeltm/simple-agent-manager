package server

import (
	"fmt"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
	"github.com/workspace/vm-agent/internal/oci"
)

type fakeBridgeIPDiscovery struct {
	ip  string
	err error
}

func (f fakeBridgeIPDiscovery) GetBridgeIP() (string, error) {
	return f.ip, f.err
}

func stubPublishBridgeIPs(t *testing.T, ipsByLabel map[string]string) {
	t.Helper()
	previous := newPublishBridgeIPDiscovery
	newPublishBridgeIPDiscovery = func(cfg container.Config) publishBridgeIPDiscovery {
		if ip, ok := ipsByLabel[cfg.LabelValue]; ok {
			return fakeBridgeIPDiscovery{ip: ip}
		}
		return fakeBridgeIPDiscovery{err: fmt.Errorf("unexpected label %q", cfg.LabelValue)}
	}
	t.Cleanup(func() {
		newPublishBridgeIPDiscovery = previous
	})
}

func TestPublishCallbackCredentialsUsesWorkspaceSourceToken(t *testing.T) {
	cfg := &config.Config{
		ProjectID:         "config-project",
		CallbackToken:     "refreshed-node-token",
		ContainerLabelKey: "devcontainer.local_folder",
	}
	s := &Server{
		config:        cfg,
		callbackToken: "refreshed-node-token",
		workspaces: map[string]*WorkspaceRuntime{
			"ws-one": {
				ID:                  "ws-one",
				ProjectID:           "project-one",
				CallbackToken:       "workspace-one-token",
				ContainerLabelValue: "/workspace/ws-one",
			},
			"ws-two": {
				ID:                  "ws-two",
				ProjectID:           "project-two",
				CallbackToken:       "workspace-two-token",
				ContainerLabelValue: "/workspace/ws-two",
			},
		},
	}
	stubPublishBridgeIPs(t, map[string]string{
		"/workspace/ws-one": "172.18.0.2",
		"/workspace/ws-two": "172.18.0.3",
	})

	creds := s.publishCallbackCredentials(&oci.CapturedPublish{SourceIP: "172.18.0.3"})
	if creds.Token != "workspace-two-token" {
		t.Fatalf("Token = %q, want workspace-two token", creds.Token)
	}
	if creds.WorkspaceID != "ws-two" {
		t.Fatalf("WorkspaceID = %q, want ws-two", creds.WorkspaceID)
	}
	if creds.ProjectID != "project-two" {
		t.Fatalf("ProjectID = %q, want project-two", creds.ProjectID)
	}
}

func TestPublishCallbackCredentialsRejectsUnknownSourceInsteadOfNodeToken(t *testing.T) {
	cfg := &config.Config{
		ProjectID:         "config-project",
		CallbackToken:     "node-token",
		ContainerLabelKey: "devcontainer.local_folder",
	}
	s := &Server{
		config:        cfg,
		callbackToken: "refreshed-node-token",
		workspaces: map[string]*WorkspaceRuntime{
			"ws-one": {
				ID:                  "ws-one",
				ProjectID:           "project-one",
				CallbackToken:       "workspace-one-token",
				ContainerLabelValue: "/workspace/ws-one",
			},
		},
	}
	stubPublishBridgeIPs(t, map[string]string{"/workspace/ws-one": "172.18.0.2"})

	creds := s.publishCallbackCredentials(&oci.CapturedPublish{SourceIP: "172.18.0.99"})
	if creds.Token != "" {
		t.Fatalf("Token = %q, want empty token", creds.Token)
	}
	if creds.ProjectID != "config-project" {
		t.Fatalf("ProjectID = %q, want config fallback", creds.ProjectID)
	}
}

func TestPublishCallbackCredentialsFallsBackToBootWorkspaceToken(t *testing.T) {
	cfg := &config.Config{
		ProjectID:     "project-publish",
		WorkspaceID:   "ws-publish",
		CallbackToken: "boot-workspace-token",
	}
	s := &Server{
		config:        cfg,
		callbackToken: "refreshed-node-token",
		workspaces:    map[string]*WorkspaceRuntime{},
	}

	creds := s.publishCallbackCredentials(&oci.CapturedPublish{SourceIP: "172.18.0.9"})
	if creds.Token != "boot-workspace-token" {
		t.Fatalf("Token = %q, want boot workspace token", creds.Token)
	}
	if creds.WorkspaceID != "ws-publish" {
		t.Fatalf("WorkspaceID = %q, want boot workspace", creds.WorkspaceID)
	}
	if creds.ProjectID != "project-publish" {
		t.Fatalf("ProjectID = %q, want project-publish", creds.ProjectID)
	}
}
